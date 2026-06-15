/**
 * Proves the full resolution pipeline runs on the OPENAI provider end-to-end
 * against a real git conflict. Only the OpenAI HTTP call (global.fetch) is
 * stubbed — config, provider routing, parsing, the adaptive pipeline, syntax
 * gate, git apply/push, and clean-merge verification are all real.
 *
 * Run: node scripts/e2e-openai.cjs   (after npm run build)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Select the OpenAI provider before requiring config.
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-openai-stub';
process.env.OPENAI_MODEL = 'gpt-4o';
process.env.OPENAI_JUDGE_MODEL = 'gpt-4o-mini';
process.env.GITHUB_APP_ID ||= '1';
process.env.GITHUB_PRIVATE_KEY ||= 'dummy';
process.env.GITHUB_WEBHOOK_SECRET ||= 'dummy';
process.env.NODE_ENV ||= 'production';

const COMBINED = `/** Retry an async operation a fixed number of times. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(1000 * 2 ** i + Math.random() * 500);
    }
  }
  throw new Error('unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`;

let resolveHits = 0, judgeHits = 0;
// Stub the OpenAI HTTP endpoint.
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const isResolve = body.model === 'gpt-4o';
  if (isResolve) resolveHits++; else judgeHits++;
  const content = isResolve
    ? JSON.stringify({ resolved_content: COMBINED, is_delete: false, confidence: 'high', explanation: 'combined backoff and jitter', needs_review: false })
    : JSON.stringify({ ok: true, confidence: 'high', reason: 'both intents preserved, no markers' });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1500, completion_tokens: 250, prompt_tokens_details: { cached_tokens: 900 } },
    }),
    text: async () => '',
  };
};

const { config } = require('../dist/utils/config.js');
const gitOps = require('../dist/services/gitOps.js');
const { resolveConflicts } = require('../dist/services/conflictResolver.js');
const { checkSyntax } = require('../dist/services/syntaxCheck.js');
const { newRunUsage } = require('../dist/utils/pricing.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label} ${detail}`); fail++; }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-oai-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function buildScenario() {
  const bare = path.join(tmpRoot, 'origin.git');
  const seed = path.join(tmpRoot, 'seed');
  fs.mkdirSync(bare);
  git(tmpRoot, 'init', '--bare', '-b', 'main', bare);
  git(tmpRoot, 'clone', bare, seed);
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(seed, 'src'));
  const base = `export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(1000);
    }
  }
  throw new Error('unreachable');
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
`;
  fs.writeFileSync(path.join(seed, 'src/retry.ts'), base);
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'base'); git(seed, 'push', 'origin', 'main');
  git(seed, 'checkout', '-b', 'feature/backoff');
  fs.writeFileSync(path.join(seed, 'src/retry.ts'), base.replace('await sleep(1000);', 'await sleep(1000 * 2 ** i);'));
  git(seed, 'commit', '-am', 'backoff'); git(seed, 'push', 'origin', 'feature/backoff');
  git(seed, 'checkout', 'main');
  fs.writeFileSync(path.join(seed, 'src/retry.ts'), base.replace('await sleep(1000);', 'await sleep(1000 + Math.random() * 500);'));
  git(seed, 'commit', '-am', 'jitter'); git(seed, 'push', 'origin', 'main');
  return bare;
}

(async () => {
  console.log(`ai-auto-merge — OpenAI provider, full pipeline on real git (fetch stubbed)\n`);
  check('config selected the openai provider', config.llm.provider === 'openai');
  console.log('── Resolving a real conflict via the OpenAI path ──');
  const bare = buildScenario();
  const fileUrl = `file://${bare}`;

  const ctx = await gitOps.cloneRepo(fileUrl, 't', 'feature/backoff');
  const merge = await gitOps.fetchAndMergeBase(ctx, 'main', 't', fileUrl);
  const conflicted = await gitOps.getConflictedFileContents(ctx, merge.conflictedFiles);
  check('real conflict detected', conflicted.length === 1 && /<<<<<<</.test(conflicted[0].content));

  const usage = newRunUsage();
  const [r] = await resolveConflicts(conflicted, 'feat: backoff', 'Add exponential backoff.', 'feature/backoff', 'main', undefined, usage);

  check('OpenAI endpoint was called (resolve + verify)', resolveHits === 1 && judgeHits === 1, `(resolve=${resolveHits}, judge=${judgeHits})`);
  check('verified, auto-applicable resolution', r.method === 'ai_verified' && !r.needsReview, `(method=${r.method})`);
  check('combined both intents', r.content.includes('2 ** i') && r.content.includes('Math.random'));
  check('TypeScript passes the real syntax gate', (await checkSyntax('src/retry.ts', r.content, ctx.dir)).valid);
  check('cost accounting used OpenAI gpt-4o pricing', usage.apiCalls === 2 && usage.costUsd > 0, `($${usage.costUsd.toFixed(4)})`);

  await gitOps.applyResolutions(ctx, [{ path: r.path, content: r.content }]);
  const sha = await gitOps.commitAndPush(ctx, 'fix: resolve', 'feature/backoff', fileUrl, 't');
  await ctx.cleanup();
  const verify = path.join(tmpRoot, 'verify');
  git(tmpRoot, 'clone', '-q', '-b', 'feature/backoff', bare, verify);
  git(verify, 'config', 'user.email', 't@t'); git(verify, 'config', 'user.name', 't');
  git(verify, 'fetch', 'origin', 'main');
  let merged = false;
  try { git(verify, 'merge', 'origin/main', '--no-edit'); merged = true; } catch { /* conflict */ }
  check('pushed branch merges main cleanly', merged, `(sha=${sha.slice(0, 7)})`);

  console.log(`\n   provider=openai  model=gpt-4o  method=${r.method}  est.cost=$${usage.costUsd.toFixed(4)}`);
  console.log(`\n── Result ──\n  ${pass} passed, ${fail} failed`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(1); });
