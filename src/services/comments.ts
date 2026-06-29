import { ResolvedFile, RunUsage, TriggerInfo } from '../types';
import { formatTokens, formatUsd, totalTokens } from '../utils/pricing';
import { scrubSecrets } from '../utils/logger';

/**
 * All PR comment bodies live here so prProcessor stays focused on flow.
 * Every comment is transparent about what happened, why, and what it cost.
 */

// This link appears in every comment the bot posts — point it at your fork
// if you run your own copy.
const PROJECT_URL = 'https://github.com/ArsenalAI-Official/ai-auto-merge';

const FOOTER_LINK = `*Powered by [ai-auto-merge](${PROJECT_URL}) — comment \`/ai-merge help\` for commands*`;

export function describeTrigger(trigger: TriggerInfo): string {
  if (trigger.kind === 'merge') {
    return `after **#${trigger.prNumber}** was merged into \`${trigger.baseRef}\` by @${trigger.mergedBy}`;
  }
  return `manually requested by @${trigger.requestedBy}`;
}

function usageLine(usage?: RunUsage): string[] {
  if (!usage || usage.apiCalls === 0) return [];
  const cached = usage.cacheReadTokens;
  const total = totalTokens(usage);
  const cachePct = total > 0 ? Math.round((cached / total) * 100) : 0;
  return [
    '',
    `<sub>${usage.apiCalls} Claude call${usage.apiCalls !== 1 ? 's' : ''} · ${formatTokens(total)} tokens (${cachePct}% cached) · est. ${formatUsd(usage.costUsd)}</sub>`,
  ];
}

export function buildSuccessComment(
  autoApplied: ResolvedFile[],
  needsReview: ResolvedFile[],
  excluded: string[],
  commitSha: string,
  trigger: TriggerInfo,
  usage?: RunUsage,
  autoMergeEnabled = false
): string {
  const lines = [
    `## 🤖 AI Merge Conflict Resolution`,
    ``,
    `Merge conflicts were automatically resolved ${describeTrigger(trigger)}.`,
    ``,
    `**Commit:** \`${commitSha.slice(0, 7)}\``,
    ``,
  ];

  if (autoApplied.length > 0) {
    lines.push(`### ✅ Auto-resolved (${autoApplied.length} file${autoApplied.length !== 1 ? 's' : ''})`);
    lines.push('');
    for (const f of autoApplied) {
      const deleteNote = f.isDelete ? ' *(deleted)*' : '';
      lines.push(`- \`${f.path}\`${deleteNote} *(${f.confidence} confidence)* — ${f.explanation}`);
    }
    lines.push('');
  }

  if (needsReview.length > 0) {
    lines.push(`### ⚠️ Needs human review (${needsReview.length} file${needsReview.length !== 1 ? 's' : ''})`);
    lines.push('');
    for (const f of needsReview) {
      lines.push(`- \`${f.path}\` *(${f.confidence} confidence)* — ${f.explanation}`);
    }
    lines.push('');
  }

  if (excluded.length > 0) {
    lines.push(`### ⏭️ Skipped (excluded by .auto-merge.yml)`);
    lines.push('');
    for (const p of excluded) lines.push(`- \`${p}\``);
    lines.push('');
  }

  if (autoMergeEnabled) {
    lines.push(`### 🚀 Auto-merge enabled`);
    lines.push('');
    lines.push('This PR will merge automatically once CI passes and required reviews are in.');
    lines.push('');
  }

  lines.push('---');
  lines.push(FOOTER_LINK);
  lines.push(...usageLine(usage));
  return lines.join('\n');
}

