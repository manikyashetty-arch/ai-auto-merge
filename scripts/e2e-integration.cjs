/**
 * Full-pipeline integration harness. Runs the REAL automerge resolution path
 * end-to-end against a REAL git repo, stubbing ONLY the Anthropic network call
 * at the SDK boundary. Everything else is the production code:
 *
 *   real git conflict
 *     -> resolveConflicts()            (real prompt build, streaming, parsing)
 *     -> adaptive verify/escalate      (real pipeline logic)
 *     -> syntax gate                   (real TypeScript parse)
 *     -> applyResolutions + push       (real git, force-with-lease)
 *     -> fresh clone merges cleanly    (real verification)
 *
 * The only thing not exercised is the model's judgment — that needs a real
 * ANTHROPIC_API_KEY. The stub returns a realistic combined resolution so the
 * full software path, response parsing, confidence handling, and cost
 * accounting are all driven for real.
 *
 * Run: node scripts/e2e-integration.cjs   (after npm run build)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GITHUB_APP_ID ||= '1';
process.env.GITHUB_PRIVATE_KEY ||= 'dummy';
process.env.GITHUB_WEBHOOK_SECRET ||= 'dummy';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-stub';
process.env.NODE_ENV ||= 'production';

// ─── Stub the Anthropic SDK at the module boundary (no network) ─────────────────
// The resolver does `new Anthropic().messages.stream/create`. We inject a fake
// module into require.cache BEFORE requiring the resolver so it picks it up.
let proposalCalls = 0;
let verifyCalls = 0;
const USAGE = { input_tokens: 1800, output_tokens: 240, cache_read_input_tokens: 1200, cache_creation_input_tokens: 600 };

// The resolution a competent model SHOULD produce for the retry conflict:
// combine BOTH intents — exponential backoff AND jitter.
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

function FakeAnthropic() {
  this.messages = {
    // Opus resolution proposals (streamed)
    stream() {
      proposalCalls++;
      return {
        finalMessage: async () => ({
          usage: USAGE,
          content: [{
            type: 'text',
            text: JSON.stringify({
              resolved_content: COMBINED,
              is_delete: false,
              confidence: 'high',
              explanation: 'Combined exponential backoff with jitter, preserving both PRs’ intent.',
              needs_review: false,
            }),
          }],
        }),
      };
    },
    // Haiku verifier / judge
    async create() {
      verifyCalls++;
      return {
        usage: { input_tokens: 900, output_tokens: 40 },
        content: [{ type: 'text', text: JSON.stringify({ ok: true, confidence: 'high', reason: 'both intents preserved, no markers' }) }],
      };
    },
  };
}

const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = {
  id: sdkPath, filename: sdkPath, loaded: true, exports: { __esModule: true, default: FakeAnthropic },
};

// Now require the real pipeline (it will use the stubbed SDK).
const gitOps = require('../dist/services/gitOps.js');
const { resolveConflicts } = require('../dist/services/conflictResolver.js');
const { checkSyntax } = require('../dist/services/syntaxCheck.js');
const { newRunUsage } = require('../dist/utils/pricing.js');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label} ${detail}`); fail++; }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-int-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function buildScenario() {
  const bare = path.join(tmpRoot, 'origin.git');
  const seed = path.join(tmpRoot, 'seed');
  fs.mkdirSync(bare);
  git(tmpRoot, 'init', '--bare', '-b', 'main', bare);
  git(tmpRoot, 'clone', bare, seed);
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
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

  // PR branch: exponential backoff
  git(seed, 'checkout', '-b', 'feature/backoff');
  fs.writeFileSync(path.join(seed, 'src/retry.ts'), base.replace('await sleep(1000);', 'await sleep(1000 * 2 ** i);'));
  git(seed, 'commit', '-am', 'backoff'); git(seed, 'push', 'origin', 'feature/backoff');

  // main moves on: jitter on the same line
  git(seed, 'checkout', 'main');
  fs.writeFileSync(path.join(seed, 'src/retry.ts'), base.replace('await sleep(1000);', 'await sleep(1000 + Math.random() * 500);'));
  git(seed, 'commit', '-am', 'jitter'); git(seed, 'push', 'origin', 'main');
  return bare;
}

(async () => {
  console.log('ai-auto-merge — full-pipeline integration (real git + real pipeline, model stubbed)\n');
  console.log('── Resolving a real semantic conflict through the real pipeline ──');
  const bare = buildScenario();
  const fileUrl = `file://${bare}`;

  const ctx = await gitOps.cloneRepo(fileUrl, 't', 'feature/backoff');
  const merge = await gitOps.fetchAndMergeBase(ctx, 'main', 't', fileUrl);
  const conflicted = await gitOps.getConflictedFileContents(ctx, merge.conflictedFiles);
  check('real conflict detected and extracted', conflicted.length === 1 && /<<<<<<</.test(conflicted[0].content));

  // THE pipeline call — real resolveConflicts with the model stubbed.
  const usage = newRunUsage();
  const resolved = await resolveConflicts(
    conflicted,
    'feat: exponential backoff',
    'Add exponential backoff to retry delays.',
    'feature/backoff', 'main',
    'diff --git a/src/retry.ts b/src/retry.ts', usage,
  );
  const r = resolved[0];

  check('went through the adaptive path: 1 proposal + 1 verify (not 2 proposals)',
    proposalCalls === 1 && verifyCalls === 1, `(proposals=${proposalCalls}, verify=${verifyCalls})`);
  check('returned an auto-applicable, verified resolution',
    r.method === 'ai_verified' && r.confidence === 'high' && !r.needsReview, `(method=${r.method})`);
  check('resolution combines BOTH intents (backoff AND jitter)',
    r.content.includes('2 ** i') && r.content.includes('Math.random'));
  check('no conflict markers remain', !/<<<<<<<|=======|>>>>>>>/.test(r.content));

  // Real syntax gate on the produced TypeScript.
  const syn = await checkSyntax('src/retry.ts', r.content, ctx.dir);
  check('resolved TypeScript passes the real syntax gate', syn.valid, `(${syn.error || ''})`);

  // Real cost accounting on the (stubbed) calls.
  check('cost accounting recorded usage across calls',
    usage.apiCalls === 2 && usage.inputTokens > 0 && usage.costUsd > 0,
    `(calls=${usage.apiCalls}, $${usage.costUsd.toFixed(4)})`);

  // Apply + push for real, then verify a fresh clone merges main cleanly.
  await gitOps.applyResolutions(ctx, [{ path: r.path, content: r.content, isDelete: r.isDelete }]);
  const sha = await gitOps.commitAndPush(ctx, 'fix: resolve retry conflict', 'feature/backoff', fileUrl, 't');
  await ctx.cleanup();
  check('pushed the resolution', /^[0-9a-f]{7,40}$/.test(sha));

  const verify = path.join(tmpRoot, 'verify');
  git(tmpRoot, 'clone', '-q', '-b', 'feature/backoff', bare, verify);
  git(verify, 'config', 'user.email', 't@t'); git(verify, 'config', 'user.name', 't');
  git(verify, 'fetch', 'origin', 'main');
  let merged = false;
  try { git(verify, 'merge', 'origin/main', '--no-edit'); merged = true; } catch { merged = false; }
  check('fresh clone now merges main with NO conflict', merged);

  console.log('\n── The resolution the pipeline produced ──');
  console.log(r.content.split('\n').filter((l) => l.includes('sleep(')).map((l) => '   ' + l.trim()).join('\n'));
  console.log(`\n   confidence=${r.confidence}  method=${r.method}  est.cost=$${usage.costUsd.toFixed(4)}  tokens=${usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens}`);

  console.log(`\n── Result ──\n  ${pass} passed, ${fail} failed`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); fs.rmSync(tmpRoot, { recursive: true, force: true }); process.exit(1); });
