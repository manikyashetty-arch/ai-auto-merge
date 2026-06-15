import { ConflictedFile } from '../types';

export type ConflictType = 'additive' | 'import_only' | 'delete_modify' | 'complex_modify' | 'lockfile';

// ─── Lockfile detection ────────────────────────────────────────────────────────
// Generated lockfiles should never be AI-merged: they have internal integrity
// hashes, and the correct resolution is always to regenerate from the merged
// manifest. Detecting them here skips the API call entirely.

const LOCKFILE_HINTS: Record<string, string> = {
  'package-lock.json': 'npm install --package-lock-only',
  'npm-shrinkwrap.json': 'npm install --package-lock-only',
  'yarn.lock': 'yarn install --mode update-lockfile',
  'pnpm-lock.yaml': 'pnpm install --lockfile-only',
  'bun.lockb': 'bun install',
  'bun.lock': 'bun install',
  'cargo.lock': 'cargo update --workspace',
  'poetry.lock': 'poetry lock --no-update',
  'uv.lock': 'uv lock',
  'pipfile.lock': 'pipenv lock',
  'composer.lock': 'composer update --lock',
  'gemfile.lock': 'bundle install',
  'go.sum': 'go mod tidy',
  'gradle.lockfile': 'gradle dependencies --write-locks',
  'packages.lock.json': 'dotnet restore --force-evaluate',
  'mix.lock': 'mix deps.get',
  'flake.lock': 'nix flake update',
};

export function isLockfile(filePath: string): boolean {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  return base in LOCKFILE_HINTS;
}

export function lockfileHint(filePath: string): string {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  const cmd = LOCKFILE_HINTS[base];
  return cmd
    ? `Checkout this branch, merge the base branch, then regenerate it with \`${cmd}\` and commit.`
    : 'Regenerate it from the merged manifest with your package manager instead of merging by hand.';
}

export interface ClassifiedConflict {
  file: ConflictedFile;
  type: ConflictType;
  blocks: ConflictBlock[];
}

export interface ConflictBlock {
  head: string[];
  base: string[];
}

// ─── Import line detection ─────────────────────────────────────────────────────

const IMPORT_PATTERNS = [
  /^import\s/,
  /^from\s+\S+\s+import/,
  /^const\s+\S+\s*=\s*require\s*\(/,
  /^use\s+[\w:]+/,
  /^#include\s/,
  /^using\s+\w+/,
  /^import\s+"[^"]+"/,
];

function isImportLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && IMPORT_PATTERNS.some((p) => p.test(t));
}

// ─── Named-entity extraction ───────────────────────────────────────────────────
// Returns the declared name if the line is a new top-level entity declaration,
// null otherwise.

const DECLARATION_PATTERNS: Array<RegExp> = [
  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|abstract\s+class)\s+(\w+)/,
  /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?:[:,=<(])/,
  /^def\s+(\w+)/,        // Python
  /^func\s+(\w+)/,       // Go
  /^fn\s+(\w+)/,         // Rust
  /^pub\s+fn\s+(\w+)/,   // Rust pub fn
  /^fun\s+(\w+)/,        // Kotlin
  /^sub\s+(\w+)/,        // Perl/VB
];

function extractDeclaredName(line: string): string | null {
  const trimmed = line.trim();
  for (const pattern of DECLARATION_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) return m[1];
  }
  return null;
}

// ─── Conflict segmentation ───────────────────────────────────────────────────
// One line-based parser, used by BOTH classification and the deterministic
// splicers, so they can never disagree on where a conflict starts/ends. It is
// CRLF-safe (markers detected on the \r-stripped line, original lines kept
// verbatim for reconstruction) and diff3-aware (the `|||||||` ancestor section
// is recognized; its presence forces the AI path). Git markers are exactly 7
// characters followed by end-of-line or whitespace — and a `=======` line only
// counts as a separator *inside* a conflict, so it never collides with a
// Markdown heading underline in ordinary text.

type Segment = { kind: 'text'; lines: string[] } | { kind: 'conflict'; head: string[]; base: string[] };

const RE_START = /^<{7}(?=$|\s)/;
const RE_ANCESTOR = /^\|{7}(?=$|\s)/;
const RE_SEP = /^={7}(?=$|\s)/;
const RE_END = /^>{7}(?=$|\s)/;

interface ParseResult {
  segments: Segment[];
  blocks: ConflictBlock[];
  hasAncestor: boolean;
  malformed: boolean;
}

