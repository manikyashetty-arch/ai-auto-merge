import { buildErrorComment, buildReviewRequiredComment } from '../src/services/comments';
import { ResolvedFile, TriggerInfo } from '../src/types';

const mergeTrigger: TriggerInfo = {
  kind: 'merge', prNumber: 81, prTitle: 'Auth fix', baseRef: 'main', mergedBy: 'sahil',
};

const file = (over: Partial<ResolvedFile>): ResolvedFile => ({
  path: 'x.ts', content: 'x', confidence: 'high', explanation: 'ok', needsReview: false, ...over,
});

describe('buildErrorComment', () => {
  it('includes the failure reason so the PR says WHY it failed', () => {
    const out = buildErrorComment(mergeTrigger, 'OpenAI 400: max_tokens too large');
    expect(out).toMatch(/Failed/);
    expect(out).toContain('What went wrong');
    expect(out).toContain('max_tokens too large');
  });

  it('scrubs secrets out of the reason before posting (never leak a token into a PR)', () => {
    const leaky =
      'fatal: unable to access: Authorization: Basic c2VjcmV0 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const out = buildErrorComment(mergeTrigger, leaky);
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(out).not.toContain('Basic c2VjcmV0');
    expect(out).toMatch(/REDACTED/);
  });

  it('omits the reason block when no reason is given', () => {
    const out = buildErrorComment(mergeTrigger);
    expect(out).not.toContain('What went wrong');
  });
});

describe('buildReviewRequiredComment', () => {
  it('separates resolved files from the ones needing review, with the reason for each', () => {
    const files = [
      file({ path: 'backend/scripts/export_openapi.py', confidence: 'high', needsReview: false, explanation: 'Merged cleanly.' }),
      file({
        path: 'backend/routers/auth.py',
        confidence: 'low',
        needsReview: true,
        explanation: 'keep-both guard: resolution appears to drop the PR’s changes; flagged for review',
      }),
    ];
    const out = buildReviewRequiredComment(files, mergeTrigger);

    // The file needing review is listed WITH its reason.
    expect(out).toContain('Files requiring manual resolution');
    expect(out).toContain('auth.py');
    expect(out).toMatch(/keep-both guard.*drop the PR/);
    // The resolved file is shown as held-back (not silently lost).
    expect(out).toContain('held back');
    expect(out).toContain('export_openapi.py');
  });

  it('lists excluded paths as blockers with the reason', () => {
    const files = [file({ path: 'a.ts', needsReview: true, confidence: 'low', explanation: 'unsure' })];
    const out = buildReviewRequiredComment(files, mergeTrigger, undefined, ['migrations/001.sql']);
    expect(out).toContain('migrations/001.sql');
    expect(out).toMatch(/excluded by/i);
  });
});
