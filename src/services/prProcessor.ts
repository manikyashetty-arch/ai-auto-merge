import {
  getInstallationOctokit,
  getInstallationToken,
  getOpenPRsWithConflicts,
  getPRByNumber,
  postComment,
  createCommitStatus,
  enableAutoMerge,
  getPRDiff,
} from './github';
import { prepareConflictWorkspace, applyResolutions, commitAndPush, abortMerge, ConcurrentPushError } from './gitOps';
import { formatResolutions, runPostResolveHook } from './postProcess';
import { resolveConflicts, repairResolution } from './conflictResolver';
import { getRepoConfig } from './repoConfig';
import { checkSyntax } from './syntaxCheck';
import { startRun, finishRun } from './runHistory';
import { getGate } from './learning';
import {
  buildSuccessComment,
  buildDryRunComment,
  buildReviewRequiredComment,
  buildSkippedComment,
  buildErrorComment,
} from './comments';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { mapLimit } from '../utils/async';
import {
  ManualResolveEvent,
  MergedPREvent,
  PRInfo,
  RepoConfig,
  ResolvedFile,
  RunRecord,
  TriggerInfo,
} from '../types';
import * as minimatch from 'minimatch';

// ─── Per-PR serialization ──────────────────────────────────────────────────────
// Two triggers can land for the same PR in quick succession (e.g. two PRs merge
// into main back-to-back, or a manual /ai-merge during a run). Chaining on a
// per-PR promise guarantees we never run two workspaces against one branch.

const prLocks = new Map<string, Promise<void>>();

async function withPRLock(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = prLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  prLocks.set(key, next);
  try {
    await next;
  } finally {
    if (prLocks.get(key) === next) prLocks.delete(key);
  }
}

// ─── Entry points ──────────────────────────────────────────────────────────────

export async function processMergedPR(event: MergedPREvent): Promise<void> {
  logger.info(`Processing merged PR #${event.prNumber} "${event.prTitle}" → ${event.baseRef}`);

  const octokit = await getInstallationOctokit(event.installationId);

  const conflictedPRs = await getOpenPRsWithConflicts(
    octokit,
    event.repoOwner,
    event.repoName,
    event.baseRef,
    event.prNumber,
    event.installationId
  );

  if (conflictedPRs.length === 0) {
    logger.info('No conflicted PRs found, nothing to do');
    return;
  }

  logger.info(`Found ${conflictedPRs.length} conflicted PRs to resolve`);

  const trigger: TriggerInfo = {
    kind: 'merge',
    prNumber: event.prNumber,
    prTitle: event.prTitle,
    baseRef: event.baseRef,
    mergedBy: event.mergedBy,
  };

  // Resolve conflicted PRs with bounded fan-out. Default PR_CONCURRENCY=1 means
  // strictly sequential — one PR resolved (clone → resolve → push) before the
  // next — which is predictable and gentle on GitHub/LLM rate limits. Each PR
  // is still independently resolved against the merged base, so order doesn't
  // affect correctness; sequential just paces the work.
  await mapLimit(conflictedPRs, Math.max(1, config.settings.prConcurrency), (pr) =>
    withPRLock(`${pr.repoOwner}/${pr.repoName}#${pr.number}`, () => resolveConflictsForPR(pr, trigger)).catch(
      (err) => {
        logger.error(`Failed to process PR #${pr.number}:`, err);
      }
    )
  );
}

/** Handle a `/ai-merge` slash command on a specific PR. */
export async function processManualResolve(event: ManualResolveEvent): Promise<void> {
  logger.info(`Manual resolve for ${event.repoOwner}/${event.repoName}#${event.prNumber} by @${event.requestedBy}`);

  const octokit = await getInstallationOctokit(event.installationId);
  const { pr, state, isFork } = await getPRByNumber(
    octokit,
    event.repoOwner,
    event.repoName,
    event.prNumber,
    event.installationId
  );

  const trigger: TriggerInfo = { kind: 'manual', requestedBy: event.requestedBy, baseRef: pr.baseRef };

  if (state !== 'open') {
    await postComment(octokit, pr.repoOwner, pr.repoName, pr.number,
      buildSkippedComment('This PR is not open.', trigger));
    return;
  }
  if (isFork) {
    await postComment(octokit, pr.repoOwner, pr.repoName, pr.number,
      buildSkippedComment('This PR comes from a fork — the app cannot push to fork branches.', trigger));
    return;
  }

  await withPRLock(`${pr.repoOwner}/${pr.repoName}#${pr.number}`, () =>
    resolveConflictsForPR(pr, trigger, { dryRunOverride: event.dryRunOverride })
  );
}

