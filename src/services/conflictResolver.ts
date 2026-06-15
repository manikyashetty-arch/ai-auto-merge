import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { mapLimit } from '../utils/async';
import { recordUsage } from '../utils/pricing';
import { complete } from './llm';
import { ConflictedFile, ResolvedFile, RunUsage } from '../types';
import {
  classify,
  ConflictType,
  ClassifiedConflict,
  resolveAdditive,
  resolveImports,
  lockfileHint,
} from './conflictClassifier';
import {
  RESOLVER_SYSTEM,
  JUDGE_SYSTEM,
  REPAIR_SYSTEM,
  VERIFY_SYSTEM,
  STRATEGIES,
  ResolutionContext,
  buildPRContext,
  buildFileBlock,
  buildJudgePrompt,
  buildVerifyPrompt,
  buildRepairPrompt,
} from './prompts';

export { ResolutionContext } from './prompts';

/** How many files are resolved concurrently per PR (each file = 1-3 API calls). */
const FILE_CONCURRENCY = 3;

/**
 * Right-size the output ceiling to the file: a resolution is roughly the size
 * of the input, so there's no reason to allow 64k of output for a 50-line file.
 * Bounds worst-case cost and runaway generation. ~3 chars/token is a safe
 * overestimate for source code; +2k covers the JSON wrapper and thinking.
 */
function maxTokensFor(content: string): number {
  const estimate = Math.ceil(content.length / 3) + 2_000;
  return Math.min(64_000, Math.max(4_096, estimate));
}

// ─── Public entry point ────────────────────────────────────────────────────────

export async function resolveConflicts(
  conflictedFiles: ConflictedFile[],
  prTitle: string,
  prBody: string | null,
  prBranch: string,
  baseBranch: string,
  prDiff?: string,
  usage?: RunUsage
): Promise<ResolvedFile[]> {
  const context: ResolutionContext = { prTitle, prBody, prBranch, baseBranch, prDiff };
  // Built once: identical for every file, so it caches across the whole PR.
  const prContext = buildPRContext(context);
  return mapLimit(conflictedFiles, FILE_CONCURRENCY, (file) => resolveFile(file, prContext, usage));
}

async function resolveFile(
  file: ConflictedFile,
  prContext: string,
  usage?: RunUsage
): Promise<ResolvedFile> {
  const classified = classify(file);
  logger.info(`${file.path}: conflict type = ${classified.type}`);

  switch (classified.type) {
    case 'lockfile':
      return {
        path: file.path,
        content: file.content,
        confidence: 'low',
        explanation: `Generated lockfile — never AI-merged. ${lockfileHint(file.path)}`,
        needsReview: true,
        method: 'lockfile',
      };

    case 'additive':
      return fastResolve(classified, 'additive', resolveAdditive(classified),
        'Additive conflict: both branches added non-overlapping code — merged both.');

    case 'import_only':
      return fastResolve(classified, 'import_only', resolveImports(classified),
        'Import-only conflict: merged and deduplicated import statements.');

    case 'delete_modify':
    case 'complex_modify': {
      const bytes = Buffer.byteLength(file.content, 'utf-8');
      if (bytes > config.settings.maxFileBytes) {
        const kb = Math.round(bytes / 1024);
        const capKb = Math.round(config.settings.maxFileBytes / 1024);
        return {
          path: file.path,
          content: file.content,
          confidence: 'low',
          explanation: `File too large for AI resolution (${kb} KB > ${capKb} KB cap, MAX_FILE_BYTES). Resolve manually.`,
          needsReview: true,
          method: 'oversize',
        };
      }
      return resolveWithAI(classified, prContext, usage);
    }
  }
}

function fastResolve(
  classified: ClassifiedConflict,
  type: ConflictType,
  content: string,
  explanation: string
): ResolvedFile {
  logger.debug(`${classified.file.path}: fast-path resolved (${type})`);
  return {
    path: classified.file.path,
    content,
    confidence: 'high',
    explanation,
    needsReview: false,
    method: type === 'additive' ? 'fast_additive' : 'fast_imports',
  };
}

