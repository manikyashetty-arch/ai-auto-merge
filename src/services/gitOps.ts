import simpleGit, { SimpleGit } from 'simple-git';
import * as tmp from 'tmp-promise';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ConflictedFile } from '../types';

export interface GitContext {
  git: SimpleGit;
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * GitHub git-over-HTTPS expects Basic auth with username `x-access-token` and
 * the installation token as the password — NOT `Authorization: token <t>`
 * (that form is for the REST API and yields "invalid credentials" from git).
 * Sent via http.extraHeader so the token never lands in the URL, reflog, or
 * process listing.
 */
function authHeader(token: string): string {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `Authorization: Basic ${basic}`;
}

// ─── Input validation ──────────────────────────────────────────────────────────
// Owner/repo/branch values originate in webhook payloads and API responses.
// GitHub already constrains them, but these are the strings we hand to git —
// enforce our own invariants so a payload can never become a git option
// (leading '-'), traverse paths ('..'), or smuggle revision syntax ('@{').

const OWNER_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;

export function isSafeOwnerOrRepo(value: string): boolean {
  return value.length > 0 && value.length <= 100 && OWNER_REPO_RE.test(value);
}

export function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > 250) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.endsWith('.lock')) return false;
  // Conservative allow-list of ref characters (git allows more; we don't need it)
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref);
}

function assertSafeGitInputs(owner: string, repo: string, ...refs: string[]): void {
  if (!isSafeOwnerOrRepo(owner) || !isSafeOwnerOrRepo(repo)) {
    throw new Error(`Refusing git operation: suspicious owner/repo "${owner}/${repo}"`);
  }
  for (const ref of refs) {
    if (!isSafeRefName(ref)) {
      throw new Error(`Refusing git operation: suspicious ref name "${ref}"`);
    }
  }
}

/**
 * A repo-relative path is only written/read if it cannot escape the workspace:
 * no absolute paths, no '..' segments, never inside .git. Combined with
 * core.symlinks=false at clone time (symlinks materialize as plain text
 * files), this closes the symlink/path-traversal class.
 */
export function isSafeRepoPath(filePath: string): boolean {
  if (filePath.length === 0 || filePath.length > 4096) return false;
  if (path.isAbsolute(filePath) || filePath.includes('\0')) return false;
  const segments = filePath.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}

function resolveInsideRepo(repoDir: string, filePath: string): string {
  if (!isSafeRepoPath(filePath)) {
    throw new Error(`Refusing to touch unsafe repo path "${filePath}"`);
  }
  const full = path.resolve(repoDir, filePath);
  const root = path.resolve(repoDir) + path.sep;
  if (!full.startsWith(root)) {
    throw new Error(`Path "${filePath}" escapes the workspace`);
  }
  return full;
}

// ─── Workspace lifecycle ───────────────────────────────────────────────────────

export async function cloneRepo(
  repoUrl: string,
  token: string,
  branch: string
): Promise<GitContext> {
  const tmpDir = await tmp.dir({ unsafeCleanup: true });
  const git = simpleGit();

  logger.debug(`Cloning ${repoUrl} branch ${branch} to ${tmpDir.path}`);

  // Auth via http.extraHeader rather than embedding the token in the URL
  // (URLs leak into reflog and process listings). core.symlinks=false makes
  // attacker-supplied symlinks check out as inert text files, so later file
  // reads/writes can't traverse out of the workspace through them.
  await git.clone(repoUrl, tmpDir.path, [
    '--depth', '50',
    '--branch', branch,
    '--single-branch',
    '--no-tags',
    '--config', `http.extraHeader=${authHeader(token)}`,
    '--config', 'core.symlinks=false',
  ]);

  const repoGit = simpleGit(tmpDir.path);

  await repoGit.addConfig('user.email', 'ai-auto-merge[bot]@users.noreply.github.com');
  await repoGit.addConfig('user.name', 'ai-auto-merge[bot]');
  // Keep auth available for the fetch/push steps
  await repoGit.addConfig('http.extraHeader', authHeader(token));

  return {
    git: repoGit,
    dir: tmpDir.path,
    cleanup: async () => tmpDir.cleanup(),
  };
}

export async function fetchAndMergeBase(
  ctx: GitContext,
  baseBranch: string,
  token: string,
  remoteUrl: string
): Promise<{ hasConflicts: boolean; conflictedFiles: string[] }> {
  await ctx.git.addConfig('http.extraHeader', authHeader(token));
  await ctx.git.fetch(remoteUrl, baseBranch);

  try {
    await ctx.git.merge(['FETCH_HEAD', '--no-commit', '--no-ff']);
    // No conflicts — clean up the in-progress merge state
    await ctx.git.merge(['--abort']).catch(() => {
      // Fast-forward merges have no state to abort, ignore
    });
    return { hasConflicts: false, conflictedFiles: [] };
  } catch {
    const status = await ctx.git.status();
    const conflictedFiles = status.conflicted;
    logger.info(`Found ${conflictedFiles.length} conflicted files`);
    return { hasConflicts: conflictedFiles.length > 0, conflictedFiles };
  }
}

