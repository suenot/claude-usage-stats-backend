import * as path from 'node:path';
import { collect, getDirectoryFingerprint, getModelFamily, getPricing, type Session, type CollectorResult } from '@claude-stats/core';

let cachedResult: CollectorResult | null = null;
let lastFingerprint = '';
let collecting = false;

const WATCHED_DIRS = [
  path.join(process.env.HOME || '', '.claude/projects'),
  path.join(process.env.HOME || '', '.codex/sessions'),
  path.join(process.env.HOME || '', 'Library/Application Support/Claude/local-agent-mode-sessions'),
];

function computeFingerprint(): string {
  let fp = '';
  for (const dir of WATCHED_DIRS) {
    fp += getDirectoryFingerprint(dir) + '||';
  }
  return fp;
}

function collectSync(): CollectorResult {
  const start = Date.now();
  console.log(cachedResult ? 'Files changed, re-collecting...' : 'Collecting data...');
  const result = collect();
  const fp = computeFingerprint();
  cachedResult = result;
  lastFingerprint = fp;
  console.log(`Loaded ${result.sessions.length} sessions in ${Date.now() - start}ms`);
  return result;
}

export function isReady(): boolean {
  return cachedResult !== null;
}

export function startBackgroundCollect(): void {
  if (collecting) return;
  collecting = true;
  // Run in next tick so server can start immediately
  setImmediate(() => {
    collectSync();
    collecting = false;
  });
}

export function getData(): CollectorResult | null {
  if (!cachedResult) return null;
  // Check fingerprint — only re-stat files, don't re-parse
  const fp = computeFingerprint();
  if (fp !== lastFingerprint) {
    collectSync();
  }
  return cachedResult!;
}

export function refreshData(): CollectorResult {
  lastFingerprint = '';
  return collectSync();
}

