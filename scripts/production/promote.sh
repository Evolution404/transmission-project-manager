#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="$ROOT/apps/api/wrangler.production.jsonc"
BASELINE="$ROOT/apps/api/migrations/0001_initial_schema.sql"
TRANSFORM="$ROOT/scripts/production/data-transform.mjs"
WORK_DIR="${RUNNER_TEMP:-/tmp}/tpm-production-promote"
SOURCE_PROBE="$WORK_DIR/source-probe.sql"
SOURCE_FINAL="$WORK_DIR/source-final.sql"
SUMMARY_PROBE="$WORK_DIR/summary-probe.json"
SUMMARY_FINAL="$WORK_DIR/summary-final.json"
RESET_SQL="$WORK_DIR/reset.sql"
ROLLBACK_RESET="$WORK_DIR/rollback-reset.sql"
DATA_SQL="$WORK_DIR/data.sql"
VERIFY_SQL="$WORK_DIR/verify.sql"
VERIFY_RESULT="$WORK_DIR/verify-result.json"
HEALTH_FILE="$WORK_DIR/health.json"

: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${WORKER_SECRETS_FILE:?WORKER_SECRETS_FILE is required}"
mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"

wrangler_api() {
  (cd "$ROOT/apps/api" && npm exec -- wrangler "$@")
}

export_database() {
  local output="$1"
  rm -f "$output"
  wrangler_api d1 export DB --remote --config "$CONFIG" --output "$output" -y >/dev/null
  test -s "$output"
  chmod 600 "$output"
}

run_plan() {
  local source="$1" summary="$2"
  local args=(
    "$ROOT/scripts/production/data-transfer-cli.mjs"
    --source "$source"
    --target "$BASELINE"
    --summary "$summary"
    --data "$DATA_SQL"
    --reset "$RESET_SQL"
    --rollback-reset "$ROLLBACK_RESET"
    --verify "$VERIFY_SQL"
  )
  if [[ -f "$TRANSFORM" ]]; then args+=(--transform "$TRANSFORM"); fi
  set +e
  node "${args[@]}"
  local code=$?
  set -e
  if [[ "$code" -eq 42 ]]; then
    {
      echo '### Production data transfer: DECISION_REQUIRED'
      echo
      node --input-type=module - "$summary" <<'NODE'
import {readFileSync} from 'node:fs';
const summary=JSON.parse(readFileSync(process.argv[2],'utf8'));
console.log(`- Source schema fingerprint: \`${summary.sourceFingerprint}\``);
for (const item of summary.decisionRequired ?? []) console.log(`- ${item.table}: ${item.reason}${item.rows === null ? '' : ` (rows=${item.rows})`}`);
NODE
      echo '- Production was not modified. Add/review an explicit one-time data transform or ask the user to decide how to handle the listed data.'
    } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  fi
  return "$code"
}

json_field() {
  local file="$1" expression="$2"
  node --input-type=module - "$file" "$expression" <<'NODE'
import {readFileSync} from 'node:fs';
const value=JSON.parse(readFileSync(process.argv[2],'utf8'));
const path=process.argv[3].split('.');
let current=value;
for (const key of path) current=current?.[key];
process.stdout.write(String(current ?? ''));
NODE
}

wait_health() {
  local mode="$1"
  local domain
  domain="$(node --input-type=module - "$CONFIG" <<'NODE'
import {readFileSync} from 'node:fs';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
process.stdout.write(c.routes[0].pattern);
NODE
)"
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error --connect-timeout 10 --max-time 20 "https://${domain}/api/health" -o "$HEALTH_FILE"; then
      if HEALTH_FILE="$HEALTH_FILE" MODE="$mode" node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
const body=JSON.parse(readFileSync(process.env.HEALTH_FILE,'utf8'));
if (body?.ok !== true || body?.data?.service !== 'transmission-project-manager') process.exit(1);
if (process.env.MODE === 'maintenance') {
  if (body?.data?.maintenance?.active !== true || body?.data?.maintenance?.reason !== 'data-migration') process.exit(1);
} else if (body?.data?.schema?.ready !== true) process.exit(1);
NODE
      then return 0; fi
    fi
    sleep 2
  done
  return 1
}

