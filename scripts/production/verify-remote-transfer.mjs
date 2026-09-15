import { readFile } from 'node:fs/promises';

const [summaryPath, resultPath] = process.argv.slice(2);
if (!summaryPath || !resultPath) throw new Error('Usage: verify-remote-transfer.mjs <summary.json> <wrangler-result.json>');
const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
const result = JSON.parse(await readFile(resultPath, 'utf8'));
if (!Array.isArray(result)) throw new Error('REMOTE_VERIFY_INVALID_RESULT');

const counts = new Map();
let foreignKeyRows = null;
let integrity = null;
for (const item of result) {
  if (!item?.success || !Array.isArray(item.results)) throw new Error('REMOTE_VERIFY_QUERY_FAILED');
  if (item.results.length === 1 && typeof item.results[0]?.table_name === 'string') {
    counts.set(item.results[0].table_name, Number(item.results[0].row_count));
    continue;
  }
  if (item.results.length === 1 && Object.hasOwn(item.results[0], 'integrity_check')) {
    integrity = String(item.results[0].integrity_check);
    continue;
  }
  if (item.results.length === 0 && foreignKeyRows === null) foreignKeyRows = [];
  else if (item.results.some((row) => Object.hasOwn(row, 'table') && Object.hasOwn(row, 'parent'))) foreignKeyRows = item.results;
}

for (const [table, expected] of Object.entries(summary.targetRows ?? {})) {
  if (counts.get(table) !== Number(expected)) throw new Error(`REMOTE_ROW_COUNT_MISMATCH:${table}:${counts.get(table)}:${expected}`);
}
if (foreignKeyRows === null || foreignKeyRows.length !== 0) throw new Error('REMOTE_FOREIGN_KEY_CHECK_FAILED');
if (integrity?.toLowerCase() !== 'ok') throw new Error('REMOTE_INTEGRITY_CHECK_FAILED');
console.log(JSON.stringify({ ok: true, tables: counts.size }));
