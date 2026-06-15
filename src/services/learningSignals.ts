import { getInstallationOctokit, compareCommitFiles } from './github';
import { getLastRunForPR } from './runHistory';
import {
  overriddenFiles,
  acceptedCandidates,
  applyOverrideSignals,
  applyAcceptanceSignals,
} from './learning';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

/**
 * Bridges GitHub webhook events to the learning loop. The pure scoring lives in
 * learning.ts; this layer fetches the GitHub context (what a human changed) and
 * records accept/override signals against the prior AI run for a PR.
 */

export interface HumanPushSignal {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  installationId: number;
  newHeadSha: string;
}

/**
 * A human (or any non-bot actor) pushed to a PR branch. If the bot had resolved
 * conflicts on this PR, figure out whether the push edited any of the files the
 * bot resolved — those are overrides — and feed them to the learning loop.
 */
export async function handleHumanPush(signal: HumanPushSignal): Promise<void> {
  if (!config.learning.enabled) return;

  const repo = `${signal.repoOwner}/${signal.repoName}`;
  const run = getLastRunForPR(repo, signal.prNumber);
  if (!run || !run.commitSha || run.superseded) return;
  if (run.outcome !== 'resolved' && run.outcome !== 'partial') return;
  if (run.commitSha === signal.newHeadSha) return; // no human commit on top yet

  // Mark superseded synchronously, BEFORE any await — a merge webhook could land
  // during the GitHub round-trip below and otherwise count this run as "accepted"
  // while we count it as "overridden", corrupting the learning rate. A human
  // pushed on top, so suppressing the acceptance signal is the correct call
  // regardless of which files they touched.
  run.superseded = true;
  run.learningSettled = true;

  const octokit = await getInstallationOctokit(signal.installationId);
  const changed = await compareCommitFiles(
    octokit,
    signal.repoOwner,
    signal.repoName,
    run.commitSha,
    signal.newHeadSha
  );
  if (changed.size === 0) return;

  const overridden = overriddenFiles(run, changed);
  if (overridden.length > 0) {
    applyOverrideSignals(repo, overridden); // run already marked superseded above
  }
}

/**
 * A PR merged. If the bot resolved it and a human didn't override the
 * resolution first, count those files as accepted — positive signal that keeps
 * the bot bold on categories it's trusted on.
 */
export function handleMergedForLearning(repoOwner: string, repoName: string, prNumber: number): void {
  if (!config.learning.enabled) return;

  const repo = `${repoOwner}/${repoName}`;
  const run = getLastRunForPR(repo, prNumber);
  if (!run || run.superseded || run.learningSettled) return;
  if (run.outcome !== 'resolved' && run.outcome !== 'partial') return;

  const accepted = applyAcceptanceSignals(repo, acceptedCandidates(run));
  run.learningSettled = true;
  if (accepted > 0) {
    logger.info(`Learning: recorded ${accepted} acceptance signal(s) for ${repo}#${prNumber} (merged)`);
  }
}
