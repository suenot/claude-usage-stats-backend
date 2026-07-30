import assert from 'node:assert/strict';
import test from 'node:test';

import { getProjectStats } from '../dist/services/data-service.js';

test('project stats aggregate all token buckets by cwd and preserve cost sorting', () => {
  const stats = getProjectStats([
    {
      cwd: '/work/alpha',
      cost: 3,
      source: 'Claude Code',
      model: 'claude-sonnet',
      input_tokens: 10,
      output_tokens: 20,
      cache_read: 30,
      cache_write: 40,
    },
    {
      cwd: '/work/alpha',
      cost: 2,
      source: 'Codex',
      model: 'gpt-5',
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 3,
      cache_write: 4,
    },
    {
      cost: 8,
      source: 'Claude Desktop',
      model: 'claude-opus',
      input_tokens: 5,
      output_tokens: 6,
      cache_read: 7,
      cache_write: 8,
    },
  ]);

  assert.deepEqual(stats, [
    {
      cwd: '(no project)',
      cost: 8,
      tokens: 26,
      sessions: 1,
      sources: ['Claude Desktop'],
      models: ['claude-opus'],
    },
    {
      cwd: '/work/alpha',
      cost: 5,
      tokens: 110,
      sessions: 2,
      sources: ['Claude Code', 'Codex'],
      models: ['claude-sonnet', 'gpt-5'],
    },
  ]);
});
