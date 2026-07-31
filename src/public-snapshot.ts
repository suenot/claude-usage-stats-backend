import { buildSummary, type Session } from '@claude-stats/core';
import {
  getCacheExpiryStats,
  getCacheStats,
  getHeatmapData,
  getHistoryChart,
  getHourlyStats,
  getModelUsage,
  getSourceUsage,
  type CacheExpiryStats,
  type CacheStats,
  type HistoryChart,
  type HourlyStat,
  type UsageStat,
} from './services/data-service.js';

export const PUBLIC_SNAPSHOT_VERSION = 1 as const;
const MAX_SNAPSHOT_BYTES = 1_000_000;

export interface PublicSnapshotTotals {
  total_cost: number;
  total_tokens: number;
  total_sessions: number;
  active_days: number;
  active_months: number;
  today_cost: number;
  week_cost: number;
  month_cost: number;
  avg_per_active_day: number;
  avg_per_active_month: number;
  median_per_active_day: number;
  median_per_active_month: number;
}

export interface PublicSnapshotDetails {
  history: HistoryChart;
  by_harness: Record<string, UsageStat>;
  by_model: Record<string, UsageStat>;
  hourly: HourlyStat[];
  heatmap: Array<{ date: string; hour: number; cost: number; sessions: number }>;
  cache: CacheStats;
  cache_expiry: Omit<CacheExpiryStats, 'top_incidents'>;
}

export interface PublicSnapshotV1 {
  schema_version: typeof PUBLIC_SNAPSHOT_VERSION;
  generated_at: string;
  totals: PublicSnapshotTotals;
  details?: PublicSnapshotDetails;
}

export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnapshotError';
  }
}

export function buildPublicSnapshot(
  sessions: Session[],
  level: 'totals' | 'details',
): PublicSnapshotV1 {
  const summary = buildSummary(sessions);
  const totalTokens = sessions.reduce(
    (sum, session) => sum + session.input_tokens + session.output_tokens + session.cache_read + session.cache_write,
    0,
  );
  const snapshot: PublicSnapshotV1 = {
    schema_version: PUBLIC_SNAPSHOT_VERSION,
    generated_at: summary.generated_at,
    totals: {
      total_cost: summary.totals.grand_total || 0,
      total_tokens: totalTokens,
      total_sessions: summary.session_counts.total || 0,
      active_days: summary.active_days,
      active_months: summary.active_months,
      today_cost: summary.today_cost,
      week_cost: summary.week_cost,
      month_cost: summary.month_cost,
      avg_per_active_day: summary.avg_per_active_day,
      avg_per_active_month: summary.avg_per_active_month,
      median_per_active_day: summary.median_per_active_day,
      median_per_active_month: summary.median_per_active_month,
    },
  };
  if (level === 'details') {
    const { top_incidents: _incidents, ...cacheExpiry } = getCacheExpiryStats(sessions);
    snapshot.details = {
      history: getHistoryChart(sessions, { timeframe: '1d', groupBy: 'harness', days: 0 }),
      by_harness: getSourceUsage(sessions),
      by_model: getModelUsage(sessions),
      hourly: getHourlyStats(sessions),
      heatmap: getHeatmapData(sessions),
      cache: getCacheStats(sessions),
      cache_expiry: cacheExpiry,
    };
  }
  return snapshot;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSnapshotError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find(key => !allowedSet.has(key));
  if (unexpected) throw new InvalidSnapshotError(`${name}.${unexpected} is not allowed`);
}

