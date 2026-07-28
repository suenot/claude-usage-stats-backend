import * as path from 'node:path';
import { collect, getDirectoryFingerprint, getModelFamily, type Session, type CollectorResult } from '@claude-stats/core';

let cachedResult: CollectorResult | null = null;
let lastFingerprint = '';
let collecting = false;

const WATCHED_DIRS = [
  path.join(process.env.HOME || '', '.claude/projects'),
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
  // from/to may be a date ("YYYY-MM-DD") or a datetime ("YYYY-MM-DDTHH:MM").
  // With a datetime bound we compare against the session's START moment
  // (date + first-event time); with a date bound we keep whole-day semantics.
  // Both s.date/s.time and the incoming bounds are in local time (UTC+3 here).
  if (filters.from) {
    const from = filters.from;
    result = from.length > 10
      ? result.filter(s => `${s.date}T${s.time}` >= from.slice(0, 16))
      : result.filter(s => s.date >= from);
  }
  if (filters.to) {
    const to = filters.to;
    result = to.length > 10
      ? result.filter(s => `${s.date}T${s.time}` <= to.slice(0, 16))
      : result.filter(s => s.date <= to);
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

// Session dates (s.date) are LOCAL-time day strings, so the day grid we build
// around them must be local too. Date#toISOString() renders in UTC, which in
// any non-UTC zone names a different calendar day than the Date was built
// from — that mismatch is what used to drop today's row from the charts.
function localDay(d: Date): string {
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
  for (; cur <= end; cur.setDate(cur.getDate() + 1)) out.push(localDay(cur));
  return out;
}

export function getDailyChart(sessions: Session[], days = 30): { date: string; sources: Record<string, number> }[] {
  if (sessions.length === 0) return [];

  // Aggregate cost per source per day once.
  const byDate: Record<string, Record<string, number>> = {};
  let minDate = sessions[0].date;
  for (const s of sessions) {
    if (s.date < minDate) minDate = s.date;
    const day = (byDate[s.date] ||= {});
    day[s.source] = (day[s.source] || 0) + s.cost;
  }

  return dayGrid(minDate, days).map(date => ({ date, sources: byDate[date] || {} }));
}

// Daily total cost broken down by MODEL FAMILY (Opus / Sonnet / Haiku / Fable
// / GLM 5.2). Same windowing rules as getDailyChart: days=0 → full history.
export function getDailyModelChart(sessions: Session[], days = 30): { date: string; models: Record<string, number> }[] {
  if (sessions.length === 0) return [];

  const byDate: Record<string, Record<string, number>> = {};
  let minDate = sessions[0].date;
  for (const s of sessions) {
    if (s.date < minDate) minDate = s.date;
    const fam = getModelFamily(s.model);
    const day = (byDate[s.date] ||= {});
    day[fam] = (day[fam] || 0) + s.cost;
  }

  return dayGrid(minDate, days).map(date => ({ date, models: byDate[date] || {} }));
}

export function getHeatmapData(sessions: Session[]): { date: string; hour: number; cost: number; sessions: number }[] {
  const map: Record<string, { cost: number; sessions: number }> = {};
  for (const s of sessions) {
    const hour = parseInt(s.time.split(':')[0]) || 0;
    const key = `${s.date}|${hour}`;
    if (!map[key]) map[key] = { cost: 0, sessions: 0 };
    map[key].cost += s.cost;
    map[key].sessions++;
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

// Aggregates all sessions by hour-of-day (0-23) across the (already date-
// filtered) input. Returns every hour so the chart always renders 24 bars.
export function getHourlyStats(sessions: Session[]): { hour: number; cost: number; sessions: number }[] {
  const buckets: Record<number, { cost: number; sessions: number }> = {};
  for (let h = 0; h < 24; h++) buckets[h] = { cost: 0, sessions: 0 };
  for (const s of sessions) {
    const hour = parseInt((s.time || '').split(':')[0], 10);
    if (Number.isNaN(hour) || hour < 0 || hour > 23) continue;
    buckets[hour].cost += s.cost;
    buckets[hour].sessions++;
  }
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    cost: parseFloat(buckets[hour].cost.toFixed(2)),
    sessions: buckets[hour].sessions,
  }));
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