// ─── Core flow ─────────────────────────────────────────────────────────────────

interface ResolveOptions {
  dryRunOverride?: boolean;
}

async function resolveConflictsForPR(
  pr: PRInfo,
  trigger: TriggerInfo,
  opts: ResolveOptions = {}
): Promise<void> {
  const octokit = await getInstallationOctokit(pr.installationId);

  logger.info(`Resolving conflicts for PR #${pr.number} "${pr.title}" (${pr.headRef})`);

  const run = startRun({
    repo: `${pr.repoOwner}/${pr.repoName}`,
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
    trigger,
  });

  try {
    await resolveWithRun(pr, trigger, opts, octokit, run);
  } catch (err) {
    // The author pushed during resolution — git refused the force-with-lease.
    // This is success of the safety valve, not a failure: leave their work alone.
    if (err instanceof ConcurrentPushError) {
      logger.info(`PR #${pr.number}: ${err.message} (left untouched)`);
      finishRun(run, 'skipped', err.message);
      await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'success',
        'Branch changed during resolution — left your changes untouched').catch(() => undefined);
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    finishRun(run, 'error', reason);
    logger.error(`PR #${pr.number}: unexpected error during resolution:`, err);
    await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'error',
      'AI conflict resolution failed unexpectedly').catch(() => undefined);
    // Always tell the PR what happened — including merge-triggered runs, which
    // previously got only the terse commit status and no explanation. The reason
    // is scrubbed of secrets inside buildErrorComment before it is posted.
    await postComment(octokit, pr.repoOwner, pr.repoName, pr.number, buildErrorComment(trigger, reason))
      .catch(() => undefined);
    throw err;
  }
}