function finiteNumber(value: unknown, name: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      value > Number.MAX_SAFE_INTEGER || (integer && !Number.isInteger(value))) {
    throw new InvalidSnapshotError(`${name} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function signedFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new InvalidSnapshotError(`${name} must be a finite number`);
  }
  return value;
}

function stringValue(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new InvalidSnapshotError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateUsageMap(value: unknown, name: string): void {
  const map = record(value, name);
  if (Object.keys(map).length > 200) throw new InvalidSnapshotError(`${name} has too many entries`);
  for (const [key, raw] of Object.entries(map)) {
    stringValue(key, `${name} key`, 160);
    const usage = record(raw, `${name}.${key}`);
    exactKeys(usage, ['cost', 'sessions', 'tokens'], `${name}.${key}`);
    finiteNumber(usage.cost, `${name}.${key}.cost`);
    finiteNumber(usage.sessions, `${name}.${key}.sessions`, true);
    finiteNumber(usage.tokens, `${name}.${key}.tokens`, true);
  }
}

function validateHistory(value: unknown): void {
  const history = record(value, 'details.history');
  exactKeys(history, ['timeframe', 'groupBy', 'buckets'], 'details.history');
  if (history.timeframe !== '1d' || history.groupBy !== 'harness' || !Array.isArray(history.buckets) || history.buckets.length > 20_000) {
    throw new InvalidSnapshotError('details.history is invalid');
  }
  for (const [index, raw] of history.buckets.entries()) {
    const bucket = record(raw, `details.history.buckets.${index}`);
    exactKeys(bucket, ['timestamp', 'values'], `details.history.buckets.${index}`);
    const timestamp = stringValue(bucket.timestamp, `details.history.buckets.${index}.timestamp`, 32);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) throw new InvalidSnapshotError('history timestamp is invalid');
    const values = record(bucket.values, `details.history.buckets.${index}.values`);
    if (Object.keys(values).length > 200) throw new InvalidSnapshotError('history has too many series');
    for (const [series, rawValue] of Object.entries(values)) {
      stringValue(series, 'history series', 160);
      const item = record(rawValue, 'history value');
      exactKeys(item, ['usd', 'tokens'], 'history value');
      finiteNumber(item.usd, 'history value.usd');
      finiteNumber(item.tokens, 'history value.tokens', true);
    }
  }
}

function validateHourly(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 24) throw new InvalidSnapshotError('details.hourly must contain 24 hours');
  for (const [index, raw] of value.entries()) {
    const item = record(raw, `details.hourly.${index}`);
    exactKeys(item, ['hour', 'cost', 'sessions', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write'], `details.hourly.${index}`);
    if (finiteNumber(item.hour, 'hour', true) !== index) throw new InvalidSnapshotError('details.hourly hours are invalid');
    for (const key of ['cost', 'sessions', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write'] as const) {
      finiteNumber(item[key], `details.hourly.${index}.${key}`, key !== 'cost');
    }
  }
}

function validateHeatmap(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100_000) throw new InvalidSnapshotError('details.heatmap is invalid');
  for (const [index, raw] of value.entries()) {
    const item = record(raw, `details.heatmap.${index}`);
    exactKeys(item, ['date', 'hour', 'cost', 'sessions'], `details.heatmap.${index}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stringValue(item.date, 'heatmap date', 10))) throw new InvalidSnapshotError('heatmap date is invalid');
    const hour = finiteNumber(item.hour, 'heatmap hour', true);
    if (hour > 23) throw new InvalidSnapshotError('heatmap hour is invalid');
    finiteNumber(item.cost, 'heatmap cost');
    finiteNumber(item.sessions, 'heatmap sessions', true);
  }
}

function validateCache(value: unknown): void {
  const cache = record(value, 'details.cache');
  exactKeys(cache, ['actual_cost', 'no_cache_cost', 'saved', 'saved_pct', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'hit_rate', 'by_model'], 'details.cache');
  for (const key of ['actual_cost', 'no_cache_cost', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'hit_rate'] as const) {
    finiteNumber(cache[key], `details.cache.${key}`, ['input_tokens', 'output_tokens', 'cache_read', 'cache_write'].includes(key));
  }
  signedFiniteNumber(cache.saved, 'details.cache.saved');
  signedFiniteNumber(cache.saved_pct, 'details.cache.saved_pct');
  if (!Array.isArray(cache.by_model) || cache.by_model.length > 200) throw new InvalidSnapshotError('details.cache.by_model is invalid');
  for (const raw of cache.by_model) {
    const row = record(raw, 'cache model');
    exactKeys(row, ['model', 'actual', 'saved', 'cache_read', 'hit_rate'], 'cache model');
    stringValue(row.model, 'cache model.model', 160);
    finiteNumber(row.actual, 'cache model.actual');
    signedFiniteNumber(row.saved, 'cache model.saved');
    finiteNumber(row.cache_read, 'cache model.cache_read', true);
    finiteNumber(row.hit_rate, 'cache model.hit_rate');
  }
}

