import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function baseUrlFromProductionConfig(config) {
  const route = Array.isArray(config?.routes)
    ? config.routes.find((candidate) => candidate?.custom_domain === true && typeof candidate?.pattern === 'string' && candidate.pattern.trim())
    : null;
  if (!route) throw new Error('production config domain 无效或缺失');
  return `https://${route.pattern.trim()}`;
}

function assertStatus(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} HTTP 状态异常：期望 ${expected}，实际 ${actual}`);
}

export function validateHealthResponse(status, body) {
  assertStatus(status, 200, 'health');
  if (body?.ok !== true || body?.data?.service !== 'transmission-project-manager') {
    throw new Error('health service 响应无效');
  }
  const schema = body?.data?.schema;
  if (schema?.ready !== true) throw new Error('health schema 未 ready');
  if (!schema.currentMigration || schema.currentMigration !== schema.requiredMigration) {
    throw new Error('health schema migration 不一致');
  }
}

export function validateAuthStatusResponse(status, body) {
  assertStatus(status, 200, 'auth/status');
  if (body?.ok !== true || body?.data?.initialized !== true) {
    throw new Error('auth/status initialized 未就绪');
  }
}

export function validateAnonymousMeResponse(status, body) {
  assertStatus(status, 401, 'anonymous /api/me');
  if (body?.ok !== false || body?.error?.code !== 'UNAUTHENTICATED') {
    throw new Error('anonymous /api/me 未保持 UNAUTHENTICATED 保护');
  }
}

async function requestJson(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: 'error',
    headers: { Accept: 'application/json', 'User-Agent': 'transmission-project-manager-production-smoke' },
    signal: AbortSignal.timeout(12_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} 未返回 JSON`);
  }
  return { status: response.status, body };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runPublicSmoke(baseUrl, { attempts = 12, delayMs = 2_000 } = {}) {
  const normalizedBase = new URL(baseUrl);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const health = await requestJson(normalizedBase, '/api/health');
      validateHealthResponse(health.status, health.body);
      const authStatus = await requestJson(normalizedBase, '/api/auth/status');
      validateAuthStatusResponse(authStatus.status, authStatus.body);
      const anonymousMe = await requestJson(normalizedBase, '/api/me');
      validateAnonymousMeResponse(anonymousMe.status, anonymousMe.body);
      return {
        service: health.body.data.service,
        migration: health.body.data.schema.currentMigration,
        authInitialized: true,
        anonymousProtected: true,
      };
    } catch (cause) {
      lastError = cause;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`生产公网 smoke 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  try {
    const [first, second] = process.argv.slice(2);
    let baseUrl;
    if (first === '--config') {
      if (!second) throw new Error('--config 缺少 production config 路径');
      baseUrl = baseUrlFromProductionConfig(JSON.parse(await readFile(second, 'utf8')));
    } else {
      baseUrl = first;
    }
    if (!baseUrl) throw new Error('用法: node scripts/production/public-smoke.mjs <https://domain> | --config <wrangler.production.jsonc>');
    const result = await runPublicSmoke(baseUrl);
    console.log(`[production-smoke] PASS migration=${result.migration} auth=initialized anonymous-me=401`);
  } catch (cause) {
    console.error(`[production-smoke] ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}
