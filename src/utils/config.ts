import dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

/**
 * Load the GitHub App private key. Two ways, in priority order:
 *   1. GITHUB_PRIVATE_KEY_PATH — path to the downloaded .pem (recommended;
 *      avoids the error-prone job of escaping a multi-line key into .env).
 *   2. GITHUB_PRIVATE_KEY — the PEM inlined, with literal \n for newlines.
 * Validates the result actually looks like a PEM so misconfiguration fails
 * with a clear message instead of a cryptic "Invalid keyData" at first use.
 */
function loadPrivateKey(): string {
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  let key: string;
  if (keyPath) {
    try {
      key = fs.readFileSync(keyPath, 'utf-8');
    } catch (err) {
      throw new Error(`Could not read GITHUB_PRIVATE_KEY_PATH (${keyPath}): ${(err as Error).message}`);
    }
  } else {
    key = requireEnv('GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n');
  }
  // Tests run with a stub key; only enforce the PEM shape for real deployments.
  if (process.env.NODE_ENV === 'test') return key;
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(key)) {
    throw new Error(
      'GitHub App private key is malformed: missing PEM "-----BEGIN/END PRIVATE KEY-----" markers. ' +
        'Easiest fix: set GITHUB_PRIVATE_KEY_PATH to the downloaded .pem file instead of inlining the key.'
    );
  }
  return key;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Which LLM backend the resolver speaks to. Only the selected provider's key
// is required at boot — so an OpenAI deployment doesn't need an Anthropic key
// and vice-versa.
const llmProvider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase() as 'anthropic' | 'openai';

function providerKey(provider: 'anthropic' | 'openai', envKey: string): string {
  return llmProvider === provider ? requireEnv(envKey) : process.env[envKey] || '';
}

export const config = {
  github: {
    appId: parseInt(requireEnv('GITHUB_APP_ID'), 10),
    privateKey: loadPrivateKey(),
    webhookSecret: requireEnv('GITHUB_WEBHOOK_SECRET'),
  },
  llm: {
    /** 'anthropic' (Claude, native) or 'openai'. */
    provider: llmProvider,
    /**
     * adaptive: one proposal + a cheap verifier, escalating to dual-strategy +
     * judge only on doubt (default, most token-efficient).
     * thorough: always run both strategies + judge (highest assurance, ~2x cost).
     */
    resolutionMode: (process.env.RESOLUTION_MODE || 'adaptive') as 'adaptive' | 'thorough',
  },
  anthropic: {
    apiKey: providerKey('anthropic', 'ANTHROPIC_API_KEY'),
    /** Model used for conflict resolution proposals. Must support adaptive thinking for best results. */
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    /** Cheaper model used to judge/verify resolutions. */
    judgeModel: process.env.ANTHROPIC_JUDGE_MODEL || 'claude-haiku-4-5',
    /** Effort for resolution/repair calls — lower spends fewer thinking tokens. */
    effort: (process.env.ANTHROPIC_EFFORT || 'medium') as 'low' | 'medium' | 'high' | 'max',
  },
  openai: {
    apiKey: providerKey('openai', 'OPENAI_API_KEY'),
    /** Model for resolution proposals (any chat-completions model your key can use). */
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    /** Cheaper model for the verifier and judge. */
    judgeModel: process.env.OPENAI_JUDGE_MODEL || 'gpt-4o-mini',
    /** Override for Azure OpenAI or OpenAI-compatible gateways. */
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },
  server: {
    port: intEnv('PORT', 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    /** When set, /dashboard, /api/* and /metrics require this bearer token (or ?token=). */
    dashboardToken: process.env.DASHBOARD_TOKEN || '',
    /** Per-IP request ceiling per minute; <= 0 disables rate limiting. */
    rateLimitPerMinute: intEnv('RATE_LIMIT_PER_MIN', 300),
    /**
     * Only set true when running behind a reverse proxy / load balancer.
     * When false (default), client IPs come from the socket and cannot be
     * spoofed via X-Forwarded-For — which matters for the rate limiter.
     */
    trustProxy: process.env.TRUST_PROXY === 'true',
  },
  settings: {
    autoMergeOnCIPass: process.env.AUTO_MERGE_ON_CI_PASS === 'true',
    autoMergeMethod: (process.env.AUTO_MERGE_METHOD || 'SQUASH') as 'MERGE' | 'SQUASH' | 'REBASE',
    autoApplyConfidenceThreshold: (process.env.AUTO_APPLY_CONFIDENCE_THRESHOLD || 'high') as 'high' | 'medium' | 'low',
    maxFilesToAutoResolve: intEnv('MAX_FILES_TO_AUTO_RESOLVE', 20),
    /** Conflicted files larger than this (bytes) are never sent to the AI. */
    maxFileBytes: intEnv('MAX_FILE_BYTES', 262_144),
    /** BullMQ worker concurrency when REDIS_URL is set. */
    queueConcurrency: intEnv('QUEUE_CONCURRENCY', 3),
    /** Concurrent PR-merge events processed in-process when Redis is absent. */
    inProcessConcurrency: intEnv('INPROCESS_CONCURRENCY', 2),
    /** Max conflicted PRs resolved in parallel per merge (bounds a merge storm). */
    prConcurrency: intEnv('PR_CONCURRENCY', 3),
  },
  /**
   * Adaptive learning: the bot watches whether humans accept or override its
   * resolutions and stops auto-applying conflict categories a team keeps
   * rejecting. Disable to make behavior fully static.
   */
  learning: {
    enabled: process.env.LEARNING_ENABLED !== 'false',
    /** Min samples in a (repo, ext, method) bucket before its rate can gate. */
    minSamples: intEnv('LEARNING_MIN_SAMPLES', 5),
    /** Override rate (0-1) at/above which a bucket is forced to manual review. */
    overrideThreshold: floatEnv('LEARNING_OVERRIDE_THRESHOLD', 0.5),
  },
  notifications: {
    /** Slack-compatible incoming webhook URL (also works for Discord with /slack suffix). */
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    /** Generic webhook — receives the full run summary as JSON. */
    genericWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
    /** Only notify on these outcomes (comma-separated); empty = all terminal outcomes. */
    onlyOutcomes: (process.env.NOTIFY_ONLY_OUTCOMES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};
