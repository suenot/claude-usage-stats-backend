import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getData, refreshData, filterSessions, getSessionById,
  getProjectStats, getDailyChart, getDailyModelChart, getHistoryChart, getHeatmapData, getModelStats, getSourceStats, getSourceUsage,
  getHourlyStats, getCacheStats,
  isReady, startBackgroundCollect,
} from './services/data-service.js';
import { modelPricingService } from './services/model-pricing-service.js';

type PricingService = Pick<typeof modelPricingService, 'getModelPricing'>;

export function createApp(options: {
  isReady?: typeof isReady;
  modelPricingService?: PricingService;
} = {}) {
  const ready = options.isReady ?? isReady;
  const pricing = options.modelPricingService ?? modelPricingService;
  const app = new Hono();

  app.use('*', cors());

  // Return 503 while data is loading
  app.use('/api/*', async (c, next) => {
    if (!ready() && c.req.path !== '/api/status' && c.req.path !== '/api/models/pricing') {
      return c.json({ loading: true, message: 'Collecting data, please wait...' }, 503);
    }
    return next();
  });

  app.get('/api/status', (c) => {
    return c.json({ ready: ready() });
  });

  app.get('/api/models/pricing', async (c) => {
    try {
      const modelPrices = await pricing.getModelPricing({
        force: c.req.query('refresh') === '1',
      });
      return c.json(modelPrices);
    } catch {
      return c.json({ error: 'OpenRouter pricing is unavailable' }, 502);
    }
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

app.get('/api/charts/daily-models', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const days = parseInt(c.req.query('days') || '30');
  return c.json(getDailyModelChart(data.sessions, days));
});

app.get('/api/charts/history', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const timeframe = c.req.query('timeframe') === '1h' ? '1h' : '1d';
  const groupBy = c.req.query('groupBy') === 'model' ? 'model' : 'harness';
  const rawDays = parseInt(c.req.query('days') || '30');
  const days = Number.isNaN(rawDays) ? 30 : Math.max(0, rawDays);
  return c.json(getHistoryChart(data.sessions, { timeframe, groupBy, days }));
});

app.get('/api/charts/heatmap', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  return c.json(getHeatmapData(data.sessions));
});

app.get('/api/charts/sources', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getSourceStats(sessions));
});

app.get('/api/charts/source-usage', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getSourceUsage(sessions));
});

app.get('/api/charts/models', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getModelStats(sessions));
});

app.get('/api/charts/hourly', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getHourlyStats(sessions));
});

app.get('/api/charts/cache', (c) => {
  const data = getData();
  if (!data) return c.json({ loading: true }, 503);
  const sessions = filterSessions(data.sessions, { from: c.req.query('from'), to: c.req.query('to') });
  return c.json(getCacheStats(sessions));
});

app.post('/api/collect', (c) => {
  const result = refreshData();
  return c.json({ message: 'Data refreshed', sessions: result.sessions.length });
});

  return app;
}

const app = createApp();

const port = parseInt(process.env.PORT || '3001');

if (process.env.NODE_ENV !== 'test') {
  // Start server immediately, collect data in background
  startBackgroundCollect();
  console.log(`Claude Stats API running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}
