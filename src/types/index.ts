export interface PRInfo {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  body: string | null;
  url: string;
  author: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
}

export interface ConflictedFile {
  path: string;
  content: string;
  isDeleteConflict?: boolean;
}

/** How a file's resolution was produced — used for metrics & run history. */
export type ResolutionMethod =
  | 'fast_additive'
  | 'fast_imports'
  | 'lockfile'
  | 'oversize'
  | 'binary'
  | 'ai_verified'
  | 'ai_converged'
  | 'ai_judged'
  | 'ai_failed';

export interface ResolvedFile {
  path: string;
  content: string;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  needsReview: boolean;
  isDelete?: boolean;
  method?: ResolutionMethod;
}

export interface ResolutionResult {
  success: boolean;
  resolvedFiles: ResolvedFile[];
  failedFiles: string[];
  commitSha?: string;
  error?: string;
}

export interface MergedPREvent {
  prNumber: number;
  prTitle: string;
  headRef: string;
  baseRef: string;
  repoOwner: string;
  repoName: string;
  installationId: number;
  mergedAt: string;
  mergedBy: string;
}

/** Manual `/ai-merge` slash-command trigger from a PR comment. */
export interface ManualResolveEvent {
  prNumber: number;
  repoOwner: string;
  repoName: string;
  installationId: number;
  requestedBy: string;
  requestedAt: string;
  dryRunOverride?: boolean;
}

/** Discriminated queue payload — old Redis jobs without `type` are treated as 'merged'. */
export type QueueJobData =
  | ({ type?: 'merged' } & MergedPREvent)
  | ({ type: 'manual' } & ManualResolveEvent);

/** Why a resolution run happened — drives PR comment copy and run history. */
export type TriggerInfo =
  | { kind: 'merge'; prNumber: number; prTitle: string; baseRef: string; mergedBy: string }
  | { kind: 'manual'; requestedBy: string; baseRef: string };

export interface RepoConfig {
  enabled: boolean;
  autoApplyConfidenceThreshold: 'high' | 'medium' | 'low';
  maxFilesToAutoResolve: number;
  excludePaths: string[];
  dryRun: boolean;
  autoMergeOnCIPass: boolean;
}

// ─── Usage / cost accounting ───────────────────────────────────────────────────

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  apiCalls: number;
  costUsd: number;
}

export type RunOutcome =
  | 'resolved'
  | 'partial'
  | 'review_required'
  | 'dry_run'
  | 'no_conflicts'
  | 'skipped'
  | 'disabled'
  | 'error';

export interface RunFileRecord {
  path: string;
  method: ResolutionMethod;
  confidence: 'high' | 'medium' | 'low';
  applied: boolean;
  explanation: string;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl?: string;
  trigger: TriggerInfo;
  outcome?: RunOutcome;
  detail?: string;
  commitSha?: string;
  files: RunFileRecord[];
  usage: RunUsage;
  /** Set once a human override has been recorded against this run's resolution, so acceptance isn't also counted. */
  superseded?: boolean;
  /** Set once acceptance has been counted at merge, so it isn't double-counted. */
  learningSettled?: boolean;
}
