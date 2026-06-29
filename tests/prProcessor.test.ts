/**
 * Tests for prProcessor — focuses on the classifyResolutions logic
 * (confidence threshold filtering) which is the core business rule.
 */

// Prevent any real network calls
jest.mock('../src/services/github');
jest.mock('../src/services/gitOps');
jest.mock('../src/services/conflictResolver');
// Factory mocks (not auto-mocks): loading the real postProcess pulls in
// Prettier's internal dynamic import(), which jest's VM rejects.
jest.mock('../src/services/postProcess', () => ({
  formatResolutions: jest.fn(),
  runPostResolveHook: jest.fn(),
}));
jest.mock('../src/services/syntaxCheck', () => ({
  checkSyntax: jest.fn(),
}));

import { ResolvedFile, ManualResolveEvent, MergedPREvent } from '../src/types';
import { processManualResolve, processMergedPR } from '../src/services/prProcessor';
import * as github from '../src/services/github';
import * as gitOps from '../src/services/gitOps';
import * as conflictResolver from '../src/services/conflictResolver';
import * as postProcess from '../src/services/postProcess';
import * as syntaxCheck from '../src/services/syntaxCheck';

// Extract classifyResolutions by importing internals via a helper.
// We test it by driving processMergedPR and inspecting mock call arguments,
// OR we can expose it directly. Here we test via the classification outcome
// reflected in which files get passed to applyResolutions.

const makeFile = (
  path: string,
  confidence: 'high' | 'medium' | 'low',
  needsReview = false
): ResolvedFile => ({
  path,
  content: `resolved content of ${path}`,
  confidence,
  explanation: 'test',
  needsReview,
});

