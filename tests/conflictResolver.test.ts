// Shared mock state. `finalMessage` backs the Opus stream (proposals/repair);
// `create` backs the Haiku verifier and judge; `stream` is shared so tests can
// inspect the request args (e.g. max_tokens). Tests set responses per-case.
const mockFinalMessage = jest.fn();
const mockCreate = jest.fn();
const mockStream = jest.fn((_args?: { max_tokens?: number }) => ({ finalMessage: mockFinalMessage }));

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      stream: mockStream,
      create: mockCreate,
    },
  })),
}));

// Verifier approval / rejection and judge verdict helpers.
function verifyOk() {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, confidence: 'high', reason: 'looks correct' }) }] };
}
function verifyDoubt() {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, confidence: 'low', reason: 'unsure' }) }] };
}
function judgeWinnerA() {
  return { content: [{ type: 'text', text: JSON.stringify({ winner: 'A', reason: 'A is better', confidence: 'high' }) }] };
}

import { resolveConflicts, repairResolution } from '../src/services/conflictResolver';
import { ConflictedFile } from '../src/types';

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const ADDITIVE_FILE: ConflictedFile = {
  path: 'src/utils.ts',
  content: [
    '<<<<<<< HEAD',
    'function featureA() { return 1; }',
    '=======',
    'function featureB() { return 2; }',
    '>>>>>>> MERGE_HEAD',
  ].join('\n') + '\n',
};

const IMPORT_FILE: ConflictedFile = {
  path: 'src/app.ts',
  content: [
    '<<<<<<< HEAD',
    "import { useState } from 'react';",
    '=======',
    "import { useEffect } from 'react';",
    '>>>>>>> MERGE_HEAD',
  ].join('\n') + '\n',
};

const COMPLEX_FILE: ConflictedFile = {
  path: 'src/process.ts',
  content: [
    'function process(x: string) {',
    '<<<<<<< HEAD',
    '  return x.trim().toUpperCase();',
    '=======',
    '  return x.trim().toLowerCase();',
    '>>>>>>> MERGE_HEAD',
    '}',
  ].join('\n'),
};

function makeClaudeResponse(overrides: object) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        resolved_content: 'resolved content',
        is_delete: false,
        confidence: 'high',
        explanation: 'Resolved cleanly.',
        needs_review: false,
        ...overrides,
      }),
    }],
  };
}

// ─── Fast-path: no Claude calls ───────────────────────────────────────────────

describe('additive conflict fast-path', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('resolves without calling Claude', async () => {
    const results = await resolveConflicts([ADDITIVE_FILE], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].confidence).toBe('high');
    expect(results[0].content).toContain('featureA');
    expect(results[0].content).toContain('featureB');
  });

  it('result has no conflict markers', async () => {
    const results = await resolveConflicts([ADDITIVE_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].content).not.toMatch(/<<<<<<<|>>>>>>>/);
  });
});

describe('import-only conflict fast-path', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('resolves without calling Claude', async () => {
    const results = await resolveConflicts([IMPORT_FILE], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].confidence).toBe('high');
  });

  it('merges imports and deduplicates', async () => {
    const results = await resolveConflicts([IMPORT_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].content).toContain('useState');
    expect(results[0].content).toContain('useEffect');
    expect(results[0].content).not.toMatch(/<<<<<<<|>>>>>>>/);
  });
});

// ─── Complex conflicts: adaptive pipeline (default mode) ──────────────────────

describe('complex modify-modify conflict (adaptive)', () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
  });

  it('ships a single verified proposal with ONE Opus call (the efficiency win)', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'clean merge' }));
    mockCreate.mockResolvedValue(verifyOk());

    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    expect(mockFinalMessage).toHaveBeenCalledTimes(1); // one proposal, not two
    expect(mockCreate).toHaveBeenCalledTimes(1); // one cheap verify
    expect(results[0].method).toBe('ai_verified');
    expect(results[0].needsReview).toBe(false);
    expect(results[0].content).toBe('clean merge');
  });

  it('escalates to the second strategy when the verifier has doubts', async () => {
    mockFinalMessage
      .mockResolvedValueOnce(makeClaudeResponse({ resolved_content: 'A result' }))
      .mockResolvedValueOnce(makeClaudeResponse({ resolved_content: 'B result' }));
    mockCreate
      .mockResolvedValueOnce(verifyDoubt()) // verify A → escalate
      .mockResolvedValueOnce(judgeWinnerA()); // judge picks A

    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    expect(mockFinalMessage).toHaveBeenCalledTimes(2); // escalated to dual-strategy
    expect(results[0].method).toBe('ai_judged');
    expect(results[0].content).toBe('A result');
  });

  it('skips the judge when escalated proposals converge', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: 'identical result' }));
    mockCreate.mockResolvedValue(verifyDoubt()); // force escalation; A and B then converge

    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    expect(results[0].confidence).toBe('high');
    expect(results[0].method).toBe('ai_converged');
    expect(results[0].content).toBe('identical result');
  });

  it('caps output tokens to the file size rather than the 64k ceiling', async () => {
    mockStream.mockClear();
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({}));
    mockCreate.mockResolvedValue(verifyOk());

    await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');

    const maxTokens = mockStream.mock.calls[0][0]?.max_tokens ?? 0;
    expect(maxTokens).toBeLessThan(64_000);
    expect(maxTokens).toBeGreaterThanOrEqual(4_096);
  });

  it('falls back to needs_review on SDK error', async () => {
    mockFinalMessage.mockRejectedValue(new Error('API timeout'));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].confidence).toBe('low');
    expect(results[0].method).toBe('ai_failed');
  });
});