export function buildDryRunComment(
  resolvedFiles: ResolvedFile[],
  trigger: TriggerInfo,
  usage?: RunUsage
): string {
  const lines = [
    `## 🤖 AI Merge Conflict Resolution — Dry Run`,
    ``,
    `> **Dry-run mode.** The resolutions below are proposed but have NOT been pushed. Disable \`dryRun\` in \`.auto-merge.yml\` to let ai-auto-merge apply them automatically.`,
    ``,
    `Triggered ${describeTrigger(trigger)}.`,
    ``,
  ];

  for (const f of resolvedFiles) {
    lines.push(`### \`${f.path}\` *(${f.confidence} confidence)*`);
    lines.push(`${f.explanation}`);
    lines.push('');
    lines.push('```');
    lines.push(f.content.slice(0, 3000) + (f.content.length > 3000 ? '\n...(truncated)' : ''));
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push(FOOTER_LINK);
  lines.push(...usageLine(usage));
  return lines.join('\n');
}

export function buildReviewRequiredComment(
  resolvedFiles: ResolvedFile[],
  trigger: TriggerInfo,
  usage?: RunUsage,
  excludedPaths: string[] = []
): string {
  const needsReview = resolvedFiles.filter((f) => f.needsReview);
  const resolvable = resolvedFiles.filter((f) => !f.needsReview);

  const lines: string[] = [
    `## 🤖 AI Merge Conflict Resolution — Manual Review Required`,
    ``,
    `Attempted to resolve conflicts ${describeTrigger(trigger)}. A merge can only be pushed once **every** conflicted file resolves confidently, so nothing was pushed — the items below need a human.`,
    ``,
    `### Files requiring manual resolution`,
    ``,
  ];

  const blockers = [
    ...needsReview.map((f) => `- \`${f.path}\` *(${f.confidence})* — ${f.explanation}`),
    ...excludedPaths.map((p) => `- \`${p}\` — excluded by \`.auto-merge.yml\` (never auto-resolved)`),
  ];
  // Fallback so the section is never empty (e.g. defensive callers).
  lines.push(...(blockers.length ? blockers : resolvedFiles.map((f) => `- \`${f.path}\` *(${f.confidence})* — ${f.explanation}`)));

  if (resolvable.length) {
    lines.push(
      ``,
      `### Ready, but held back`,
      ``,
      `These resolved cleanly; they will apply once the file(s) above are sorted (a merge can't be completed partially):`,
      ``,
      ...resolvable.map((f) => `- \`${f.path}\` *(${f.confidence})* — ${f.explanation}`)
    );
  }

  lines.push(
    ``,
    `Resolve the flagged file(s) and push to this branch. After improving the PR description (Claude uses it for intent), you can retry the whole PR with \`/ai-merge resolve\`.`,
    ``,
    '---',
    FOOTER_LINK,
    ...usageLine(usage)
  );
  return lines.join('\n');
}

export function buildSkippedComment(reason: string, trigger: TriggerInfo): string {
  return [
    `## 🤖 AI Merge Conflict Resolution — Skipped`,
    ``,
    `Skipped automatic conflict resolution ${describeTrigger(trigger)}.`,
    ``,
    `**Reason:** ${reason}`,
    ``,
    `Please resolve conflicts manually.`,
    ``,
    '---',
    FOOTER_LINK,
  ].join('\n');
}

export function buildErrorComment(trigger: TriggerInfo, reason?: string): string {
  const lines = [
    `## 🤖 AI Merge Conflict Resolution — Failed`,
    ``,
    `An unexpected error occurred while resolving conflicts ${describeTrigger(trigger)}. The branch was left untouched — nothing was changed or pushed.`,
    ``,
  ];
  if (reason && reason.trim()) {
    // Scrub before showing: git errors can carry the auth header.
    lines.push(`**What went wrong:**`, '```', scrubSecrets(reason).trim().slice(0, 500), '```', ``);
  }
  lines.push(
    `This is often transient (a timeout or API hiccup). Retry with \`/ai-merge resolve\`; if it persists, check the ai-auto-merge server logs.`,
    ``,
    '---',
    FOOTER_LINK
  );
  return lines.join('\n');
}

export function buildStatusComment(input: {
  mergeable: boolean | null;
  enabled: boolean;
  dryRun: boolean;
  threshold: string;
  lastRunSummary?: string;
  queueSummary?: string;
}): string {
  const mergeableText =
    input.mergeable === null ? '⏳ still being computed by GitHub' : input.mergeable ? '✅ no conflicts' : '❌ has conflicts';
  const lines = [
    `## 🤖 ai-auto-merge status`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Mergeable | ${mergeableText} |`,
    `| Enabled for this repo | ${input.enabled ? 'yes' : 'no (`.auto-merge.yml`)'} |`,
    `| Mode | ${input.dryRun ? 'dry-run (propose only)' : 'auto-apply'} |`,
    `| Confidence threshold | \`${input.threshold}\` |`,
  ];
  if (input.queueSummary) lines.push(`| Queue | ${input.queueSummary} |`);
  if (input.lastRunSummary) lines.push(`| Last run on this PR | ${input.lastRunSummary} |`);
  lines.push('', '---', FOOTER_LINK);
  return lines.join('\n');
}

export function buildHelpComment(): string {
  return [
    `## 🤖 ai-auto-merge commands`,
    ``,
    `Comment any of these on a PR (requires write access):`,
    ``,
    `| Command | Effect |`,
    `|---|---|`,
    `| \`/ai-merge\` or \`/ai-merge resolve\` | Resolve this PR's conflicts with AI now |`,
    `| \`/ai-merge dry-run\` | Propose resolutions in a comment without pushing |`,
    `| \`/ai-merge status\` | Show conflict state and configuration for this PR |`,
    `| \`/ai-merge help\` | Show this message |`,
    ``,
    `Per-repo configuration lives in \`.auto-merge.yml\` — see the [example](${PROJECT_URL}/blob/main/.auto-merge.example.yml).`,
    ``,
    '---',
    FOOTER_LINK,
  ].join('\n');
}

export function buildPermissionDeniedComment(username: string): string {
  return `@${username} ⛔ \`/ai-merge\` commands require **write** access to this repository.`;
}