describe('confidence threshold classification', () => {
  // We replicate the classifyResolutions logic here to test it directly.
  // The function is private in prProcessor so we unit-test the logic inline.
  function classifyResolutions(
    resolvedFiles: ResolvedFile[],
    threshold: 'high' | 'medium' | 'low'
  ) {
    const levels = { high: 3, medium: 2, low: 1 };
    const minLevel = levels[threshold];
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

  it('threshold=high: only auto-applies high confidence files', () => {
    const files = [
      makeFile('a.ts', 'high'),
      makeFile('b.ts', 'medium'),
      makeFile('c.ts', 'low'),
    ];
    const { autoApply, needsReview } = classifyResolutions(files, 'high');
    expect(autoApply.map((f) => f.path)).toEqual(['a.ts']);
    expect(needsReview.map((f) => f.path)).toEqual(['b.ts', 'c.ts']);
  });

  it('threshold=medium: auto-applies high and medium confidence files', () => {
    const files = [
      makeFile('a.ts', 'high'),
      makeFile('b.ts', 'medium'),
      makeFile('c.ts', 'low'),
    ];
    const { autoApply, needsReview } = classifyResolutions(files, 'medium');
    expect(autoApply.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(needsReview.map((f) => f.path)).toEqual(['c.ts']);
  });

  it('threshold=low: auto-applies all files', () => {
    const files = [
      makeFile('a.ts', 'high'),
      makeFile('b.ts', 'medium'),
      makeFile('c.ts', 'low'),
    ];
    const { autoApply, needsReview } = classifyResolutions(files, 'low');
    expect(autoApply).toHaveLength(3);
    expect(needsReview).toHaveLength(0);
  });

  it('needsReview=true overrides confidence even at low threshold', () => {
    const files = [
      makeFile('a.ts', 'high', true), // flagged by AI
      makeFile('b.ts', 'high', false),
    ];
    const { autoApply, needsReview } = classifyResolutions(files, 'low');
    expect(autoApply.map((f) => f.path)).toEqual(['b.ts']);
    expect(needsReview.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('handles empty file list', () => {
    const { autoApply, needsReview } = classifyResolutions([], 'high');
    expect(autoApply).toHaveLength(0);
    expect(needsReview).toHaveLength(0);
  });
});

// ─── Partial-resolution policy (the PR #64 regression) ───────────────────────────
// When some conflicts resolve confidently but others are flagged, the flagged
// files stay unmerged and a merge commit cannot be created. The pipeline must
// abort and hand the PR to a human — never attempt the (impossible) partial
// commit. This drives the real processManualResolve flow with mocked I/O.
describe('all-or-nothing merge policy', () => {
  const mock = (fn: unknown) => fn as jest.Mock;

  function setup(resolved: ResolvedFile[]) {
    jest.clearAllMocks();
    mock(github.getInstallationOctokit).mockResolvedValue({}); // getRepoConfig falls back to defaults
    mock(github.getPRByNumber).mockResolvedValue({
      pr: {
        number: 64, title: 'PR', body: '', headRef: 'feature', baseRef: 'main',
        headSha: 'sha', url: 'http://x', repoOwner: 'o', repoName: 'r', installationId: 1,
      },
      state: 'open',
      isFork: false,
    });
    mock(github.getInstallationToken).mockResolvedValue('tok');
    mock(github.getPRDiff).mockResolvedValue('');
    mock(github.createCommitStatus).mockResolvedValue(undefined);
    mock(github.postComment).mockResolvedValue(undefined);
    mock(github.enableAutoMerge).mockResolvedValue(false);

    mock(gitOps.prepareConflictWorkspace).mockResolvedValue({
      ctx: { dir: '/tmp/fake', git: {}, cleanup: jest.fn().mockResolvedValue(undefined) },
      conflictedFiles: resolved.map((f) => ({ path: f.path, content: f.content })),
      remoteUrl: 'url',
    });
    mock(gitOps.applyResolutions).mockResolvedValue(undefined);
    mock(gitOps.commitAndPush).mockResolvedValue('newsha');
    mock(gitOps.abortMerge).mockResolvedValue(undefined);

    mock(conflictResolver.resolveConflicts).mockResolvedValue(resolved);
    mock(postProcess.formatResolutions).mockResolvedValue(undefined);
    mock(postProcess.runPostResolveHook).mockResolvedValue({ ok: true });
    mock(syntaxCheck.checkSyntax).mockResolvedValue({ valid: true });
  }

  const event: ManualResolveEvent = {
    prNumber: 64, repoOwner: 'o', repoName: 'r', installationId: 1,
    requestedBy: 'dev', requestedAt: '2026-06-26T00:00:00Z',
  };

  it('aborts (does NOT commit) when one file resolves but another needs review — the #64 case', async () => {
    setup([
      makeFile('backend/scripts/export_openapi.py', 'high', false),
      makeFile('backend/routers/auth.py', 'low', true), // preservation guard flagged it
    ]);

    await processManualResolve(event);

    // The crux: never attempt the impossible partial commit.
    expect(gitOps.commitAndPush).not.toHaveBeenCalled();
    expect(gitOps.applyResolutions).not.toHaveBeenCalled();
    // Instead, abort the merge and tell the human.
    expect(gitOps.abortMerge).toHaveBeenCalled();
    const comment = mock(github.postComment).mock.calls.at(-1)?.[4] as string;
    expect(comment).toMatch(/Manual Review Required/);
    expect(comment).toContain('auth.py');
  });

  it('commits when EVERY conflicted file resolves confidently', async () => {
    setup([
      makeFile('a.ts', 'high', false),
      makeFile('b.ts', 'high', false),
    ]);

    await processManualResolve(event);

    expect(gitOps.applyResolutions).toHaveBeenCalled();
    expect(gitOps.commitAndPush).toHaveBeenCalled();
    expect(gitOps.abortMerge).not.toHaveBeenCalled();
  });
});

// ─── Error feedback on the PR ────────────────────────────────────────────────────
// A merge-triggered run that errors previously posted NO comment (only a terse
// commit status), so the PR never said why it failed. It must now post an error
// comment — with the reason, scrubbed of secrets.
describe('error feedback', () => {
  const mock = (fn: unknown) => fn as jest.Mock;

  it('posts an explanatory comment (with scrubbed reason) when a merge-triggered run errors', async () => {
    jest.clearAllMocks();
    const pr = {
      number: 64, title: 'PR', body: '', headRef: 'feature', baseRef: 'main',
      headSha: 'sha', url: 'http://x', repoOwner: 'o', repoName: 'r', installationId: 1,
    };
    mock(github.getInstallationOctokit).mockResolvedValue({});
    mock(github.getOpenPRsWithConflicts).mockResolvedValue([pr]);
    mock(github.getInstallationToken).mockResolvedValue('tok');
    mock(github.getPRDiff).mockResolvedValue('');
    mock(github.createCommitStatus).mockResolvedValue(undefined);
    mock(github.postComment).mockResolvedValue(undefined);
    // Make the workspace prep blow up with a secret-bearing git error.
    mock(gitOps.prepareConflictWorkspace).mockRejectedValue(
      new Error('fatal: unable to access — ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    );

    const event: MergedPREvent = {
      prNumber: 81, prTitle: 'Auth fix', headRef: 'fix', baseRef: 'main',
      repoOwner: 'o', repoName: 'r', installationId: 1,
      mergedAt: '2026-06-26T00:00:00Z', mergedBy: 'sahil',
    };
    await processMergedPR(event); // swallows the per-PR error after reporting

    const comment = mock(github.postComment).mock.calls.at(-1)?.[4] as string;
    expect(comment).toBeDefined();
    expect(comment).toMatch(/Failed/);
    expect(comment).toContain('What went wrong');
    expect(comment).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'); // scrubbed
  });
});
