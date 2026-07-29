import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_PRICING_TTL_MS,
  createModelPricingService,
  normalizeOpenRouterModels,
} from '../dist/services/model-pricing-service.js';

const upstreamPayload = {
  data: [{
    id: 'openai/gpt-test',
    name: 'OpenAI: GPT Test',
    context_length: 128000,
    pricing: {
      prompt: '0.00000125',
      completion: '0.000010',
      input_cache_read: '0.000000125',
      input_cache_write: '0.0000015625',
      overrides: [{ context_length: 200000 }],
    },
  }, {
    id: 'vendor/free-model',
    name: 'Free Model',
    context_length: null,
    pricing: { prompt: '0', completion: '0' },
  }],
};

function response(payload = upstreamPayload) {
  return { ok: true, json: async () => payload };
}

test('normalizes OpenRouter prices per million tokens and sorts by provider then name', () => {
  assert.deepEqual(normalizeOpenRouterModels(upstreamPayload), [
    {
      id: 'openai/gpt-test',
      name: 'OpenAI: GPT Test',
      provider: 'openai',
      contextLength: 128000,
      hasPricingOverrides: true,
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: 1.5625,
    },
    {
      id: 'vendor/free-model',
      name: 'Free Model',
      provider: 'vendor',
      contextLength: null,
      hasPricingOverrides: false,
      inputPerMillion: 0,
      outputPerMillion: 0,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
    },
  ]);
});

test('normalization rejects missing, negative, non-finite, and malformed values', () => {
  const [model] = normalizeOpenRouterModels({
    data: [{
      id: 'test/model',
      name: 'Test',
      context_length: -1,
      pricing: {
        prompt: '-0.000001',
        completion: 'Infinity',
        input_cache_read: 'NaN',
        input_cache_write: 'not-a-number',
      },
    }],
  });

  assert.deepEqual(model, {
    id: 'test/model',
    name: 'Test',
    provider: 'test',
    contextLength: null,
    hasPricingOverrides: false,
    inputPerMillion: null,
    outputPerMillion: null,
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
  });
});

test('reuses a successful snapshot for five minutes', async () => {
  let calls = 0;
  let time = 1_000;
  const service = createModelPricingService({
    fetcher: async () => {
      calls += 1;
      return response();
    },
    now: () => time,
  });

  const first = await service.getModelPricing();
  time += MODEL_PRICING_TTL_MS - 1;
  const second = await service.getModelPricing();

  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.equal(first.stale, false);
});

test('force refresh bypasses the fresh cache', async () => {
  let calls = 0;
  const service = createModelPricingService({
    fetcher: async () => {
      calls += 1;
      return response({
        data: [{
          ...upstreamPayload.data[0],
          name: `Model ${calls}`,
        }],
      });
    },
    now: () => 1_000,
  });

  await service.getModelPricing();
  const refreshed = await service.getModelPricing({ force: true });

  assert.equal(calls, 2);
  assert.equal(refreshed.models[0].name, 'Model 2');
});

test('returns the previous snapshot as stale when a refresh fails', async () => {
  let time = 1_000;
  let fail = false;
  const service = createModelPricingService({
    fetcher: async () => {
      if (fail) throw new Error('OpenRouter is down');
      return response();
    },
    now: () => time,
  });

  const fresh = await service.getModelPricing();
  fail = true;
  time += MODEL_PRICING_TTL_MS;
  const stale = await service.getModelPricing();

  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, fresh.fetchedAt);
  assert.deepEqual(stale.models, fresh.models);
});

test('propagates the initial upstream failure', async () => {
  const service = createModelPricingService({
    fetcher: async () => { throw new Error('OpenRouter is down'); },
  });

  await assert.rejects(service.getModelPricing(), /OpenRouter is down/);
});

test('coalesces concurrent refreshes into one upstream request', async () => {
  let calls = 0;
  let resolveFetch;
  const service = createModelPricingService({
    fetcher: () => {
      calls += 1;
      return new Promise(resolve => { resolveFetch = resolve; });
    },
  });

  const first = service.getModelPricing();
  const second = service.getModelPricing({ force: true });
  resolveFetch(response());

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(secondResult, firstResult);
});