export function filterSessions(
  sessions: Session[],
  filters: {
    source?: string;
    model?: string;
    from?: string;
    to?: string;
    minCost?: number;
  },
): Session[] {
  let result = sessions;
  if (filters.source) {
    const sources = filters.source.split(',');
    result = result.filter(s => sources.some(src => s.source.toLowerCase().includes(src.toLowerCase())));
  }
  if (filters.model) {
    const models = filters.model.split(',');
    result = result.filter(s => models.some(m => s.model.toLowerCase().includes(m.toLowerCase())));
  }

  // Date-only bounds retain whole-day semantics. Datetime bounds intersect
  // the real hourly buckets and return a clipped copy, so every downstream
  // aggregator sees only usage from the selected interval. Legacy sessions
  // without hours keep their previous start-time filtering behavior.
  if (filters.from && filters.from.length <= 10) {
    result = result.filter(s => s.date >= filters.from!);
  }
  if (filters.to && filters.to.length <= 10) {
    result = result.filter(s => s.date <= filters.to!);
  }

  const fromTime = filters.from && filters.from.length > 10 ? filters.from.slice(0, 16) : undefined;
  const toTime = filters.to && filters.to.length > 10 ? filters.to.slice(0, 16) : undefined;
  if (fromTime || toTime) {
    result = result.flatMap(session => {
      const hourEntries = Object.entries(session.hours || {});
      if (hourEntries.length === 0) {
        const startedAt = `${session.date}T${session.time}`.slice(0, 16);
        return (!fromTime || startedAt >= fromTime) && (!toTime || startedAt <= toTime)
          ? [session]
          : [];
      }

      const hours = Object.fromEntries(hourEntries.filter(([rawHour]) => {
        const hour = Number(rawHour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
        const hourStart = `${session.date}T${String(hour).padStart(2, '0')}:00`;
        const hourEnd = `${session.date}T${String(hour).padStart(2, '0')}:59`;
        return (!fromTime || hourEnd >= fromTime) && (!toTime || hourStart <= toTime);
      }));
      const selectedHours = Object.values(hours);
      if (selectedHours.length === 0) return [];

      const totals = selectedHours.reduce(
        (sum, usage) => ({
          cost: sum.cost + usage.cost,
          input_tokens: sum.input_tokens + usage.input_tokens,
          output_tokens: sum.output_tokens + usage.output_tokens,
          cache_read: sum.cache_read + usage.cache_read,
          cache_write: sum.cache_write + usage.cache_write,
        }),
        { cost: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 },
      );
      return [{ ...session, ...totals, hours }];
    });
  }

  if (filters.minCost) {
    result = result.filter(s => s.cost >= filters.minCost!);
  }
  return result;
}

export function getSessionById(sessions: Session[], id: string): Session | undefined {
  return sessions.find(s => s.sessionId === id);
}

export function getProjectStats(sessions: Session[]): { cwd: string; cost: number; sessions: number; sources: string[]; models: string[] }[] {
  const map: Record<string, { cost: number; sessions: number; sources: Set<string>; models: Set<string> }> = {};
  for (const s of sessions) {
    const key = s.cwd || '(no project)';
    if (!map[key]) map[key] = { cost: 0, sessions: 0, sources: new Set(), models: new Set() };
    map[key].cost += s.cost;
    map[key].sessions++;
    map[key].sources.add(s.source);
    if (s.model) map[key].models.add(s.model);
  }
  return Object.entries(map)
    .map(([cwd, data]) => ({
      cwd,
      cost: parseFloat(data.cost.toFixed(2)),
      sessions: data.sessions,
      sources: [...data.sources],
      models: [...data.models],
    }))
    .sort((a, b) => b.cost - a.cost);
}

// Session dates are local wall-clock strings produced by the collector. Match
// the runtime's configured timezone here; no fixed UTC offset is assumed.
export function formatLocalDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Every local day string from the window start through today, inclusive.
// days = 0 (or negative) → full history starting at `minDate`; otherwise a
// trailing window of `days` days ending today.
function dayGrid(minDate: string, days: number): string[] {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const cur = new Date(end);
  if (days > 0) {
    cur.setDate(cur.getDate() - (days - 1));
  } else {
    const [y, m, d] = minDate.split('-').map(Number);
    cur.setFullYear(y, m - 1, d);
  }

  const out: string[] = [];
  for (; cur <= end; cur.setDate(cur.getDate() + 1)) out.push(formatLocalDay(cur));
  return out;
}

export type HistoryTimeframe = '1d' | '1h';
export type HistoryGroupBy = 'harness' | 'model';

export interface HistoryValue {
  usd: number;
  tokens: number;
}

export interface HistoryBucket {
  timestamp: string;
  values: Record<string, HistoryValue>;
}

export interface HistoryChart {
  timeframe: HistoryTimeframe;
  groupBy: HistoryGroupBy;
  buckets: HistoryBucket[];
}

export function getHistoryChart(
  sessions: Session[],
  options: { timeframe?: HistoryTimeframe; groupBy?: HistoryGroupBy; days?: number } = {},
): HistoryChart {
  const timeframe = options.timeframe || '1d';
  const groupBy = options.groupBy || 'harness';
  const days = options.days ?? 30;
  if (sessions.length === 0) return { timeframe, groupBy, buckets: [] };

  let minDate = sessions[0].date;
  const valuesByTimestamp: Record<string, Record<string, HistoryValue>> = {};

  const add = (
    timestamp: string,
    series: string,
    usage: Pick<Session, 'cost' | 'input_tokens' | 'output_tokens' | 'cache_read' | 'cache_write'>,
  ) => {
    const values = (valuesByTimestamp[timestamp] ||= {});
    const value = (values[series] ||= { usd: 0, tokens: 0 });
    value.usd += usage.cost;
    value.tokens += usage.input_tokens + usage.output_tokens + usage.cache_read + usage.cache_write;
  };

  for (const session of sessions) {
    if (session.date < minDate) minDate = session.date;
    const series = groupBy === 'model' ? getModelFamily(session.model) : session.source;

    if (timeframe === '1d') {
      add(session.date, series, session);
      continue;
    }

    for (const [rawHour, usage] of Object.entries(session.hours || {})) {
      const hour = Number(rawHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      add(`${session.date}T${String(hour).padStart(2, '0')}:00`, series, usage);
    }
  }

  let timestamps: string[];
  if (timeframe === '1d') {
    timestamps = dayGrid(minDate, days);
  } else {
    const includedDays = new Set(dayGrid(minDate, days));
    timestamps = Object.keys(valuesByTimestamp)
      .filter(timestamp => includedDays.has(timestamp.slice(0, 10)))
      .sort();
  }
  return {
    timeframe,
    groupBy,
    buckets: timestamps.map(timestamp => ({
      timestamp,
      values: valuesByTimestamp[timestamp] || {},
    })),
  };
}

export function getDailyChart(sessions: Session[], days = 30): { date: string; sources: Record<string, number> }[] {
  return getHistoryChart(sessions, { timeframe: '1d', groupBy: 'harness', days }).buckets.map(bucket => ({
    date: bucket.timestamp,
    sources: Object.fromEntries(Object.entries(bucket.values).map(([series, value]) => [series, value.usd])),
  }));
}

// Daily total cost broken down by MODEL FAMILY (Opus / Sonnet / Haiku / Fable
// / GLM 5.2). Same windowing rules as getDailyChart: days=0 → full history.
export function getDailyModelChart(sessions: Session[], days = 30): { date: string; models: Record<string, number>; tokens: Record<string, number> }[] {
  const models = getHistoryChart(sessions, { timeframe: '1d', groupBy: 'model', days }).buckets;
  const harnesses = getHistoryChart(sessions, { timeframe: '1d', groupBy: 'harness', days }).buckets;
  return models.map((bucket, index) => ({
    date: bucket.timestamp,
    models: Object.fromEntries(Object.entries(bucket.values).map(([series, value]) => [series, value.usd])),
    tokens: Object.fromEntries(Object.entries(harnesses[index]?.values || {}).map(([series, value]) => [series, value.tokens])),
  }));
}

// Cost per (day, hour) cell. Uses the same per-message attribution as
// getHourlyStats, so a long session lights up every hour it actually ran in
// instead of only the cell it started in.
export function getHeatmapData(sessions: Session[]): { date: string; hour: number; cost: number; sessions: number }[] {
  const map: Record<string, { cost: number; sessions: number }> = {};
  for (const s of sessions) {
    const hours = s.hours && Object.keys(s.hours).length > 0
      ? s.hours
      : { [parseInt((s.time || '').split(':')[0], 10) || 0]: s };

    for (const [rawHour, usage] of Object.entries(hours)) {
      const hour = Number(rawHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const key = `${s.date}|${hour}`;
      if (!map[key]) map[key] = { cost: 0, sessions: 0 };
      map[key].cost += usage.cost;
      map[key].sessions++;
    }
  }
  return Object.entries(map).map(([key, data]) => {
    const [date, hourStr] = key.split('|');
    return { date, hour: parseInt(hourStr), cost: parseFloat(data.cost.toFixed(4)), sessions: data.sessions };
  });
}

export function getModelStats(sessions: Session[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const s of sessions) {
    // Empty/missing model = GLM 5.2 proxy session (see core pricing).
    const model = s.model || 'GLM 5.2';
    result[model] = (result[model] || 0) + s.cost;
  }
  for (const key of Object.keys(result)) {
    result[key] = parseFloat(result[key].toFixed(2));
  }
  return result;
}

export interface HourlyStat {
  hour: number;
  cost: number;
  // Sessions ACTIVE during this hour. A session spanning 09:00-14:00 counts in
  // all six hours, so this column sums to more than the session total.
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
}

// Cost and tokens by hour-of-day (0-23) across the (already date-filtered)
// input. Always returns all 24 hours so the chart renders a full day.
//
// Attribution comes from Session.hours, which the parsers build from each
// message's own timestamp. Sessions predating that field only know their start
// time, so they fall back to dumping their totals into that one hour — the old,
// wrong behaviour, kept only so a stale cache degrades instead of vanishing.
export function getHourlyStats(sessions: Session[]): HourlyStat[] {
  const buckets: HourlyStat[] = Array.from({ length: 24 }, (_, hour) => ({
    hour, cost: 0, sessions: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
  }));

  for (const s of sessions) {
    const hours = s.hours && Object.keys(s.hours).length > 0
      ? s.hours
      : { [parseInt((s.time || '').split(':')[0], 10)]: s };

    for (const [rawHour, usage] of Object.entries(hours)) {
      const hour = Number(rawHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const b = buckets[hour];
      b.cost += usage.cost;
      b.input_tokens += usage.input_tokens;
      b.output_tokens += usage.output_tokens;
      b.cache_read += usage.cache_read;
      b.cache_write += usage.cache_write;
      b.sessions++;
    }
  }

  for (const b of buckets) b.cost = parseFloat(b.cost.toFixed(2));
  return buckets;
}

export interface CacheModelRow {
  model: string;
  actual: number;
  saved: number;
  cache_read: number;
  hit_rate: number;
}

export interface CacheStats {
  actual_cost: number;
  no_cache_cost: number;
  saved: number;
  saved_pct: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  // Share of PROMPT tokens (input + cache write + cache read) served from cache.
  hit_rate: number;
  by_model: CacheModelRow[];
}

// What prompt caching is worth. The counterfactual: without a cache every
// cache-read and cache-write token would have been sent as a plain input token
// at full input price (output is unaffected either way). Priced per session
// with that session's own model, since the cache discount differs per model.
export function getCacheStats(sessions: Session[]): CacheStats {
  const totals = { actual: 0, noCache: 0, input: 0, output: 0, read: 0, write: 0 };
  const perModel: Record<string, { actual: number; noCache: number; read: number; prompt: number }> = {};

  for (const s of sessions) {
    const p = getPricing(s.model);
    const promptTokens = s.input_tokens + s.cache_write + s.cache_read;
    const noCache = (promptTokens * p.input + s.output_tokens * p.output) / 1_000_000;

    totals.actual += s.cost;
    totals.noCache += noCache;
    totals.input += s.input_tokens;
    totals.output += s.output_tokens;
    totals.read += s.cache_read;
    totals.write += s.cache_write;

    const fam = getModelFamily(s.model);
    const row = (perModel[fam] ||= { actual: 0, noCache: 0, read: 0, prompt: 0 });
    row.actual += s.cost;
    row.noCache += noCache;
    row.read += s.cache_read;
    row.prompt += promptTokens;
  }

  const promptTotal = totals.input + totals.write + totals.read;
  const round = (v: number) => parseFloat(v.toFixed(2));

  return {
    actual_cost: round(totals.actual),
    no_cache_cost: round(totals.noCache),
    saved: round(totals.noCache - totals.actual),
    saved_pct: totals.noCache > 0 ? round((1 - totals.actual / totals.noCache) * 100) : 0,
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_read: totals.read,
    cache_write: totals.write,
    hit_rate: promptTotal > 0 ? round((totals.read / promptTotal) * 100) : 0,
    by_model: Object.entries(perModel)
      .map(([model, r]) => ({
        model,
        actual: round(r.actual),
        saved: round(r.noCache - r.actual),
        cache_read: r.read,
        hit_rate: r.prompt > 0 ? round((r.read / r.prompt) * 100) : 0,
      }))
      .sort((a, b) => b.saved - a.saved),
  };
}

export function getSourceStats(sessions: Session[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const s of sessions) {
    result[s.source] = (result[s.source] || 0) + s.cost;
  }
  for (const key of Object.keys(result)) {
    result[key] = parseFloat(result[key].toFixed(2));
  }
  return result;
}

export function getSourceUsage(sessions: Session[]): Record<string, { cost: number; sessions: number; tokens: number }> {
  const result: Record<string, { cost: number; sessions: number; tokens: number }> = {};
  for (const s of sessions) {
    const source = result[s.source] ||= { cost: 0, sessions: 0, tokens: 0 };
    source.cost += s.cost;
    source.sessions++;
    source.tokens += s.input_tokens + s.output_tokens + s.cache_read + s.cache_write;
  }
  for (const source of Object.values(result)) source.cost = parseFloat(source.cost.toFixed(2));
  return result;
}
