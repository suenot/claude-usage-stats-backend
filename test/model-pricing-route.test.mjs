import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';

const { createApp } = await import('../dist/server.js');

const pricingResponse = {
  source: 'OpenRouter',
  fetchedAt: '2026-07-30T00:00:00.000Z',
  stale: false,
  models: [],
};

test('pricing route bypasses readiness and forwards refresh=1 as force=true', async () => {
  let receivedOptions;
  const app = createApp({
    isReady: () => false,
    modelPricingService: {
      getModelPricing: async options => {
        receivedOptions = options;
        return pricingResponse;
      },
    },
  });

  const response = await app.request('/api/models/pricing?refresh=1');

  assert.equal(response.status, 200);
  assert.deepEqual(receivedOptions, { force: true });
  assert.deepEqual(await response.json(), pricingResponse);
});

test('pricing route returns 502 when the first upstream request fails', async () => {
  const app = createApp({
    isReady: () => false,
    modelPricingService: {
      getModelPricing: async () => { throw new Error('OpenRouter is unavailable'); },
    },
  });

  const response = await app.request('/api/models/pricing');

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'OpenRouter pricing is unavailable' });
});