// ─── Multi-proposal pipeline ───────────────────────────────────────────────────

interface Proposal {
  id: 'A' | 'B';
  content: string;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  needs_review: boolean;
  is_delete: boolean;
}

/**
 * Adaptive resolution. The default mode runs ONE proposal and a cheap verifier,
 * escalating to the full dual-strategy + judge only when the verifier has
 * doubts — which keeps an independent cross-check on every resolution while
 * cutting the expensive second full-file generation on the common case.
 * `thorough` mode always runs both strategies + judge.
 */
async function resolveWithAI(
  classified: ClassifiedConflict,
  prContext: string,
  usage?: RunUsage
): Promise<ResolvedFile> {
  const file = classified.file;

  const proposalA = await runProposal(classified, prContext, STRATEGIES[0], usage);

  if (config.llm.resolutionMode === 'adaptive' && !proposalA.needs_review) {
    const verdict = await verifyProposal(file, proposalA.content, usage);
    if (verdict.ok && verdict.confidence !== 'low' && proposalA.confidence !== 'low') {
      logger.debug(`${file.path}: single proposal verified (${verdict.confidence}) — shipping`);
      return {
        path: file.path,
        content: proposalA.content,
        confidence: lowerOf(proposalA.confidence, verdict.confidence),
        explanation: `${proposalA.explanation} (independently verified: ${verdict.reason})`,
        needsReview: false,
        isDelete: proposalA.is_delete,
        method: 'ai_verified',
      };
    }
    logger.debug(`${file.path}: verification inconclusive (${verdict.reason}) — escalating to dual-strategy`);
  }

  // Escalation (or thorough mode): run the second strategy and reconcile A vs B.
  const proposalB = await runProposal(classified, prContext, STRATEGIES[1], usage);
  return reconcile(file, proposalA, proposalB, usage);
}

/** Existing dual-strategy reconciliation: convergence → judge → winner. */
async function reconcile(
  file: ClassifiedConflict['file'],
  proposalA: Proposal,
  proposalB: Proposal,
  usage?: RunUsage
): Promise<ResolvedFile> {
  if (proposalA.needs_review && proposalB.needs_review) {
    return {
      path: file.path,
      content: file.content,
      confidence: 'low',
      explanation: `Both resolution proposals failed: ${proposalA.explanation}`,
      needsReview: true,
      method: 'ai_failed',
    };
  }

  // If proposals converge on the same content, we're confident — no judge needed
  if (proposalA.content.trim() === proposalB.content.trim()) {
    logger.debug(`${file.path}: proposals converged — high confidence`);
    return {
      path: file.path,
      content: proposalA.content,
      confidence: 'high',
      explanation: `${proposalA.explanation} (confirmed by independent synthesis)`,
      needsReview: false,
      isDelete: proposalA.is_delete,
      method: 'ai_converged',
    };
  }

  const judgment = await judgeProposals(file, proposalA, proposalB, usage);

  if (judgment.winner === 'neither') {
    return {
      path: file.path,
      content: file.content,
      confidence: 'low',
      explanation: `Both proposals rejected by judge: ${judgment.reason}`,
      needsReview: true,
      method: 'ai_failed',
    };
  }

  const winner = judgment.winner === 'A' ? proposalA : proposalB;
  const winnerLabel = judgment.winner === 'A' ? 'conservative' : 'synthesis';
  const loserLabel = judgment.winner === 'A' ? 'synthesis' : 'conservative';

  return {
    path: file.path,
    content: winner.content,
    confidence: judgment.confidence,
    explanation: `${winner.explanation} (${winnerLabel} strategy preferred over ${loserLabel}: ${judgment.reason})`,
    needsReview: judgment.confidence === 'low' || winner.needs_review,
    isDelete: winner.is_delete,
    method: 'ai_judged',
  };
}