deploy_normal() {
  wrangler_api deploy --config "$CONFIG" --secrets-file "$WORKER_SECRETS_FILE"
  wait_health normal
}

git fetch origin main >/dev/null
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test "$(git rev-parse origin/main)" = "$RELEASE_SHA"

# Phase 1 is read-only. Any ambiguous historical data stops here before maintenance or D1 mutation.
export_database "$SOURCE_PROBE"
run_plan "$SOURCE_PROBE" "$SUMMARY_PROBE"
REBUILD_REQUIRED="$(json_field "$SUMMARY_PROBE" rebuildRequired)"
if [[ "$REBUILD_REQUIRED" != 'true' ]]; then
  deploy_normal
  printf '### Production promote\n- Commit: `%s`\n- Data rebuild: not required\n- Health: PASS\n' "$RELEASE_SHA" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi

OLD_VERSION_ID="$(wrangler_api deployments status --config "$CONFIG" --json | node --input-type=module -e 'let input=""; for await (const chunk of process.stdin) input+=chunk; const status=JSON.parse(input); const active=(status.versions ?? []).find((item)=>Number(item.percentage)===100); if (!active?.version_id) process.exit(1); process.stdout.write(active.version_id);')"
DB_MUTATED=0

rollback_release() {
  local code=$?
  trap - ERR
  set +e
  if [[ "$DB_MUTATED" == '1' && -s "$SOURCE_FINAL" && -s "$ROLLBACK_RESET" ]]; then
    wrangler_api d1 execute DB --remote --config "$CONFIG" --file "$ROLLBACK_RESET" -y >/dev/null
    wrangler_api d1 execute DB --remote --config "$CONFIG" --file "$SOURCE_FINAL" -y >/dev/null
  fi
  if [[ -n "${OLD_VERSION_ID:-}" ]]; then
    wrangler_api rollback "$OLD_VERSION_ID" --config "$CONFIG" -y >/dev/null
  fi
  set -e
  {
    echo '### Production promote rollback'
    echo "- Commit: \`$RELEASE_SHA\`"
    echo '- Result: FAILED; previous Worker version restored.'
    if [[ "$DB_MUTATED" == '1' ]]; then echo '- Production D1: pre-maintenance export restoration attempted.'; else echo '- Production D1: not modified.'; fi
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit "$code"
}
trap rollback_release ERR

# Freeze application writes before taking the authoritative migration snapshot.
wrangler_api deploy --config "$CONFIG" --secrets-file "$WORKER_SECRETS_FILE" --var MAINTENANCE_MODE:data-migration
wait_health maintenance
export_database "$SOURCE_FINAL"
run_plan "$SOURCE_FINAL" "$SUMMARY_FINAL"

# The approved revision must still be main immediately before destructive D1 replacement.
git fetch origin main >/dev/null
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test "$(git rev-parse origin/main)" = "$RELEASE_SHA"

DB_MUTATED=1
wrangler_api d1 execute DB --remote --config "$CONFIG" --file "$RESET_SQL" -y >/dev/null
wrangler_api d1 migrations apply DB --remote --config "$CONFIG" >/dev/null
wrangler_api d1 execute DB --remote --config "$CONFIG" --file "$DATA_SQL" -y >/dev/null
wrangler_api d1 execute DB --remote --config "$CONFIG" --file "$VERIFY_SQL" --json > "$VERIFY_RESULT"
node "$ROOT/scripts/production/verify-remote-transfer.mjs" "$SUMMARY_FINAL" "$VERIFY_RESULT"

deploy_normal
DB_MUTATED=0
trap - ERR
printf '### Production promote\n- Commit: `%s`\n- Historical data: preserved/transformed into current `0001_initial_schema.sql` model\n- Production D1: rebuilt in place\n- Health: PASS\n' "$RELEASE_SHA" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