function validateCacheExpiry(value: unknown): void {
  const expiry = record(value, 'details.cache_expiry');
  exactKeys(expiry, ['methodology', 'estimated_lost_cost', 'estimated_expired_tokens', 'incidents', 'total_idle_minutes', 'by_ttl', 'by_model', 'coverage'], 'details.cache_expiry');
  if (expiry.methodology !== 'heuristic-v1') throw new InvalidSnapshotError('cache expiry methodology is invalid');
  finiteNumber(expiry.estimated_lost_cost, 'cache expiry cost');
  finiteNumber(expiry.estimated_expired_tokens, 'cache expiry tokens', true);
  finiteNumber(expiry.incidents, 'cache expiry incidents', true);
  finiteNumber(expiry.total_idle_minutes, 'cache expiry idle');
  const ttl = record(expiry.by_ttl, 'cache expiry by_ttl');
  exactKeys(ttl, ['5m', '1h'], 'cache expiry by_ttl');
  for (const key of ['5m', '1h'] as const) validateExpiryRow(ttl[key], `cache expiry ${key}`);
  if (!Array.isArray(expiry.by_model) || expiry.by_model.length > 200) throw new InvalidSnapshotError('cache expiry by_model is invalid');
  for (const raw of expiry.by_model) {
    const row = record(raw, 'cache expiry model');
    exactKeys(row, ['model', 'cost', 'tokens', 'incidents'], 'cache expiry model');
    stringValue(row.model, 'cache expiry model name', 160);
    validateExpiryRow(row, 'cache expiry model', true);
  }
  const coverage = record(expiry.coverage, 'cache expiry coverage');
  exactKeys(coverage, ['eligible_sessions', 'excluded_sessions', 'analyzed_events', 'sources'], 'cache expiry coverage');
  finiteNumber(coverage.eligible_sessions, 'coverage eligible', true);
  finiteNumber(coverage.excluded_sessions, 'coverage excluded', true);
  finiteNumber(coverage.analyzed_events, 'coverage events', true);
  if (!Array.isArray(coverage.sources) || coverage.sources.length > 50 || coverage.sources.some(source => typeof source !== 'string' || source.length > 160)) {
    throw new InvalidSnapshotError('coverage sources are invalid');
  }
}

function validateExpiryRow(value: unknown, name: string, allowModel = false): void {
  const row = record(value, name);
  exactKeys(row, allowModel ? ['model', 'cost', 'tokens', 'incidents'] : ['cost', 'tokens', 'incidents'], name);
  finiteNumber(row.cost, `${name}.cost`);
  finiteNumber(row.tokens, `${name}.tokens`, true);
  finiteNumber(row.incidents, `${name}.incidents`, true);
}

export function validatePublicSnapshot(value: unknown): PublicSnapshotV1 {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new InvalidSnapshotError('snapshot is not serializable');
  }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new InvalidSnapshotError('snapshot is too large');
  }
  const snapshot = record(value, 'snapshot');
  exactKeys(snapshot, ['schema_version', 'generated_at', 'totals', 'details'], 'snapshot');
  if (snapshot.schema_version !== PUBLIC_SNAPSHOT_VERSION) throw new InvalidSnapshotError('unsupported snapshot version');
  const generatedAt = stringValue(snapshot.generated_at, 'generated_at', 40);
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime) || generatedTime > Date.now() + 5 * 60_000) throw new InvalidSnapshotError('generated_at is invalid');
  const totals = record(snapshot.totals, 'totals');
  const totalKeys = [
    'total_cost', 'total_tokens', 'total_sessions', 'active_days', 'active_months',
    'today_cost', 'week_cost', 'month_cost', 'avg_per_active_day', 'avg_per_active_month',
    'median_per_active_day', 'median_per_active_month',
  ] as const;
  exactKeys(totals, totalKeys, 'totals');
  for (const key of totalKeys) {
    finiteNumber(totals[key], `totals.${key}`, ['total_tokens', 'total_sessions', 'active_days', 'active_months'].includes(key));
  }
  if (snapshot.details !== undefined) {
    const details = record(snapshot.details, 'details');
    exactKeys(details, ['history', 'by_harness', 'by_model', 'hourly', 'heatmap', 'cache', 'cache_expiry'], 'details');
    validateHistory(details.history);
    validateUsageMap(details.by_harness, 'details.by_harness');
    validateUsageMap(details.by_model, 'details.by_model');
    validateHourly(details.hourly);
    validateHeatmap(details.heatmap);
    validateCache(details.cache);
    validateCacheExpiry(details.cache_expiry);
  }
  return structuredClone(value) as PublicSnapshotV1;
}
