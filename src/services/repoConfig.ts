import type { Octokit } from '@octokit/rest';
import * as yaml from 'js-yaml';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { RepoConfig } from '../types';

const CONFIG_PATH = '.auto-merge.yml';

const DEFAULT_CONFIG: RepoConfig = {
  enabled: true,
  autoApplyConfidenceThreshold: config.settings.autoApplyConfidenceThreshold,
  maxFilesToAutoResolve: config.settings.maxFilesToAutoResolve,
  excludePaths: [],
  dryRun: false,
  autoMergeOnCIPass: config.settings.autoMergeOnCIPass,
  format: config.settings.formatResolved,
  postResolve: null,
  postResolveTimeoutSec: config.settings.postResolveTimeoutSec,
};

const POST_RESOLVE_TIMEOUT_MIN = 10;
const POST_RESOLVE_TIMEOUT_MAX = 1800;

/** A postResolve command must be a non-empty string; anything else disables it. */
function parsePostResolve(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseTimeout(value: unknown): number {
  const n = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.postResolveTimeoutSec;
  return Math.max(POST_RESOLVE_TIMEOUT_MIN, Math.min(POST_RESOLVE_TIMEOUT_MAX, Math.floor(n)));
}

export async function getRepoConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<RepoConfig> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: CONFIG_PATH,
      ref,
    });

    if ('content' in data && data.encoding === 'base64') {
      const raw = Buffer.from(data.content, 'base64').toString('utf-8');
      const parsed = yaml.load(raw) as Partial<RepoConfig>;
      return mergeWithDefaults(parsed);
    }
  } catch (err) {
    if ((err as { status?: number })?.status === 404) {
      logger.debug(`No ${CONFIG_PATH} in ${owner}/${repo}, using defaults`);
    } else {
      logger.warn(`Could not read ${CONFIG_PATH} from ${owner}/${repo}:`, err);
    }
  }

  return { ...DEFAULT_CONFIG };
}

function mergeWithDefaults(parsed: Partial<RepoConfig>): RepoConfig {
  return {
    enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
    autoApplyConfidenceThreshold:
      parsed.autoApplyConfidenceThreshold ?? DEFAULT_CONFIG.autoApplyConfidenceThreshold,
    maxFilesToAutoResolve:
      parsed.maxFilesToAutoResolve ?? DEFAULT_CONFIG.maxFilesToAutoResolve,
    excludePaths: Array.isArray(parsed.excludePaths) ? parsed.excludePaths : [],
    dryRun: parsed.dryRun ?? DEFAULT_CONFIG.dryRun,
    autoMergeOnCIPass: parsed.autoMergeOnCIPass ?? DEFAULT_CONFIG.autoMergeOnCIPass,
    format: typeof parsed.format === 'boolean' ? parsed.format : DEFAULT_CONFIG.format,
    postResolve: parsePostResolve(parsed.postResolve),
    postResolveTimeoutSec: parseTimeout(parsed.postResolveTimeoutSec),
  };
}
