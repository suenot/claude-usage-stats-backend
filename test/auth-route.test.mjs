import assert from 'node:assert/strict';
import test from 'node:test';

import { ForbiddenError } from '../dist/auth.js';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../dist/server.js');

function appWithVerifier(authVerifier) {
  return createApp({
    isReady: () => true,
    dataProvider: () => ({ sessions: [], summary: {}, sourceResults: {} }),
    authVerifier,
  });
}

test('protected API rejects a missing bearer token before verification', async () => {
  let calls = 0;
  const app = appWithVerifier(async () => {
    calls++;
    return { subject: 'test-user', services: { 'harness-analyzer': 'admin' } };
  });

  const response = await app.request('/api/charts/cache-expiry');

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Authentication required' });
  assert.equal(calls, 0);
});

test('protected API distinguishes invalid tokens from insufficient access', async () => {
  const invalidApp = appWithVerifier(async () => { throw new Error('invalid token'); });
  const forbiddenApp = appWithVerifier(async () => { throw new ForbiddenError(); });
  const request = { headers: { Authorization: 'Bearer test-token' } };

  const invalid = await invalidApp.request('/api/charts/cache-expiry', request);
  const forbidden = await forbiddenApp.request('/api/charts/cache-expiry', request);

  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'Invalid or expired token' });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: 'Forbidden' });
});

test('protected API accepts a verified admin token', async () => {
  const app = appWithVerifier(async token => {
    assert.equal(token, 'test-token');
    return { subject: 'test-user', services: { 'harness-analyzer': 'admin' } };
  });

  const response = await app.request('/api/charts/cache-expiry', {
    headers: { Authorization: 'Bearer test-token' },
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).incidents, 0);
});

test('status remains available without authentication', async () => {
  const app = appWithVerifier(async () => { throw new Error('must not run'); });
  const response = await app.request('/api/status');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
});
