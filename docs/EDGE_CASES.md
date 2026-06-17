# Edge cases, correctness, and cost — design notes

How ai-auto-merge behaves at the edges, why, and where the guardrails are. This
is the reference for "will it ever do the wrong thing?" Most items here are
backed by tests; the high-severity ones were found in a multi-agent audit of the
codebase and fixed.

## The overriding principle: never silently lose or overwrite code

Every layer is designed so the worst realistic outcome is "flagged for a human,"
never "quietly wrong." The defenses, in order:

1. **Deterministic fast paths copy surrounding code verbatim.** Additive and
   import-only resolutions reconstruct the file from a single line-based parser,
   emitting every non-conflict line unchanged. They cannot reflow or drop code
   outside the conflict region. (`conflictClassifier.ts`)
1a. **Hunk-level AI resolution copies surrounding code verbatim too.** By default
   (`RESOLUTION_GRANULARITY=auto`) the model is sent only each conflict region
   plus a little context and returns only the replacement for that region; the
   bot splices it back into the **verbatim** stable spans (same parser as the
   fast paths). The untouched 99% of a file is never regenerated, so it cannot be
   reflowed or dropped — the edit-not-rewrite approach Cursor/Claude Code use. A
   replacement that still contains a conflict marker is rejected, and after
   splicing the assembled file is re-checked for markers. Falls back to
   whole-file resolution when markers can't be cleanly parsed (diff3/malformed).
2. **The conflict parser is CRLF- and diff3-aware.** Markers are matched on the
   `\r`-stripped line and must be exactly 7 characters + EOL/space. A `=======`
   line counts as a separator only *inside* a conflict, so Markdown underlines
   don't trip it. diff3/`zdiff3` conflicts (with a `|||||||` ancestor block) and
   any malformed/unterminated markers are **never fast-pathed** — they go to the
   AI path.
3. **Deletions require dual agreement.** An AI-asserted `is_delete` is never
   auto-applied from the single-proposal path (the cheap verifier trivially
   passes an empty file). Both independent strategies must agree to delete;
   otherwise it's flagged for review.
3a. **Keep-both backstop.** After every AI resolution, a deterministic check
   confirms the resolution did not verbatim-pick one side and drop the other.
   If the PR's (or the base's) distinctive lines were dropped wholesale, the
   resolution is downgraded to manual review instead of pushed — so the bot
   never silently overrides the PR author's code with the base branch (or vice
   versa). Calibrated to not false-flag legitimate same-line synthesis.
4. **Truncation is rejected.** If a model response hits the output ceiling
   (Anthropic `stop_reason=max_tokens` / OpenAI `finish_reason=length`), the
   resolution is discarded — applying a truncated file would delete everything
   past the cutoff.
5. **Empty resolutions are rejected** for non-deletes.
6. **Binary files are never sent to the model** (NUL-byte detection) — flagged
   for manual resolution.
6a. **Workflow files are flagged, not pushed.** A GitHub App cannot push to
   `.github/workflows/*` without the `workflows` permission, so attempting it
   would fail the push. By default those files are skipped (no AI tokens spent)
   and flagged for manual review with a clear reason. Set
   `ALLOW_WORKFLOW_FILES=true` only if you granted the App that permission.
