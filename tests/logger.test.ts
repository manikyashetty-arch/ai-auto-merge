import { Writable } from 'stream';
import winston from 'winston';
import { logger } from '../src/utils/logger';

/** Capture what the logger actually emits so we can assert on redaction. */
function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const transport = new winston.transports.Stream({ stream: sink });
  logger.add(transport);
  try {
    fn();
  } finally {
    logger.remove(transport);
  }
  return lines.join('\n');
}

describe('secret redaction', () => {
  it('redacts a git Basic auth header (the token leak from simple-git errors)', () => {
    const out = captureOutput(() =>
      logger.error('clone failed', { cmd: 'http.extraHeader=Authorization: Basic eHl6OnRva2VuMTIz' })
    );
    expect(out).not.toContain('eHl6OnRva2VuMTIz');
    expect(out).toMatch(/Authorization: Basic \[REDACTED\]/);
  });

  it('redacts API keys and GitHub tokens in nested error data', () => {
    const out = captureOutput(() =>
      logger.error('boom', { a: { b: 'key=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', c: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' } })
    );
    expect(out).not.toContain('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(out).toContain('[REDACTED');
  });
});

describe('logger', () => {
  it('exports a winston logger with the standard log methods', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('logs without throwing at every level', () => {
    expect(() => {
      logger.info('info-message');
      logger.warn('warn-message');
      logger.error('error-message');
      logger.debug('debug-message');
    }).not.toThrow();
  });

  it('serializes Error objects with stack', () => {
    const err = new Error('boom');
    expect(() => logger.error('caught', err)).not.toThrow();
  });
});