describe('edge-case guards', () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
  });

  it('flags binary/non-text files and never calls the model', async () => {
    const binary: ConflictedFile = { path: 'logo.png', content: 'PNG\u0000\u0000binary\u0000data here' };
    const results = await resolveConflicts([binary], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].method).toBe('binary');
    expect(results[0].needsReview).toBe(true);
  });

  it('rejects a truncated resolution rather than applying a partial file', async () => {
    // Proposal A truncated, then escalates; B also truncated → ai_failed.
    mockFinalMessage.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: JSON.stringify({ resolved_content: 'half a fi', confidence: 'high', explanation: 'x', needs_review: false }) }],
    });
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('ai_failed');
    expect(results[0].content).not.toBe('half a fi'); // truncated content never applied
  });

  it('rejects an empty resolved_content for a non-delete', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ resolved_content: '   ', is_delete: false }));
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('ai_failed');
  });

  it('never auto-applies a deletion from a single verified proposal (escalates instead)', async () => {
    // A says delete; even with a passing verifier it must escalate to dual-strategy.
    mockFinalMessage
      .mockResolvedValueOnce(makeClaudeResponse({ is_delete: true, resolved_content: '' }))
      .mockResolvedValueOnce(makeClaudeResponse({ is_delete: false, resolved_content: 'kept code' }));
    mockCreate.mockResolvedValue(verifyOk());
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).toHaveBeenCalledTimes(2); // escalated, did not ship the delete
    // A wants delete, B wants keep → disagreement → needs review, NOT deleted
    expect(results[0].needsReview).toBe(true);
    expect(results[0].isDelete).not.toBe(true);
  });

  it('only deletes when BOTH strategies independently agree to delete', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({ is_delete: true, resolved_content: '' }));
    mockCreate.mockResolvedValue(verifyOk());
    const results = await resolveConflicts([COMPLEX_FILE], 'feat', null, 'feat', 'main');
    expect(results[0].isDelete).toBe(true);
    expect(results[0].needsReview).toBe(false);
    expect(results[0].method).toBe('ai_converged');
  });
});

describe('lockfile conflicts', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('never sends lockfiles to Claude and flags them for regeneration', async () => {
    const lockfile: ConflictedFile = { path: 'package-lock.json', content: COMPLEX_FILE.content };
    const results = await resolveConflicts([lockfile], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('lockfile');
    expect(results[0].explanation).toContain('npm install');
  });
});

describe('oversized files', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('skips AI resolution above MAX_FILE_BYTES and flags for review', async () => {
    const bigBody = 'const filler = 1;\n'.repeat(20_000); // ~360 KB > 256 KB default cap
    const oversize: ConflictedFile = {
      path: 'src/huge.ts',
      content: bigBody + COMPLEX_FILE.content,
    };
    const results = await resolveConflicts([oversize], 'feat', null, 'feat', 'main');
    expect(mockFinalMessage).not.toHaveBeenCalled();
    expect(results[0].needsReview).toBe(true);
    expect(results[0].method).toBe('oversize');
    expect(results[0].explanation).toMatch(/too large/i);
  });
});

describe('repairResolution', () => {
  beforeEach(() => mockFinalMessage.mockReset());

  it('returns the repaired content when Claude fixes the syntax', async () => {
    mockFinalMessage.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ resolved_content: 'const fixed = true;' }) }],
    });
    const result = await repairResolution('src/x.ts', 'const broken = ;', 'Unexpected token');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('const fixed = true;');
  });

  it('returns ok=false with original content when the repair call fails', async () => {
    mockFinalMessage.mockRejectedValue(new Error('API down'));
    const result = await repairResolution('src/x.ts', 'const broken = ;', 'Unexpected token');
    expect(result.ok).toBe(false);
    expect(result.content).toBe('const broken = ;');
  });
});

describe('multiple files in one call', () => {
  beforeEach(() => {
    mockFinalMessage.mockReset();
    mockCreate.mockReset();
  });

  it('resolves all files and returns one result per file', async () => {
    mockFinalMessage.mockResolvedValue(makeClaudeResponse({}));
    mockCreate.mockResolvedValue(verifyOk());
    const results = await resolveConflicts(
      [ADDITIVE_FILE, IMPORT_FILE, COMPLEX_FILE],
      'feat', null, 'feat', 'main'
    );
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.path)).toEqual([
      'src/utils.ts',
      'src/app.ts',
      'src/process.ts',
    ]);
  });
});