7. **Syntax gate + one AI repair** before commit; failures downgrade to review.
7a. **Post-resolution steps can't corrupt a resolution.** Auto-formatting (Option 1)
   runs the repo's Prettier only on files the bot resolved, then re-validates the
   formatted output through the same syntax gate and **keeps the original on any
   problem** — Prettier output is committed only if it still parses. The optional
   `postResolve` command (Option 2) is off by default, read only from the base
   branch (a PR can't inject it), run with secrets scrubbed from its environment
   and under a timeout; if it exits non-zero or times out, **nothing is committed**
   and the PR is flagged for manual review — a broken command can never push
   half-generated output. (`postProcess.ts`)
8. **`--force-with-lease`**: if the author pushed during resolution, git refuses
   the push and the run is recorded as a clean *skip*, not an error — their work
   is never overwritten.
9. **Everything lands as an ordinary commit on a PR branch** that a human
   reviews before merge.

## Concurrency: how many PRs at once?

- A merge into `main` can conflict with many open PRs. They are resolved
  **sequentially by default** (`PR_CONCURRENCY=1`) — one PR fully resolved
  (clone → resolve → push) before the next. Predictable and gentle on rate
  limits. Raise `PR_CONCURRENCY` for parallelism on busy orgs; it's bounded via
  `mapLimit` either way, so a merge storm never fans out unbounded. Order does
  not affect correctness — each PR is resolved independently against the merged
  base.
- Each PR is **serialized against itself** by a per-PR async lock, so two
  triggers for the same PR (e.g. a merge plus a `/ai-merge`) never run two
  workspaces against one branch in a single process.
- Within a PR, files resolve with bounded concurrency (`FILE_CONCURRENCY`).
- **Cross-process caveat:** with Redis/BullMQ across multiple workers, the
  per-PR lock is process-local; `--force-with-lease` is the cross-process
  backstop that still prevents clobbering. For multi-worker deployments, a
  Redis lock keyed per PR is the recommended hardening.
- **Webhook redelivery** is deduplicated (in-process TTL map, or BullMQ
  `deduplication`) on both the merge and the `/ai-merge` paths.

## The bot never reacts to its own work

- Resolution triggers only on `pull_request.closed` (merged). The bot's own
  push to a PR branch is a `synchronize` event, which only feeds the learning
  loop — it never re-triggers resolution, so there's no self-resolution loop.
- The learning loop ignores `synchronize` events from a Bot sender and skips
  when the new head equals the bot's own resolution commit.

## Token and cost optimization

What's already in place:

- **Fast paths cost zero tokens** — additive, import-only, and lockfile
  conflicts are resolved or flagged without any model call.
- **Adaptive pipeline** — one resolution + a cheap verifier on the common case;
  the second full strategy + judge run only when the verifier has doubts. Roughly
  halves the expensive output versus always running two strategies.
- **Prompt caching** — the PR context (incl. the diff) is one cached block sent
  once per PR and read at ~10% thereafter; the file block caches across the two
  strategy calls. (Anthropic; OpenAI auto-caches stable prefixes server-side.)
- **Hunk-level resolution (default).** A one-line conflict in a 500-line file
  sends and regenerates only that line's region, not the whole file — output
  tokens drop ~60–90% on large files, because the unchanged bulk is spliced in
  verbatim, never regenerated. The per-hunk request is right-sized to the hunk
  (a small floor, not the file size), and the per-hunk pipeline reuses the same
  adaptive verify/escalate/judge logic. Set `RESOLUTION_GRANULARITY=file` to fall
  back to whole-file regeneration. (`hunkResolver.ts`)
- **Right-sized `max_tokens`** — every request is scaled to its unit (the hunk,
  or in whole-file mode the file), never a flat 64k.
- **Oversize guard** — a single conflicted file above `MAX_FILE_BYTES` is flagged
  rather than pulled into memory. In whole-file mode, a file too large to fit the
  model's output ceiling is also flagged up front (avoids a call guaranteed to
  truncate); hunk-level mode removes that ceiling entirely, since only the small
  conflict region is regenerated — so a large file with a small conflict now
  resolves instead of being flagged.
- **`effort` tunable** (Anthropic) to trade thinking tokens for cost.
- **OpenAI 429/5xx retry** so a transient blip doesn't waste a call and bounce
  the PR to a human.

## Security edges (see SECURITY.md for the full model)

- `.auto-merge.yml` is read from the **base branch**, never the PR head — a
  malicious PR cannot lower the bot's own confidence/auto-merge thresholds.
- Tokens are redacted from all logs (git errors carry the auth header).
- owner/repo/ref names are validated before reaching git; workspace paths are
  contained; symlinks are disabled at clone; syntax checkers run via `execFile`
  (no shell) on generated temp names.
- Fork PRs are skipped (the App can't and shouldn't push to forks).

## Outstanding hardening (tracked, lower priority)

- Redis-backed per-PR lock for multi-worker deployments.
- Coalesce/debounce a burst of merges into the same base to avoid O(N²)
  re-scans when many PRs auto-merge in sequence.
- Trim the PR diff to conflicted-file hunks (token saving, esp. on OpenAI).
