/**
 * End-to-end harness that drives the REAL compiled pipeline against REAL git
 * repositories — no GitHub App and no Anthropic key required.
 *
 * It proves the parts of "how well it works" that don't depend on a paid API:
 *   A. The full gitOps workflow (clone, merge base, detect conflict, apply a
 *      resolution, commit, force-with-lease push) against a real bare remote,
 *      then verifies the pushed branch actually merges cleanly afterwards.
 *   B. Zero-AI fast-path resolution of additive and import conflicts via the
 *      real resolveConflicts() (these never call Claude).
 *   C. The classifier correctly routes a genuine modify/modify conflict to the
 *      AI path (the only step that needs an Anthropic key).
 *
 * Run: node scripts/e2e-local.mjs   (after npm run build)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// config.ts requires these at import time; harness uses dummies (no real calls).
process.env.GITHUB_APP_ID ||= '1';
process.env.GITHUB_PRIVATE_KEY ||= 'dummy';
process.env.GITHUB_WEBHOOK_SECRET ||= 'dummy';
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-dummy-not-used';
process.env.NODE_ENV ||= 'production'; // quiet logs

const gitOps = await import('../dist/services/gitOps.js');
const { classify } = await import('../dist/services/conflictClassifier.js');
const { resolveConflicts } = await import('../dist/services/conflictResolver.js');

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label} ${detail}`);
    fail++;
  }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aam-e2e-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function section(t) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
}

// ─── Scenario: a real bare remote + a PR branch that conflicts with main ─────────
function buildScenario() {
  const bare = path.join(tmpRoot, 'origin.git');
  const seed = path.join(tmpRoot, 'seed');
  fs.mkdirSync(bare);
  git(tmpRoot, 'init', '--bare', '-b', 'main', bare);
  git(tmpRoot, 'clone', bare, seed);
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');

  // Base main
  fs.writeFileSync(path.join(seed, 'config.ts'),
    'export const settings = {\n  timeout: 30,\n  retries: 3,\n};\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'push', 'origin', 'main');
  const baseSha = git(seed, 'rev-parse', 'HEAD').trim();

  // pr-2 branches off base, changes the timeout line
  git(seed, 'checkout', '-b', 'pr-2');
  fs.writeFileSync(path.join(seed, 'config.ts'),
    'export const settings = {\n  timeout: 90,\n  retries: 3,\n};\n');
  git(seed, 'commit', '-am', 'pr-2: timeout 90');
  git(seed, 'push', 'origin', 'pr-2');

  // Meanwhile another PR merged to main, changing the SAME line → future conflict
  git(seed, 'checkout', 'main');
  fs.writeFileSync(path.join(seed, 'config.ts'),
    'export const settings = {\n  timeout: 60,\n  retries: 3,\n};\n');
  git(seed, 'commit', '-am', 'pr-1 merged: timeout 60');
  git(seed, 'push', 'origin', 'main');

  return { bare, baseSha };
}

async function testGitOpsPlumbing() {
  section('A. Real gitOps workflow (clone -> detect -> apply -> push)');
  const { bare } = buildScenario();
  const fileUrl = `file://${bare}`;

  // Clone the PR branch exactly as the app does (symlinks disabled, shallow).
  const ctx = await gitOps.cloneRepo(fileUrl, 'unused-token', 'pr-2');
  check('cloned PR branch into an isolated workspace', fs.existsSync(path.join(ctx.dir, 'config.ts')));

  // Detect the conflict by merging the base branch.
  const merge = await gitOps.fetchAndMergeBase(ctx, 'main', 'unused-token', fileUrl);
  check('detected the conflict on merge', merge.hasConflicts && merge.conflictedFiles.includes('config.ts'),
    `(hasConflicts=${merge.hasConflicts}, files=${merge.conflictedFiles})`);

  const conflicted = await gitOps.getConflictedFileContents(ctx, merge.conflictedFiles);
  check('extracted conflicted file contents with markers',
    conflicted.length === 1 && /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/.test(conflicted[0].content));

  // Apply a resolution (what Claude would return) and push it back.
  const resolved = 'export const settings = {\n  timeout: 90,\n  retries: 3,\n};\n';
  await gitOps.applyResolutions(ctx, [{ path: 'config.ts', content: resolved }]);
  const sha = await gitOps.commitAndPush(ctx, 'fix: resolve conflict', 'pr-2', fileUrl, 'unused-token');
  check('committed and force-with-lease pushed the resolution', /^[0-9a-f]{7,40}$/.test(sha), `(sha=${sha})`);
  await ctx.cleanup();

  // The decisive proof: a FRESH clone of pr-2 now merges main with no conflict.
  const verifyDir = path.join(tmpRoot, 'verify');
  git(tmpRoot, 'clone', '-b', 'pr-2', bare, verifyDir);
  git(verifyDir, 'config', 'user.email', 't@t');
  git(verifyDir, 'config', 'user.name', 't');
  git(verifyDir, 'fetch', 'origin', 'main');
  let merged = false;
  try {
    git(verifyDir, 'merge', 'origin/main', '--no-edit');
    merged = true;
  } catch {
    merged = false;
  }
  check('pushed branch now merges main cleanly (conflict resolved for real)', merged);
  const finalContent = fs.readFileSync(path.join(verifyDir, 'config.ts'), 'utf-8');
  check('resolved content has no leftover markers', !/<<<<<<<|>>>>>>>/.test(finalContent));
}

async function testFastPaths() {
  section('B. Zero-AI fast-path resolution (real resolveConflicts, no Claude)');

  const additive = {
    path: 'utils.ts',
    content: [
      'export function existing() { return 0; }',
      '<<<<<<< HEAD',
      'export function fromPR() { return 1; }',
      '=======',
      'export function fromMain() { return 2; }',
      '>>>>>>> MERGE_HEAD',
    ].join('\n') + '\n',
  };
  const aRes = await resolveConflicts([additive], 'feat', null, 'pr', 'main');
  check('additive conflict resolved with high confidence, no AI',
    aRes[0].confidence === 'high' && aRes[0].method === 'fast_additive');
  check('additive result keeps BOTH new functions',
    aRes[0].content.includes('fromPR') && aRes[0].content.includes('fromMain') &&
    !/<<<<<<<|>>>>>>>/.test(aRes[0].content));

  const imports = {
    path: 'app.ts',
    content: [
      '<<<<<<< HEAD',
      "import { useState } from 'react';",
      '=======',
      "import { useEffect } from 'react';",
      '>>>>>>> MERGE_HEAD',
      'export default function App() {}',
    ].join('\n') + '\n',
  };
  const iRes = await resolveConflicts([imports], 'feat', null, 'pr', 'main');
  check('import-only conflict merged + deduped, no AI',
    iRes[0].method === 'fast_imports' &&
    iRes[0].content.includes('useState') && iRes[0].content.includes('useEffect') &&
    !/<<<<<<<|>>>>>>>/.test(iRes[0].content));

  const lock = { path: 'package-lock.json', content: '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> MERGE_HEAD\n' };
  const lRes = await resolveConflicts([lock], 'feat', null, 'pr', 'main');
  check('lockfile flagged for regeneration, never sent to AI',
    lRes[0].method === 'lockfile' && lRes[0].needsReview && /npm install/.test(lRes[0].explanation));
}

function testClassifierRouting() {
  section('C. Classifier routing (where the Anthropic key is needed)');
  const complex = {
    path: 'logic.ts',
    content: [
      'function f(x) {',
      '<<<<<<< HEAD',
      '  return x.trim().toUpperCase();',
      '=======',
      '  return x.trim().toLowerCase();',
      '>>>>>>> MERGE_HEAD',
      '}',
    ].join('\n'),
  };
  const c = classify(complex);
  check('genuine modify/modify conflict routes to the AI path (complex_modify)', c.type === 'complex_modify',
    `(type=${c.type})`);
  console.log('    -> this is the only conflict class that consumes Anthropic tokens.');
}

try {
  console.log('ai-auto-merge — local end-to-end harness (real git, no GitHub App, no API key)');
  await testGitOpsPlumbing();
  await testFastPaths();
  testClassifierRouting();
  section('Result');
  console.log(`  ${pass} passed, ${fail} failed`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
