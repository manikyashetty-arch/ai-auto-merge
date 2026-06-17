// Prettier is mocked so format tests are deterministic; checkSyntax is mocked so
// we can drive the re-validation guard. The hook tests use REAL subprocesses.
jest.mock('prettier', () => ({
  getFileInfo: jest.fn(async (fp: string) => ({
    ignored: false,
    inferredParser: fp.endsWith('.bin') ? null : 'typescript',
  })),
  resolveConfig: jest.fn(async () => ({ semi: true, singleQuote: true })),
  format: jest.fn(async (content: string) => `${content} /*FMT*/`),
}));
jest.mock('../src/services/syntaxCheck', () => ({
  checkSyntax: jest.fn(async () => ({ valid: true })),
}));

import * as prettier from 'prettier';
import { checkSyntax } from '../src/services/syntaxCheck';
import { formatResolutions, runPostResolveHook } from '../src/services/postProcess';
import { ResolvedFile, RepoConfig } from '../src/types';

const mockedFormat = prettier.format as jest.Mock;
const mockedGetFileInfo = prettier.getFileInfo as jest.Mock;
const mockedCheckSyntax = checkSyntax as jest.Mock;

function cfg(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    enabled: true,
    autoApplyConfidenceThreshold: 'high',
    maxFilesToAutoResolve: 20,
    excludePaths: [],
    dryRun: false,
    autoMergeOnCIPass: false,
    format: true,
    postResolve: null,
    postResolveTimeoutSec: 180,
    ...over,
  };
}

function file(over: Partial<ResolvedFile> = {}): ResolvedFile {
  return {
    path: 'src/a.ts',
    content: 'const x = 1;',
    confidence: 'high',
    explanation: 'ok',
    needsReview: false,
    method: 'ai_hunk',
    ...over,
  };
}

describe('formatResolutions (Option 1: auto-format)', () => {
  beforeEach(() => {
    mockedFormat.mockClear().mockImplementation(async (content: string) => `${content} /*FMT*/`);
    mockedGetFileInfo.mockClear().mockImplementation(async (fp: string) => ({
      ignored: false,
      inferredParser: fp.endsWith('.bin') ? null : 'typescript',
    }));
    mockedCheckSyntax.mockClear().mockResolvedValue({ valid: true });
  });

  it('formats an eligible resolved file in place', async () => {
    const f = file();
    await formatResolutions('/repo', [f], cfg());
    expect(mockedFormat).toHaveBeenCalledTimes(1);
    expect(f.content).toBe('const x = 1; /*FMT*/');
  });

  it('does nothing when format is disabled (never calls prettier)', async () => {
    const f = file();
    await formatResolutions('/repo', [f], cfg({ format: false }));
    expect(mockedFormat).not.toHaveBeenCalled();
    expect(f.content).toBe('const x = 1;');
  });

  it('skips files flagged for review, deletes, and non-resolved methods', async () => {
    const review = file({ path: 'r.ts', needsReview: true });
    const del = file({ path: 'd.ts', isDelete: true });
    const lock = file({ path: 'package-lock.json', method: 'lockfile', needsReview: true });
    const wf = file({ path: 'w.yml', method: 'workflow', needsReview: true });
    await formatResolutions('/repo', [review, del, lock, wf], cfg());
    expect(mockedFormat).not.toHaveBeenCalled();
  });

  it('formats fast-path resolutions too', async () => {
    const f = file({ method: 'fast_additive' });
    await formatResolutions('/repo', [f], cfg());
    expect(f.content).toBe('const x = 1; /*FMT*/');
  });

  it('respects .prettierignore and unknown file types (leaves content untouched)', async () => {
    mockedGetFileInfo.mockResolvedValueOnce({ ignored: true, inferredParser: 'typescript' });
    const ignored = file({ path: 'vendor/a.ts' });
    await formatResolutions('/repo', [ignored], cfg());
    expect(ignored.content).toBe('const x = 1;');

    const binary = file({ path: 'logo.bin', content: 'rawbytes' }); // inferredParser null
    await formatResolutions('/repo', [binary], cfg());
    expect(binary.content).toBe('rawbytes');
    expect(mockedFormat).not.toHaveBeenCalled();
  });

  it('KEEPS THE ORIGINAL when the formatted output fails re-validation (never commits worse code)', async () => {
    mockedCheckSyntax.mockResolvedValueOnce({ valid: false, error: 'broken' });
    const f = file();
    await formatResolutions('/repo', [f], cfg());
    expect(f.content).toBe('const x = 1;'); // unchanged — formatted output rejected
  });

  it('keeps the original (and never throws) when prettier throws', async () => {
    mockedFormat.mockRejectedValueOnce(new Error('parse error'));
    const f = file();
    await expect(formatResolutions('/repo', [f], cfg())).resolves.toBeUndefined();
    expect(f.content).toBe('const x = 1;');
  });

  it('never blanks a file even if prettier returns empty', async () => {
    mockedFormat.mockResolvedValueOnce('');
    const f = file();
    await formatResolutions('/repo', [f], cfg());
    expect(f.content).toBe('const x = 1;');
  });

  it('does not re-validate when formatting is a no-op (output identical)', async () => {
    mockedFormat.mockResolvedValueOnce('const x = 1;'); // identical to input
    const f = file();
    await formatResolutions('/repo', [f], cfg());
    expect(mockedCheckSyntax).not.toHaveBeenCalled();
    expect(f.content).toBe('const x = 1;');
  });
});

describe('runPostResolveHook (Option 2: opt-in command, fail-safe)', () => {
  it('returns ok immediately when no command is configured (no subprocess)', async () => {
    expect(await runPostResolveHook('/tmp', cfg({ postResolve: null }))).toEqual({ ok: true });
  });

  it('returns ok on a successful command (exit 0)', async () => {
    const res = await runPostResolveHook('/tmp', cfg({ postResolve: 'exit 0' }));
    expect(res.ok).toBe(true);
  });

  it('returns not-ok with the exit code and output on failure', async () => {
    const res = await runPostResolveHook('/tmp', cfg({ postResolve: 'echo boom >&2; exit 3' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exited 3/);
    expect(res.error).toMatch(/boom/);
  });

  it('kills and fails the hook on timeout', async () => {
    const res = await runPostResolveHook('/tmp', cfg({ postResolve: 'sleep 5', postResolveTimeoutSec: 0.2 }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/);
  });

  it('scrubs secrets from the command environment but keeps PATH', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    process.env.GITHUB_PRIVATE_KEY = 'pk-should-not-leak';
    process.env.SOME_WEBHOOK_SECRET = 'whatever';
    try {
      const res = await runPostResolveHook(
        '/tmp',
        cfg({ postResolve: 'test -z "$OPENAI_API_KEY" && test -z "$GITHUB_PRIVATE_KEY" && test -z "$SOME_WEBHOOK_SECRET" && test -n "$PATH"' })
      );
      expect(res.ok).toBe(true); // all secrets empty in the child, PATH present
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.GITHUB_PRIVATE_KEY;
      delete process.env.SOME_WEBHOOK_SECRET;
    }
  });

  it('runs the command in the given working directory', async () => {
    const res = await runPostResolveHook(process.cwd(), cfg({ postResolve: 'test -f package.json' }));
    expect(res.ok).toBe(true);
  });
});