function lowerOf(a: 'high' | 'medium' | 'low', b: 'high' | 'medium' | 'low'): 'high' | 'medium' | 'low' {
  const rank = { high: 3, medium: 2, low: 1 };
  return rank[a] <= rank[b] ? a : b;
}

async function runProposal(
  classified: ClassifiedConflict,
  prContext: string,
  strategy: (typeof STRATEGIES)[number],
  usage?: RunUsage
): Promise<Proposal> {
  const { file } = classified;

  try {
    const result = await complete({
      system: RESOLVER_SYSTEM,
      maxTokens: maxTokensFor(file.content),
      tier: 'resolve',
      blocks: [
        // PR context is identical across all files → caches for the whole PR.
        ...(prContext ? [{ text: prContext, cacheable: true }] : []),
        // The file block is identical across both strategies → caches per file.
        { text: buildFileBlock(file), cacheable: true },
        // Only the strategy instruction varies per call.
        { text: `${strategy.instruction}\n\nReturn JSON only.` },
      ],
    });

    recordUsage(usage, result.model, result.usage);
    metrics.claudeCalls.inc({ model: result.model, outcome: 'ok' });

    const parsed = parseResolverResponse(result.text);
    return {
      id: strategy.id,
      content: parsed.resolved_content,
      is_delete: parsed.is_delete ?? false,
      confidence: parsed.confidence,
      explanation: parsed.explanation,
      needs_review: parsed.needs_review,
    };
  } catch (err) {
    metrics.claudeCalls.inc({ model: config.llm.provider, outcome: 'error' });
    logger.warn(`${file.path}: ${strategy.label} proposal failed:`, err);
    return {
      id: strategy.id,
      content: file.content,
      confidence: 'low',
      explanation: `${strategy.label} proposal failed: ${err instanceof Error ? err.message : String(err)}`,
      needs_review: true,
      is_delete: false,
    };
  }
}

/**
 * Cheap single-proposal verifier (judge model). On any failure it returns
 * ok=false so the caller escalates to the full dual-strategy path — a failed
 * verification must never be mistaken for approval.
 */
async function verifyProposal(
  file: ConflictedFile,
  proposedContent: string,
  usage?: RunUsage
): Promise<{ ok: boolean; confidence: 'high' | 'medium' | 'low'; reason: string }> {
  try {
    const result = await complete({
      system: VERIFY_SYSTEM,
      maxTokens: 512,
      tier: 'judge',
      blocks: [{ text: buildVerifyPrompt(file, proposedContent) }],
    });
    recordUsage(usage, result.model, result.usage);
    metrics.claudeCalls.inc({ model: result.model, outcome: 'ok' });
    return parseVerifyResponse(result.text);
  } catch (err) {
    metrics.claudeCalls.inc({ model: config.llm.provider, outcome: 'error' });
    logger.warn(`${file.path}: verification failed, will escalate:`, err);
    return { ok: false, confidence: 'low', reason: 'verifier unavailable' };
  }
}

async function judgeProposals(
  file: ConflictedFile,
  proposalA: Proposal,
  proposalB: Proposal,
  usage?: RunUsage
): Promise<{ winner: 'A' | 'B' | 'neither'; reason: string; confidence: 'high' | 'medium' | 'low' }> {
  try {
    const result = await complete({
      system: JUDGE_SYSTEM,
      maxTokens: 1024,
      tier: 'judge',
      blocks: [{ text: buildJudgePrompt(file, proposalA.content, proposalB.content) }],
    });
    recordUsage(usage, result.model, result.usage);
    metrics.claudeCalls.inc({ model: result.model, outcome: 'ok' });

    const parsed = parseJudgeResponse(result.text);
    logger.debug(`${file.path}: judge picked ${parsed.winner} (${parsed.confidence}) — ${parsed.reason}`);
    return parsed;
  } catch (err) {
    metrics.claudeCalls.inc({ model: config.llm.provider, outcome: 'error' });
    logger.warn(`${file.path}: judge failed, defaulting to conservative:`, err);
    return { winner: 'A', reason: 'Judge unavailable, defaulting to conservative', confidence: 'medium' };
  }
}

