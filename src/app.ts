import crypto from 'crypto';
import express from 'express';
import { registerWebhookHandlers, handleWebhook } from './handlers/webhook';
import { getQueueStats, isQueueEnabled } from './services/queue';
import { getRuns, getStats } from './services/runHistory';
import { getInsights } from './services/learning';
import { notificationsConfigured } from './services/notify';
import { dashboardHtml } from './dashboard/html';
import { logger } from './utils/logger';
import { config } from './utils/config';
import { metrics, renderPrometheus } from './utils/metrics';

const VERSION = process.env.npm_package_version || '1.0.0';
const startedAt = Date.now();

// Fixed route labels keep Prometheus cardinality bounded.
const KNOWN_ROUTES = new Set(['/webhook', '/health', '/metrics', '/dashboard', '/api/stats', '/api/runs', '/api/insights']);

function humanUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

// ─── Middleware ────────────────────────────────────────────────────────────────

/** Fixed-window per-IP rate limiter. In-memory by design — webhook traffic is modest. */
function rateLimiter(): express.RequestHandler {
  const limit = config.server.rateLimitPerMinute;
  const hits = new Map<string, { count: number; windowStart: number }>();
  const WINDOW_MS = 60_000;

  return (req, res, next) => {
    if (limit <= 0) return next();
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      if (hits.size > 10_000) hits.clear(); // bound memory under address-spoofing floods
      hits.set(key, { count: 1, windowStart: now });
      return next();
    }
    if (++entry.count > limit) {
      metrics.rateLimited.inc();
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}

function requestLogger(): express.RequestHandler {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const route = KNOWN_ROUTES.has(req.path) ? req.path : 'other';
      metrics.httpRequests.inc({ route, status: String(res.statusCode) });
      const line = `${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`;
      if (req.path === '/health' || req.path === '/metrics') logger.debug(line);
      else logger.info(line);
    });
    next();
  };
}

/** Constant-time string comparison (hash first so lengths never leak). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Optional bearer-token gate for observability endpoints. Active when DASHBOARD_TOKEN is set. */
function observabilityAuth(): express.RequestHandler {
  return (req, res, next) => {
    const token = config.server.dashboardToken;
    if (!token) return next();
    const header = req.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
    if (typeof presented === 'string' && safeEqual(presented, token)) return next();
    res.status(401).json({ error: 'Unauthorized — set Authorization: Bearer <DASHBOARD_TOKEN> or ?token=' });
  };
}

/**
 * Baseline security headers on every response, plus a strict CSP for the
 * dashboard (its only script/style are inline; it talks to /api/* on the
 * same origin and loads no external resources).
 */
function securityHeaders(): express.RequestHandler {
  const DASHBOARD_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.path === '/dashboard') {
      res.setHeader('Content-Security-Policy', DASHBOARD_CSP);
    }
    next();
  };
}

// ─── App factory ───────────────────────────────────────────────────────────────

export function createApp(): express.Application {
  const app = express();
  app.disable('x-powered-by');
  // Spoofable X-Forwarded-For would defeat the per-IP rate limiter — only
  // trust it when explicitly deployed behind a proxy (TRUST_PROXY=true).
  app.set('trust proxy', config.server.trustProxy);

  app.use(securityHeaders());
  app.use(requestLogger());
  app.use(rateLimiter());

  // /webhook must receive the RAW body — GitHub signs the exact bytes.
  // Limit raised well above GitHub's typical PR payloads (default 100kb
  // silently 413s large PR descriptions → missed events).
  app.use('/webhook', express.raw({ type: 'application/json', limit: '10mb' }));
  app.use(express.json({ limit: '256kb' }));

  registerWebhookHandlers();

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: VERSION,
      env: config.server.nodeEnv,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      queue: isQueueEnabled() ? 'enabled' : 'disabled (in-process fallback)',
      provider: config.llm.provider,
      model: config.llm.provider === 'openai' ? config.openai.model : config.anthropic.model,
      learning: config.learning.enabled ? 'on' : 'off',
      notifications: notificationsConfigured() ? 'configured' : 'none',
    });
  });

  const guard = observabilityAuth();

  app.get('/dashboard', guard, (_req, res) => {
    res.type('html').send(dashboardHtml);
  });

  app.get('/api/stats', guard, async (_req, res) => {
    const stats = getStats();
    const queueStats = await getQueueStats().catch(() => null);
    const insights = getInsights(1000);
    const gatingBuckets = insights.buckets.filter((b) => b.gating).length;
    res.json({
      ...stats,
      queue: { mode: isQueueEnabled() ? 'bullmq' : 'in-process', stats: queueStats },
      learning: {
        enabled: insights.enabled,
        trackedBuckets: insights.buckets.length,
        gatingBuckets,
      },
      notifications: notificationsConfigured(),
      version: VERSION,
      uptimeHuman: humanUptime(Date.now() - startedAt),
    });
  });

  app.get('/api/runs', guard, (req, res) => {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    res.json({ runs: getRuns(Number.isFinite(limit) ? limit : 50) });
  });

  app.get('/api/insights', guard, (req, res) => {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    res.json(getInsights(Number.isFinite(limit) ? limit : 100));
  });

  app.get('/metrics', guard, async (_req, res) => {
    const extra: Record<string, { help: string; value: number }> = {
      aam_uptime_seconds: { help: 'Process uptime', value: Math.floor((Date.now() - startedAt) / 1000) },
    };
    const queueStats = await getQueueStats().catch(() => null);
    if (queueStats) {
      extra.aam_queue_waiting = { help: 'Jobs waiting in queue', value: queueStats.waiting };
      extra.aam_queue_active = { help: 'Jobs being processed', value: queueStats.active };
      extra.aam_queue_failed = { help: 'Jobs in failed state', value: queueStats.failed };
    }
    res.type('text/plain; version=0.0.4').send(renderPrometheus(extra));
  });

  app.post('/webhook', async (req, res) => {
    await handleWebhook(req, res);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
