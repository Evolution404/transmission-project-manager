import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REQUIRED_RELEASE_JOBS = Object.freeze(['check', 'headless-ui', 'audit']);

export function selectSuccessfulCiRun(runs, expectedSha) {
  return [...runs]
    .filter((run) => (
      run?.head_sha === expectedSha
      && run?.head_branch === 'main'
      && run?.event === 'push'
      && run?.status === 'completed'
      && run?.conclusion === 'success'
    ))
    .sort((left, right) => Date.parse(right.created_at ?? 0) - Date.parse(left.created_at ?? 0))[0] ?? null;
}

export function assertRequiredCiJobs(jobs, requiredJobs = REQUIRED_RELEASE_JOBS) {
  for (const name of requiredJobs) {
    const job = jobs.find((candidate) => candidate?.name === name);
    if (!job) throw new Error(`精确 main CI 缺少发布门禁 job: ${name}`);
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      throw new Error(`精确 main CI 的 ${name} 未通过（status=${job.status ?? 'unknown'}, conclusion=${job.conclusion ?? 'unknown'}）`);
    }
  }
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'transmission-project-manager-release-gate',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub Actions API 请求失败：HTTP ${response.status}`);
  return response.json();
}

export async function verifyReleaseCi({ repository, releaseSha, token, apiUrl = 'https://api.github.com' }) {
  if (!/^[^/]+\/[^/]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY 无效');
  if (!/^[0-9a-f]{40}$/.test(releaseSha ?? '')) throw new Error('RELEASE_SHA 必须是 40 位 Git SHA');
  if (!token) throw new Error('GITHUB_TOKEN 缺失，无法验证发布 CI 证据');

  const base = apiUrl.replace(/\/$/, '');
  const runsUrl = new URL(`${base}/repos/${repository}/actions/workflows/ci.yml/runs`);
  runsUrl.searchParams.set('branch', 'main');
  runsUrl.searchParams.set('event', 'push');
  runsUrl.searchParams.set('status', 'success');
  runsUrl.searchParams.set('head_sha', releaseSha);
  runsUrl.searchParams.set('per_page', '20');

  const runPayload = await githubJson(runsUrl, token);
  const run = selectSuccessfulCiRun(runPayload.workflow_runs ?? [], releaseSha);
  if (!run) throw new Error(`未找到精确 main@${releaseSha} 的成功 push CI；禁止复用其他分支、其他 SHA 或手动 CI`);

  const jobsPayload = await githubJson(`${base}/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`, token);
  assertRequiredCiJobs(jobsPayload.jobs ?? []);
  return {
    runId: run.id,
    url: run.html_url ?? run.url ?? '',
    jobs: REQUIRED_RELEASE_JOBS,
  };
}

function writeSummary(evidence, releaseSha) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  appendFileSync(summary, [
    '### Release CI evidence',
    `- Commit: \`${releaseSha}\``,
    `- CI run: ${evidence.url || evidence.runId}`,
    `- Required jobs: ${evidence.jobs.map((name) => `\`${name}\``).join(', ')}`,
    '- Result: PASS',
    '',
  ].join('\n'));
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  try {
    const releaseSha = process.env.RELEASE_SHA;
    const evidence = await verifyReleaseCi({
      repository: process.env.GITHUB_REPOSITORY,
      releaseSha,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    });
    console.log(`[release-gate] exact main CI PASS run=${evidence.runId} sha=${releaseSha}`);
    writeSummary(evidence, releaseSha);
  } catch (cause) {
    console.error(`[release-gate] ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}
