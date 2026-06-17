import { spawn } from 'child_process';
import * as path from 'path';
import * as prettier from 'prettier';
import { logger } from '../utils/logger';
import { ResolvedFile, RepoConfig } from '../types';
import { checkSyntax } from './syntaxCheck';

/**
 * Post-resolution processing that runs AFTER the conflict is resolved and the
 * syntax gate has passed, but BEFORE the commit. Two independent steps:
 *
 *   Option 1 — formatResolutions(): reformat the files the bot resolved with the
 *   bundled Prettier (honoring the repo's own Prettier config), so bot-touched
 *   files match the repo's style and stop failing `format:check`. It is
 *   deliberately conservative: it only ever touches files the bot resolved, it
 *   re-validates the formatted output through the same syntax gate, and it keeps
 *   the original content on ANY problem. It can never make a resolution worse.
 *
 *   Option 2 — runPostResolveHook(): run a repo-configured command (e.g.
 *   `npm run gen:api`) in the isolated workspace so generated artifacts are
 *   regenerated before the push. Opt-in, time-boxed, run with secrets scrubbed
 *   from its environment, and fail-safe: a failing hook commits NOTHING.
 */

/** Only files the bot actually produced content for — never untouched files. */
function isFormattable(file: ResolvedFile): boolean {
  if (file.needsReview || file.isDelete) return false;
  const method = file.method ?? '';
  return method.startsWith('ai_') || method.startsWith('fast_');
}

/**
 * Reformat resolved files in place (mutating `file.content`). Never throws and
 * never changes a file's meaning — Prettier only reformats valid code, and we
 * re-validate the result and discard it if it no longer passes the syntax gate.
 */
export async function formatResolutions(
  repoDir: string,
  files: ResolvedFile[],
  cfg: RepoConfig
): Promise<void> {
  if (!cfg.format) return;
  const eligible = files.filter(isFormattable);
  if (eligible.length === 0) return;

  for (const file of eligible) {
    try {
      const filepath = path.join(repoDir, file.path);

      // Respect the repo's .prettierignore and only format types Prettier has a
      // parser for; otherwise leave the file exactly as resolved.
      const info = await prettier.getFileInfo(filepath, { resolveConfig: false }).catch(() => null);
      if (info && (info.ignored || !info.inferredParser)) continue;

      const options = (await prettier.resolveConfig(filepath).catch(() => null)) ?? {};
      const formatted = await prettier.format(file.content, { ...options, filepath });

      if (typeof formatted !== 'string' || formatted.length === 0) continue; // never blank a file
      if (formatted === file.content) continue; // already formatted — nothing to do

      // Bulletproof guard: accept the reformat ONLY if it still passes the same
      // syntax gate the original passed. (Prettier won't break valid code, but
      // this guarantees we never commit something less valid than what we vetted.)
      const check = await checkSyntax(file.path, formatted, repoDir);
      if (!check.valid) {
        logger.warn(`${file.path}: prettier output failed re-validation — keeping the original resolution`);
        continue;
      }

      file.content = formatted;
      logger.debug(`${file.path}: auto-formatted with prettier`);
    } catch (err) {
      // Formatting is best-effort. Any failure leaves the original resolution untouched.
      logger.warn(`${file.path}: prettier formatting skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

// Drop anything secret-shaped from the hook's environment so a repo command can
// never read the GitHub App key, the LLM key, webhook secrets, etc.
const SECRET_KEY_RE = /(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|WEBHOOK|CREDENTIAL)/i;

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_KEY_RE.test(key)) continue;
    env[key] = value;
  }
  return env;
}

export interface HookResult {
  ok: boolean;
  error?: string;
}

/**
 * Run the repo's postResolve command in the workspace. Returns {ok:false,...}
 * on a non-zero exit, a spawn error, or a timeout — the caller then declines to
 * commit. Never throws.
 */
export async function runPostResolveHook(repoDir: string, cfg: RepoConfig): Promise<HookResult> {
  const command = cfg.postResolve;
  if (!command) return { ok: true };

  const timeoutMs = cfg.postResolveTimeoutSec * 1000;
  logger.info(`Running postResolve hook (timeout ${cfg.postResolveTimeoutSec}s): ${command}`);

  return new Promise<HookResult>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: repoDir,
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const capture = (chunk: Buffer) => {
      if (output.length < 8_000) output += chunk.toString();
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `failed to start: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `timed out after ${cfg.postResolveTimeoutSec}s` });
      } else if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `exited ${code}: ${output.slice(-500).trim()}` });
      }
    });
  });
}
