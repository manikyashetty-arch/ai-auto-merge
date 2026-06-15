/**
 * LIVE end-to-end test — makes a REAL LLM API call using the key in .env.
 * Builds a real git conflict, runs the real resolution pipeline against the
 * configured provider (no stubbing), applies the result, and verifies the
 * branch then merges cleanly. Costs a small amount of real tokens.
 *
 * Run: node scripts/e2e-live.cjs   (after npm run build; requires a real key)
 * Never prints credentials.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GITHUB_APP_ID ||= '1';
process.env.GITHUB_PRIVATE_KEY ||= 'dummy';
process.env.GITHUB_WEBHOOK_SECRET ||= 'dummy';
process.env.NODE_ENV ||= 'production';
// LLM_PROVIDER + the API key come from .env via config's dotenv.

const { config } = require('../dist/utils/config.js');
const gitOps = require('../dist/services/gitOps.js');
const { resolveConflicts } = require('../dist/services/conflictResolver.js');
const { checkSyntax } = require('../dist/services/syntaxCheck.js');
const { newRunUsage, totalTokens } = require('../dist/utils/pricing.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-live-'));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); pass++; } else { console.log(`  ✗ ${l} ${d}`); fail++; } };

function buildScenario() {
  const bare = path.join(tmpRoot, 'origin.git');
  const seed = path.join(tmpRoot, 'seed');
  fs.mkdirSync(bare);
  git(tmpRoot, 'init', '--bare', '-b', 'main', bare);
  git(tmpRoot, 'clone', bare, seed);
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(seed, 'src'));
  const base = `/** Retry an async operation a fixed number of times. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(1000);
    }
  }
  throw new Error('unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
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
  console.log(`ai-auto-merge — LIVE test (real ${config.llm.provider} call)\n`);
  const bare = buildScenario();
  const fileUrl = `file://${bare}`;
  const ctx = await gitOps.cloneRepo(fileUrl, 't', 'feature/backoff');
  const merge = await gitOps.fetchAndMergeBase(ctx, 'main', 't', fileUrl);
  const conflicted = await gitOps.getConflictedFileContents(ctx, merge.conflictedFiles);
  check('real conflict detected', conflicted.length === 1);

  console.log('  → calling the model for a real resolution...');
  const usage = newRunUsage();
  const t0 = Date.now();
  const [r] = await resolveConflicts(
    conflicted,
    'feat: exponential backoff between retries',
    'Add exponential backoff to retry delays so repeated failures back off progressively.',
    'feature/backoff', 'main', undefined, usage,
  );
  const ms = Date.now() - t0;

  console.log('\n── The model produced ──');
  console.log(r.content.split('\n').map((l) => '   ' + l).join('\n'));
  console.log('────────────────────────');
  check('no conflict markers remain', !/<<<<<<<|=======|>>>>>>>/.test(r.content));
  check('resolution passes the real syntax gate', (await checkSyntax('src/retry.ts', r.content, ctx.dir)).valid);

  if (!r.needsReview) {
    await gitOps.applyResolutions(ctx, [{ path: r.path, content: r.content }]);
    await gitOps.commitAndPush(ctx, 'fix: resolve retry conflict', 'feature/backoff', fileUrl, 't');
    const v = path.join(tmpRoot, 'verify');
    git(tmpRoot, 'clone', '-q', '-b', 'feature/backoff', bare, v);
    git(v, 'config', 'user.email', 't@t'); git(v, 'config', 'user.name', 't');
    git(v, 'fetch', 'origin', 'main');
    let merged = false;
    try { git(v, 'merge', 'origin/main', '--no-edit'); merged = true; } catch { /* */ }
    check('auto-applied and branch now merges main cleanly', merged);
  } else {
    console.log('  (flagged for review — not auto-applied)');
  }
  await ctx.cleanup();

  console.log(`\n  method=${r.method}  confidence=${r.confidence}  needsReview=${r.needsReview}`);
  console.log(`  latency=${ms}ms  apiCalls=${usage.apiCalls}  tokens=${totalTokens(usage)}  est.cost=$${usage.costUsd.toFixed(4)}`);
  console.log(`  explanation: ${r.explanation}`);
  console.log(`\n── Result ──\n  ${pass} passed, ${fail} failed`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('LIVE test error:', e.message); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(1); });