function parseSegments(content: string): ParseResult {
  const lines = content.split('\n');
  const segments: Segment[] = [];
  const blocks: ConflictBlock[] = [];
  let hasAncestor = false;
  let malformed = false;

  let text: string[] = [];
  let head: string[] = [];
  let base: string[] = [];
  let state: 'text' | 'head' | 'ancestor' | 'base' = 'text';

  const flushText = () => {
    if (text.length) segments.push({ kind: 'text', lines: text });
    text = [];
  };

  for (const raw of lines) {
    const m = raw.replace(/\r$/, '');
    if (state === 'text') {
      if (RE_START.test(m)) {
        flushText();
        head = [];
        base = [];
        state = 'head';
      } else {
        text.push(raw);
      }
    } else if (state === 'head') {
      if (RE_ANCESTOR.test(m)) {
        hasAncestor = true;
        state = 'ancestor';
      } else if (RE_SEP.test(m)) {
        state = 'base';
      } else if (RE_END.test(m)) {
        malformed = true; // end marker before a separator
        state = 'text';
      } else {
        head.push(raw);
      }
    } else if (state === 'ancestor') {
      if (RE_SEP.test(m)) state = 'base';
      // ancestor (diff3 common base) lines are intentionally dropped
    } else if (state === 'base') {
      if (RE_END.test(m)) {
        segments.push({ kind: 'conflict', head, base });
        blocks.push({ head, base });
        state = 'text';
      } else {
        base.push(raw);
      }
    }
  }

  if (state !== 'text') malformed = true; // unterminated conflict
  flushText();
  return { segments, blocks, hasAncestor, malformed };
}

// ─── Conflict type classification ──────────────────────────────────────────────

function classifyBlocks(blocks: ConflictBlock[], isDeleteConflict: boolean): ConflictType {
  if (isDeleteConflict) return 'delete_modify';
  if (blocks.length === 0) return 'complex_modify';

  // Check: all conflict lines are import statements
  const allLines = blocks.flatMap((b) => [...b.head, ...b.base]).map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  if (allLines.length > 0 && allLines.every(isImportLine)) {
    return 'import_only';
  }

  // Check: every block looks like two different named entity declarations
  // (both sides adding new named things to the same spot → additive)
  const allAdditive = blocks.every((b) => {
    const headFirstLine = b.head.find((l) => l.trim());
    const baseFirstLine = b.base.find((l) => l.trim());
    if (!headFirstLine || !baseFirstLine) return false;

    const headName = extractDeclaredName(headFirstLine);
    const baseName = extractDeclaredName(baseFirstLine);

    // Both sides declare a new named entity, and the names are different
    return headName !== null && baseName !== null && headName !== baseName;
  });

  if (allAdditive) return 'additive';

  return 'complex_modify';
}

export function classify(file: ConflictedFile): ClassifiedConflict {
  const { blocks, hasAncestor, malformed } = parseSegments(file.content);
  let type: ConflictType;
  if (isLockfile(file.path)) {
    // Lockfiles take precedence over everything — even delete/modify conflicts
    // on a lockfile should be regenerated, not merged.
    type = 'lockfile';
  } else if (hasAncestor || malformed) {
    // diff3/zdiff3 conflicts and any malformed marker structure are genuine
    // three-way conflicts — never fast-path them; let the AI handle it.
    type = 'complex_modify';
  } else {
    type = classifyBlocks(blocks, file.isDeleteConflict ?? false);
  }
  return { file, type, blocks };
}

// ─── Deterministic resolvers ───────────────────────────────────────────────────
// Both reconstruct from segments, copying every non-conflict line verbatim — so
// surrounding code can never be dropped or reflowed, and CRLF / trailing-newline
// state is preserved.

function reconstruct(content: string, mergeConflict: (head: string[], base: string[]) => string[]): string {
  const { segments } = parseSegments(content);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'text') out.push(...seg.lines);
    else out.push(...mergeConflict(seg.head, seg.base));
  }
  return out.join('\n');
}

export function resolveAdditive(classified: ClassifiedConflict): string {
  return reconstruct(classified.file.content, (head, base) => [...head, ...base]);
}

export function resolveImports(classified: ClassifiedConflict): string {
  return reconstruct(classified.file.content, (head, base) => {
    const lines = [...head, ...base].map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
    return mergeImportLines(lines);
  });
}

// Merge JS/TS named imports from the same module; fall back to line-level dedup
// for other languages or import styles.
function mergeImportLines(lines: string[]): string[] {
  const namedByPath = new Map<string, Set<string>>();
  const others: string[] = [];

  for (const line of lines) {
    const m = line.match(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/);
    if (m) {
      const specifiers = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const modulePath = m[2];
      const existing = namedByPath.get(modulePath) ?? new Set();
      specifiers.forEach((s) => existing.add(s));
      namedByPath.set(modulePath, existing);
    } else {
      // Non-named import (default, namespace, non-JS) — deduplicate by exact line
      if (!others.includes(line)) others.push(line);
    }
  }

  const mergedNamed = [...namedByPath.entries()].map(
    ([modulePath, specifiers]) =>
      `import { ${[...specifiers].sort().join(', ')} } from '${modulePath}';`
  );

  return [...mergedNamed, ...others];
}
