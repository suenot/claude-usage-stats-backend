import * as path from 'node:path';
import { collect, getDirectoryFingerprint, type Session, type CollectorResult } from '@claude-stats/core';

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
  if (filters.from) {
    result = result.filter(s => s.date >= filters.from!);
  }
  if (filters.to) {
    result = result.filter(s => s.date <= filters.to!);
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

// days = 0 (or negative/undefined) → full history from the earliest session
// up to today; otherwise a trailing window of `days` days ending today.
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

  const todayStr = new Date().toISOString().split('T')[0];
  let startStr: string;
  if (days > 0) {
    const d = new Date(todayStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (days - 1));
    startStr = d.toISOString().split('T')[0];
  } else {
    startStr = minDate;
  }

  const result: { date: string; sources: Record<string, number> }[] = [];
  const end = new Date(todayStr + 'T00:00:00Z');
  for (const d = new Date(startStr + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    result.push({ date: dateStr, sources: byDate[dateStr] || {} });
  }
  return result;
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
    const model = s.model || 'unknown';
    result[model] = (result[model] || 0) + s.cost;
  }
  for (const key of Object.keys(result)) {
    result[key] = parseFloat(result[key].toFixed(2));
  }
  return result;
}