// Also handles delete/modify conflicts where one side removed the file.
export async function getConflictedFileContents(
  ctx: GitContext,
  conflictedFiles: string[]
): Promise<ConflictedFile[]> {
  const result: ConflictedFile[] = [];

  for (const filePath of conflictedFiles) {
    let fullPath: string;
    try {
      fullPath = resolveInsideRepo(ctx.dir, filePath);
    } catch (err) {
      logger.warn(`Skipping conflicted path: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    try {
      const stat = fs.existsSync(fullPath) ? fs.lstatSync(fullPath) : null;
      if (!stat) {
        // File was deleted on one side — surface this to Claude with a synthetic marker
        const deletedContent = await getDeleteConflictContent(ctx, filePath);
        result.push({ path: filePath, content: deletedContent, isDeleteConflict: true });
      } else if (!stat.isFile()) {
        logger.warn(`Skipping ${filePath}: not a regular file (mode ${stat.mode.toString(8)})`);
      } else {
        const content = fs.readFileSync(fullPath, 'utf-8');
        result.push({ path: filePath, content });
      }
    } catch (err) {
      logger.warn(`Could not read conflicted file ${filePath}:`, err);
    }
  }

  return result;
}

async function getDeleteConflictContent(ctx: GitContext, filePath: string): Promise<string> {
  // Try to show what the file looked like on each side for Claude's context
  try {
    const ourContent = await ctx.git.show([`HEAD:${filePath}`]).catch(() => '(deleted)');
    const theirContent = await ctx.git.show([`FETCH_HEAD:${filePath}`]).catch(() => '(deleted)');
    return [
      `<<<<<<< HEAD (this PR's branch)`,
      ourContent,
      `=======`,
      theirContent,
      `>>>>>>> MERGE_HEAD (base branch)`,
    ].join('\n');
  } catch {
    return '(could not retrieve file content for delete/modify conflict)';
  }
}

export async function applyResolutions(
  ctx: GitContext,
  resolutions: Array<{ path: string; content: string; isDelete?: boolean }>
): Promise<void> {
  for (const { path: filePath, content, isDelete } of resolutions) {
    const fullPath = resolveInsideRepo(ctx.dir, filePath);
    if (isDelete) {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      await ctx.git.rm([filePath]);
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      await ctx.git.add(fullPath);
    }
    logger.debug(`Applied resolution for ${filePath}`);
  }
}

export async function commitAndPush(
  ctx: GitContext,
  message: string,
  branch: string,
  _remoteUrl: string,
  _token: string
): Promise<string> {
  if (!isSafeRefName(branch)) {
    throw new Error(`Refusing to push to suspicious branch name "${branch}"`);
  }
  // Auth is already set via http.extraHeader in the repo config; --no-verify
  // skips any client-side hooks.
  await ctx.git.commit(message, { '--no-verify': null });
  const log = await ctx.git.log({ maxCount: 1 });
  const commitSha = log.latest?.hash || '';

  try {
    // --force-with-lease: if the author pushed to this branch after we cloned,
    // the lease is stale and git REJECTS the push. That is the intended safety
    // valve — we never overwrite work that landed during resolution.
    await ctx.git.push('origin', `HEAD:refs/heads/${branch}`, ['--force-with-lease']);
  } catch (err) {
    if (isStaleLeaseError(err)) {
      throw new ConcurrentPushError(branch);
    }
    throw err;
  }
  logger.info(`Pushed resolved conflicts to ${branch} (${commitSha})`);

  return commitSha;
}

/** The branch moved under us (someone pushed during resolution); we declined to overwrite. */
export class ConcurrentPushError extends Error {
  constructor(branch: string) {
    super(`Branch "${branch}" changed during resolution; declined to force-push over it.`);
    this.name = 'ConcurrentPushError';
  }
}

function isStaleLeaseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /stale info|force-with-lease|non-fast-forward|\[rejected\]|fetch first/i.test(msg);
}

export async function abortMerge(ctx: GitContext): Promise<void> {
  try {
    await ctx.git.merge(['--abort']);
  } catch {
    // No merge in progress
  }
}

export async function prepareConflictWorkspace(
  repoOwner: string,
  repoName: string,
  prBranch: string,
  baseBranch: string,
  token: string
): Promise<{
  ctx: GitContext;
  conflictedFiles: ConflictedFile[];
  remoteUrl: string;
}> {
  assertSafeGitInputs(repoOwner, repoName, prBranch, baseBranch);

  const remoteUrl = `https://github.com/${repoOwner}/${repoName}.git`;

  const ctx = await cloneRepo(remoteUrl, token, prBranch);

  const { hasConflicts, conflictedFiles: conflictedPaths } = await fetchAndMergeBase(
    ctx,
    baseBranch,
    token,
    remoteUrl
  );

  if (!hasConflicts) {
    return { ctx, conflictedFiles: [], remoteUrl };
  }

  const conflictedFiles = await getConflictedFileContents(ctx, conflictedPaths);
  return { ctx, conflictedFiles, remoteUrl };
}
