import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getData, refreshData, filterSessions, getSessionById,
  getProjectStats, getDailyChart, getHeatmapData, getModelStats,
  isReady, startBackgroundCollect,
} from './services/data-service.js';

const app = new Hono();

app.use('*', cors());

// Return 503 while data is loading
app.use('/api/*', async (c, next) => {
  if (!isReady() && c.req.path !== '/api/status') {
    return c.json({ loading: true, message: 'Collecting data, please wait...' }, 503);
  }
  return next();
});

app.get('/api/status', (c) => {
  return c.json({ ready: isReady() });
});

app.get('/api/summary', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(data.summary);
});

app.get('/api/sessions', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const filtered = filterSessions(data.sessions, {
    source: c.req.query('source'),
    model: c.req.query('model'),
    from: c.req.query('from'),
    to: c.req.query('to'),
    minCost: c.req.query('minCost') ? parseFloat(c.req.query('minCost')!) : undefined,
  });
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const sorted = filtered.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
  return c.json({
    total: filtered.length,
    sessions: sorted.slice(offset, offset + limit),
  });
});

app.get('/api/sessions/:id', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const session = getSessionById(data.sessions, c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  return c.json(session);
});

app.get('/api/projects', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(getProjectStats(data.sessions));
});

app.get('/api/charts/daily', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const days = parseInt(c.req.query('days') || '30');
  return c.json(getDailyChart(data.sessions, days));
});

app.get('/api/charts/heatmap', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(getHeatmapData(data.sessions));
});

app.get('/api/charts/sources', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const sources = { ...data.summary.totals };
  delete sources.grand_total;
  return c.json(sources);
});

app.get('/api/charts/models', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(getModelStats(data.sessions));
});

app.post('/api/collect', (c) => {
  const result = refreshData();
  return c.json({ message: 'Data refreshed', sessions: result.sessions.length });
});

const port = parseInt(process.env.PORT || '3001');

// Start server immediately, collect data in background
startBackgroundCollect();
console.log(`Claude Stats API running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
