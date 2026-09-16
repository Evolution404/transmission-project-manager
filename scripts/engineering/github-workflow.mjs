import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, {
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
    throw new Error(`${command} ${args.join(' ')} 失败${details ? `：\n${details}` : ''}`);
  }
  return capture ? String(result.stdout ?? '').trim() : '';
}

function git(...args) {
  return run('git', args);
}

function gh(...args) {
  return run('gh', args);
}

export function assertReleaseState({ branch, status, headSha, originSha }) {
  if (branch !== 'main') throw new Error(`生产 workflow 只能从 main 触发；当前分支为 ${branch || '(detached)'}`);
  if (status.trim()) throw new Error('生产 workflow 触发前工作区必须 clean，当前存在未提交修改');
  if (headSha !== originSha) throw new Error(`本地 main 必须与 origin/main 完全一致；HEAD=${headSha} origin/main=${originSha}`);
}

export function selectDispatchedRun(beforeIds, runs, expectedSha) {
  return runs.find((run) => !beforeIds.has(run.databaseId) && run.headSha === expectedSha) ?? null;
}

function listWorkflowRuns(workflow, ref) {
  const raw = gh(
    'run', 'list',
    '--workflow', workflow,
    '--branch', ref,
    '--event', 'workflow_dispatch',
    '--limit', '30',
    '--json', 'databaseId,headSha,status,conclusion,url,createdAt',
  );
  return JSON.parse(raw || '[]');
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export async function dispatchWorkflow({ workflow, ref, requireMainSync = false }) {
  run('gh', ['auth', 'status'], { capture: false });

  let expectedSha;
  if (requireMainSync) {
    run('git', ['fetch', 'origin', 'main'], { capture: false });
    const branch = git('branch', '--show-current');
    const status = git('status', '--porcelain');
    const headSha = git('rev-parse', 'HEAD');
    const originSha = git('rev-parse', 'origin/main');
    assertReleaseState({ branch, status, headSha, originSha });
    expectedSha = headSha;
  } else {
    expectedSha = git('rev-parse', ref === 'current' ? 'HEAD' : ref);
    if (ref === 'current') ref = git('branch', '--show-current');
    if (!ref) throw new Error('detached HEAD 下必须显式指定 --ref');
  }

  const beforeIds = new Set(listWorkflowRuns(workflow, ref).map((run) => run.databaseId));
  console.log(`[workflow] 触发 ${workflow} @ ${ref} (${expectedSha})`);
  run('gh', ['workflow', 'run', workflow, '--ref', ref], { capture: false });

  let dispatched = null;
  for (let attempt = 0; attempt < 30 && !dispatched; attempt += 1) {
    await sleep(1_000);
    dispatched = selectDispatchedRun(beforeIds, listWorkflowRuns(workflow, ref), expectedSha);
  }
  if (!dispatched) throw new Error(`30 秒内未找到刚触发的 ${workflow} run`);

  console.log(`[workflow] ${dispatched.url}`);
  run('gh', ['run', 'watch', String(dispatched.databaseId), '--exit-status'], { capture: false });
  return dispatched;
}

function parseArgs(argv) {
  const [workflow, ...rest] = argv;
  if (!workflow) throw new Error('用法: node scripts/engineering/github-workflow.mjs <workflow.yml> [--ref main|current] [--require-main-sync]');
  let ref = 'current';
  let requireMainSync = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--ref') {
      ref = rest[index + 1];
      index += 1;
    } else if (value === '--require-main-sync') {
      requireMainSync = true;
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }
  if (!ref) throw new Error('--ref 缺少值');
  return { workflow, ref, requireMainSync };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  try {
    await dispatchWorkflow(parseArgs(process.argv.slice(2)));
  } catch (cause) {
    console.error(`[workflow] ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}