async function resolveWithRun(
  pr: PRInfo,
  trigger: TriggerInfo,
  opts: ResolveOptions,
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>,
  run: RunRecord
): Promise<void> {
  // Load per-repo config from .auto-merge.yml on the BASE branch — never the PR
  // head. The config governs the bot's own safety policy (confidence threshold,
  // dryRun, auto-merge), so reading it from the attacker-controllable head ref
  // would let a malicious PR lower the bot's guardrails against itself.
  const repoConfig = await getRepoConfig(octokit, pr.repoOwner, pr.repoName, pr.baseRef);

  if (!repoConfig.enabled) {
    logger.info(`ai-auto-merge disabled for ${pr.repoOwner}/${pr.repoName}, skipping`);
    finishRun(run, 'disabled', 'Disabled via .auto-merge.yml');
    return;
  }

  const dryRun = opts.dryRunOverride ?? repoConfig.dryRun;

  await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'pending',
    'AI is resolving merge conflicts…');

  const token = await getInstallationToken(pr.installationId);

  // Fetch the PR diff for richer Claude context
  const prDiff = await getPRDiff(octokit, pr.repoOwner, pr.repoName, pr.number);

  const { ctx, conflictedFiles, remoteUrl } = await prepareConflictWorkspace(
    pr.repoOwner,
    pr.repoName,
    pr.headRef,
    pr.baseRef,
    token
  );

  try {
    if (conflictedFiles.length === 0) {
      logger.info(`PR #${pr.number} has no conflicts after workspace prep`);
      await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'success',
        'No conflicts found');
      finishRun(run, 'no_conflicts');
      return;
    }

    // Filter out excluded paths from per-repo config
    const filesToResolve = conflictedFiles.filter(
      (f) => !repoConfig.excludePaths.some((pattern) => minimatch.minimatch(f.path, pattern))
    );
    const excluded = conflictedFiles.filter((f) =>
      repoConfig.excludePaths.some((pattern) => minimatch.minimatch(f.path, pattern))
    );

    if (excluded.length > 0) {
      logger.info(`Skipping ${excluded.length} excluded paths: ${excluded.map((f) => f.path).join(', ')}`);
    }

    if (filesToResolve.length === 0) {
      const msg = `All ${excluded.length} conflicted file(s) are excluded by .auto-merge.yml. Manual resolution required.`;
      await abortMerge(ctx);
      await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'failure', msg);
      await postComment(octokit, pr.repoOwner, pr.repoName, pr.number, buildSkippedComment(msg, trigger));
      finishRun(run, 'review_required', msg);
      return;
    }

    if (filesToResolve.length > repoConfig.maxFilesToAutoResolve) {
      const msg = `Too many conflicted files (${filesToResolve.length} > ${repoConfig.maxFilesToAutoResolve}). Manual resolution required.`;
      logger.warn(msg);
      await abortMerge(ctx);
      await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'failure', msg);
      await postComment(octokit, pr.repoOwner, pr.repoName, pr.number, buildSkippedComment(msg, trigger));
      finishRun(run, 'skipped', msg);
      return;
    }

    const resolvedFiles = await resolveConflicts(
      filesToResolve,
      pr.title,
      pr.body,
      pr.headRef,
      pr.baseRef,
      prDiff || undefined,
      run.usage
    );

    // Pre-push syntax gate with one AI repair attempt per failing file
    await syntaxGate(resolvedFiles, ctx.dir, run);

    // Option 1: auto-format the files the bot resolved so they match the repo's
    // style (and stop failing format:check). Only touches resolved files,
    // re-validates the result, and keeps the original on any problem.
    await formatResolutions(ctx.dir, resolvedFiles, repoConfig);

    // Adaptive learning gate: route conflict categories this team has
    // historically overridden back to manual review.
    applyLearningGates(`${pr.repoOwner}/${pr.repoName}`, resolvedFiles);

    const { autoApply, needsReview } = classifyResolutions(resolvedFiles, repoConfig);

    recordRunFiles(run, resolvedFiles, autoApply, dryRun);

    // Dry-run mode: post comment with proposed resolutions but don't push
    if (dryRun) {
      await abortMerge(ctx);
      await postComment(octokit, pr.repoOwner, pr.repoName, pr.number,
        buildDryRunComment(resolvedFiles, trigger, run.usage));
      await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'pending',
        'Dry-run: review proposed resolutions in PR comment');
      finishRun(run, 'dry_run');
      return;
    }

    // A git merge commit is atomic: git refuses to commit while ANY conflicted
    // file is still unmerged. So we only complete and push the merge when EVERY
    // conflicted file was confidently auto-applied. If any file needs review (or
    // was excluded by config), pushing a partial merge would force us to either
    // commit conflict markers or pick one side and silently drop the other —
    // both unacceptable — so we abort, leave the branch untouched, and hand the
    // whole PR to a human, including a preview of the resolutions we could make.
    const unresolved = needsReview.length + excluded.length;
    if (unresolved > 0) {
      await abortMerge(ctx);
      const status =
        autoApply.length === 0
          ? 'AI could not confidently resolve conflicts'
          : `Resolved ${autoApply.length}/${conflictedFiles.length} files; ${unresolved} still need manual review (cannot push a partial merge)`;
      await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'failure', status.slice(0, 140));
      await postComment(octokit, pr.repoOwner, pr.repoName, pr.number,
        buildReviewRequiredComment(resolvedFiles, trigger, run.usage, excluded.map((f) => f.path)));
      finishRun(run, 'review_required', status);
      return;
    }

    await applyResolutions(
      ctx,
      autoApply.map((f) => ({ path: f.path, content: f.content, isDelete: f.isDelete }))
    );

    // Option 2 (opt-in): run the repo's postResolve command (e.g. regenerate API
    // types) in the isolated workspace before committing. Fail-safe — if it
    // errors or times out, commit NOTHING and flag the PR for manual review, so
    // a broken hook can never push half-generated output.
    if (repoConfig.postResolve) {
      const hook = await runPostResolveHook(ctx.dir, repoConfig);
      if (!hook.ok) {
        const msg = `Conflicts were resolved, but the postResolve command failed (${hook.error}). Nothing was committed — resolve manually, or fix the command in .auto-merge.yml.`;
        logger.warn(`PR #${pr.number}: postResolve hook failed — ${hook.error}`);
        await abortMerge(ctx);
        await createCommitStatus(octokit, pr.repoOwner, pr.repoName, pr.headSha, 'failure', 'postResolve hook failed');
        await postComment(octokit, pr.repoOwner, pr.repoName, pr.number, buildSkippedComment(msg, trigger));
        finishRun(run, 'review_required', msg);
        return;
      }
      // Stage anything the hook generated or changed (respects .gitignore).
      await ctx.git.raw(['add', '-A']);
    }

    const commitMessage = buildCommitMessage(pr, trigger, autoApply);
    const commitSha = await commitAndPush(ctx, commitMessage, pr.headRef, remoteUrl, token);
    run.commitSha = commitSha;

    await createCommitStatus(octokit, pr.repoOwner, pr.repoName, commitSha, 'success',
      `Resolved ${autoApply.length} conflict(s) with AI`);

    // Close the loop: optionally arm GitHub auto-merge so the PR lands when CI
    // is green. Only when everything was resolved — partial resolutions still
    // need a human.
    let autoMergeArmed = false;
    if (repoConfig.autoMergeOnCIPass && needsReview.length === 0 && excluded.length === 0) {
      autoMergeArmed = await enableAutoMerge(octokit, pr.repoOwner, pr.repoName, pr.number);
    }

    await postComment(octokit, pr.repoOwner, pr.repoName, pr.number,
      buildSuccessComment(autoApply, needsReview, excluded.map((f) => f.path), commitSha, trigger,
        run.usage, autoMergeArmed));

    finishRun(run, needsReview.length > 0 ? 'partial' : 'resolved');
    logger.info(`Successfully resolved conflicts for PR #${pr.number} (commit ${commitSha})`);
  } finally {
    await ctx.cleanup();
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate every auto-applicable file. On failure, ask Claude to repair the
 * syntax once; if it still fails, downgrade the file to needs-review.
 */
async function syntaxGate(resolvedFiles: ResolvedFile[], repoDir: string, run: RunRecord): Promise<void> {
  for (const file of resolvedFiles) {
    if (file.needsReview || file.isDelete) continue;

    let check = await checkSyntax(file.path, file.content, repoDir);
    if (check.valid) continue;

    logger.warn(`${file.path}: syntax check failed — ${check.error}; attempting AI repair`);
    const repair = await repairResolution(file.path, file.content, check.error ?? 'syntax error', run.usage);

    if (repair.ok) {
      check = await checkSyntax(file.path, repair.content, repoDir);
      if (check.valid) {
        file.content = repair.content;
        file.explanation += ' [syntax error auto-repaired]';
        logger.info(`${file.path}: syntax repaired successfully`);
        continue;
      }
    }

    file.needsReview = true;
    file.confidence = 'low';
    file.explanation += ` [syntax check failed: ${check.error?.slice(0, 120)}]`;
  }
}

/**
 * Downgrade resolutions to needs-review when the learning loop has seen this
 * team override the same (file-type, method) category often enough. This is
 * what makes the bot stop repeating mistakes a given codebase punishes.
 */
function applyLearningGates(repo: string, resolvedFiles: ResolvedFile[]): void {
  for (const file of resolvedFiles) {
    if (file.needsReview) continue;
    const gate = getGate(repo, file.path, file.method ?? 'ai_judged');
    if (gate.forceReview) {
      file.needsReview = true;
      file.confidence = 'low';
      file.explanation += ` [${gate.reason}]`;
      logger.info(`${file.path}: learning gate forced manual review (override rate ${Math.round((gate.overrideRate ?? 0) * 100)}%)`);
    }
  }
}

function recordRunFiles(
  run: RunRecord,
  resolvedFiles: ResolvedFile[],
  autoApply: ResolvedFile[],
  dryRun: boolean
): void {
  const appliedSet = new Set(autoApply.map((f) => f.path));
  run.files = resolvedFiles.map((f) => ({
    path: f.path,
    method: f.method ?? 'ai_judged',
    confidence: f.confidence,
    applied: !dryRun && appliedSet.has(f.path),
    explanation: f.explanation.slice(0, 300),
  }));
}

export function classifyResolutions(
  resolvedFiles: ResolvedFile[],
  repoConfig: RepoConfig
): { autoApply: ResolvedFile[]; needsReview: ResolvedFile[] } {
  const levels = { high: 3, medium: 2, low: 1 };
  const minLevel = levels[repoConfig.autoApplyConfidenceThreshold];
  const autoApply: ResolvedFile[] = [];
  const needsReview: ResolvedFile[] = [];

  for (const file of resolvedFiles) {
    if (!file.needsReview && levels[file.confidence] >= minLevel) {
      autoApply.push(file);
    } else {
      needsReview.push(file);
    }
  }

  return { autoApply, needsReview };
}

function buildCommitMessage(pr: PRInfo, trigger: TriggerInfo, appliedFiles: ResolvedFile[]): string {
  const fileList = appliedFiles.map((f) => `  - ${f.path}`).join('\n');
  const cause =
    trigger.kind === 'merge'
      ? `Triggered by: ${trigger.prTitle} (#${trigger.prNumber}) merged by @${trigger.mergedBy}`
      : `Triggered by: /ai-merge command from @${trigger.requestedBy}`;
  return `fix: resolve merge conflicts with ${pr.baseRef}\n\nConflicted files resolved by AI:\n${fileList}\n\n${cause}`;
}
