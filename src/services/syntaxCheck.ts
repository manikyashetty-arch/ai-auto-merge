import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as ts from 'typescript';
import { logger } from '../utils/logger';

export interface SyntaxCheckResult {
  valid: boolean;
  error?: string;
}

// Require the angle-bracket markers (`<<<<<<< ` / `>>>>>>> `), which carry a
// trailing label and effectively never occur in real code or docs. We do NOT
// flag a lone `=======` line on its own — that collides with Markdown heading
// underlines and RST/AsciiDoc rules, and a genuine unresolved conflict always
// includes the angle-bracket markers anyway.
const CONFLICT_MARKER = /^(<{7}|>{7})[ \t]/m;

export async function checkSyntax(
  filePath: string,
  content: string,
  repoDir: string
): Promise<SyntaxCheckResult> {
  // Universal check: no leftover conflict markers
  if (CONFLICT_MARKER.test(content)) {
    return { valid: false, error: 'Unresolved conflict markers remain in file' };
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.ts' || ext === '.tsx') {
    return checkTypeScript(filePath, content);
  }

  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    return checkJavaScript(content);
  }

  if (ext === '.py') {
    return checkPython(filePath, content, repoDir);
  }

  if (ext === '.go') {
    return checkGo(filePath, content, repoDir);
  }

  // For other file types the conflict-marker check above is sufficient
  return { valid: true };
}

function checkTypeScript(filePath: string, content: string): SyntaxCheckResult {
  try {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // parseDiagnostics is populated by createSourceFile but not exposed in the public types
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const msg = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      });
      return { valid: false, error: msg.slice(0, 500) };
    }

    return { valid: true };
  } catch (err) {
    logger.debug(`TypeScript syntax check error for ${filePath}:`, err);
    return { valid: true }; // Don't block on checker failure
  }
}

function checkJavaScript(content: string): SyntaxCheckResult {
  try {
    // Use TypeScript parser in JS mode — catches most syntax errors
    const sourceFile = ts.createSourceFile(
      'check.js',
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      return { valid: false, error: 'JavaScript syntax error detected' };
    }
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

/**
 * Run an external checker against the RESOLVED content (the on-disk file still
 * holds conflict markers at this point). The content is written to a temp file
 * with a generated safe name and the checker is invoked via execFile — never a
 * shell — so repo-controlled file names can't inject commands.
 */
function checkViaTool(
  repoDir: string,
  ext: string,
  content: string,
  tool: string,
  buildArgs: (tmpFile: string) => string[],
  fallbackError: string
): SyntaxCheckResult {
  const tmpFile = path.join(repoDir, `.aam-syntax-${crypto.randomBytes(6).toString('hex')}${ext}`);
  try {
    fs.writeFileSync(tmpFile, content, 'utf-8');
    execFileSync(tool, buildArgs(tmpFile), { timeout: 10_000, stdio: 'pipe' });
    return { valid: true };
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer };
    if (e.code === 'ENOENT') {
      // Checker binary not installed on this host — don't block resolutions
      logger.debug(`${tool} not available, skipping syntax check`);
      return { valid: true };
    }
    return { valid: false, error: e.stderr?.toString().slice(0, 300) || fallbackError };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function checkPython(_filePath: string, content: string, repoDir: string): SyntaxCheckResult {
  return checkViaTool(repoDir, '.py', content, 'python3',
    (tmp) => ['-m', 'py_compile', tmp], 'Python syntax error');
}

function checkGo(_filePath: string, content: string, repoDir: string): SyntaxCheckResult {
  return checkViaTool(repoDir, '.go', content, 'gofmt', (tmp) => ['-e', tmp], 'Go syntax error');
}