// ─── Syntax repair ─────────────────────────────────────────────────────────────

/**
 * One-shot repair when a resolved file fails the syntax check: feed the error
 * back to the model and ask for a minimal fix. Returns ok=false if the repair
 * call itself fails — the caller decides whether to downgrade the file.
 */
export async function repairResolution(
  filePath: string,
  brokenContent: string,
  syntaxError: string,
  usage?: RunUsage
): Promise<{ ok: boolean; content: string }> {
  try {
    const result = await complete({
      system: REPAIR_SYSTEM,
      maxTokens: maxTokensFor(brokenContent),
      tier: 'resolve',
      blocks: [{ text: buildRepairPrompt(filePath, brokenContent, syntaxError) }],
    });
    recordUsage(usage, result.model, result.usage);
    metrics.claudeCalls.inc({ model: result.model, outcome: 'ok' });

    const json = extractJson(result.text) as { resolved_content?: unknown };
    if (typeof json?.resolved_content !== 'string' || json.resolved_content.length === 0) {
      throw new Error('Repair response missing resolved_content');
    }
    return { ok: true, content: json.resolved_content };
  } catch (err) {
    metrics.claudeCalls.inc({ model: config.llm.provider, outcome: 'error' });
    logger.warn(`${filePath}: syntax repair failed:`, err);
    return { ok: false, content: brokenContent };
  }
}

// ─── Response parsers ──────────────────────────────────────────────────────────

interface RawResolverResponse {
  resolved_content: string;
  is_delete: boolean;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  needs_review: boolean;
}

function parseResolverResponse(text: string): RawResolverResponse {
  const json = extractJson(text);
  if (!isValidResolverResponse(json)) {
    throw new Error('Claude response missing required fields');
  }
  return json;
}

function isValidResolverResponse(obj: unknown): obj is RawResolverResponse {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.resolved_content === 'string' &&
    (r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low') &&
    typeof r.explanation === 'string' &&
    typeof r.needs_review === 'boolean'
  );
}

function parseVerifyResponse(text: string): { ok: boolean; confidence: 'high' | 'medium' | 'low'; reason: string } {
  // Default to ok=false (escalate) on anything unparseable — never approve by accident.
  let json: { ok?: unknown; confidence?: unknown; reason?: unknown };
  try {
    json = extractJson(text) as typeof json;
  } catch {
    return { ok: false, confidence: 'low', reason: 'could not parse verifier response' };
  }
  return {
    ok: json.ok === true,
    confidence: ['high', 'medium', 'low'].includes(json.confidence as string)
      ? (json.confidence as 'high' | 'medium' | 'low')
      : 'low',
    reason: typeof json.reason === 'string' ? json.reason : '',
  };
}

function parseJudgeResponse(text: string): { winner: 'A' | 'B' | 'neither'; reason: string; confidence: 'high' | 'medium' | 'low' } {
  const json = extractJson(text) as { winner?: string; reason?: string; confidence?: string };
  if (!json || !['A', 'B', 'neither'].includes(json.winner ?? '')) {
    return { winner: 'A', reason: 'Could not parse judge response', confidence: 'medium' };
  }
  return {
    winner: json.winner as 'A' | 'B' | 'neither',
    reason: json.reason ?? '',
    confidence: ['high', 'medium', 'low'].includes(json.confidence ?? '')
      ? (json.confidence as 'high' | 'medium' | 'low')
      : 'medium',
  };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = text.match(/(\{[\s\S]*\})/);
  const jsonStr = fenced?.[1] ?? raw?.[1];
  if (!jsonStr) throw new Error('No JSON found in response');
  return JSON.parse(jsonStr);
}
