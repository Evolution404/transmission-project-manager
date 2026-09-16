import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baseUrlFromProductionConfig,
  validateHealthResponse,
  validateAuthStatusResponse,
  validateAnonymousMeResponse,
} from '../scripts/production/public-smoke.mjs';

test('production smoke derives its domain from the tracked production config without duplicating URLs', () => {
  assert.equal(baseUrlFromProductionConfig({ routes: [{ pattern: 'project.example.com', custom_domain: true }] }), 'https://project.example.com');
  assert.throws(() => baseUrlFromProductionConfig({ routes: [] }), /domain/);
});

test('production public smoke accepts healthy schema, initialized auth and anonymous 401', () => {
  assert.doesNotThrow(() => validateHealthResponse(200, {
    ok: true,
    data: {
      service: 'transmission-project-manager',
      schema: { ready: true, currentMigration: '0001_initial_schema.sql', requiredMigration: '0001_initial_schema.sql' },
    },
  }));
  assert.doesNotThrow(() => validateAuthStatusResponse(200, { ok: true, data: { initialized: true } }));
  assert.doesNotThrow(() => validateAnonymousMeResponse(401, { ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录' } }));
});

test('production public smoke rejects partial readiness and exposed protected endpoints', () => {
  assert.throws(() => validateHealthResponse(200, {
    ok: true,
    data: { service: 'transmission-project-manager', schema: { ready: false } },
  }), /schema/);
  assert.throws(() => validateAuthStatusResponse(200, { ok: true, data: { initialized: false } }), /initialized/);
  assert.throws(() => validateAnonymousMeResponse(200, { ok: true, data: {} }), /401/);
});
