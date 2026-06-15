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
4. **Truncation is rejected.** If a model response hits the output ceiling
   (Anthropic `stop_reason=max_tokens` / OpenAI `finish_reason=length`), the
   resolution is discarded — applying a truncated file would delete everything
   past the cutoff.
5. **Empty resolutions are rejected** for non-deletes.
6. **Binary files are never sent to the model** (NUL-byte detection) — flagged
   for manual resolution.
7. **Syntax gate + one AI repair** before commit; failures downgrade to review.
8. **`--force-with-lease`**: if the author pushed during resolution, git refuses
   the push and the run is recorded as a clean *skip*, not an error — their work
   is never overwritten.
9. **Everything lands as an ordinary commit on a PR branch** that a human
   reviews before merge.

## Concurrency: how many PRs at once?

- A merge into `main` can conflict with many open PRs. They are resolved with
  **bounded concurrency** (`PR_CONCURRENCY`, default 3) via `mapLimit` — never
  unbounded parallelism, which would exhaust disk/sockets and trip rate limits.
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
- **Right-sized `max_tokens`** — scaled to the file, not a flat 64k.
- **Oversize guard** — files too large to fit the output ceiling, or above
  `MAX_FILE_BYTES`, are flagged rather than sent (avoids paying for a call that
  is guaranteed to truncate).
- **`effort` tunable** (Anthropic) to trade thinking tokens for cost.
- **OpenAI 429/5xx retry** so a transient blip doesn't waste a call and bounce
  the PR to a human.

Known largest remaining lever (documented, not yet implemented):

- **Hunk-level resolution.** Today a one-line conflict in a 500-line file sends
  and regenerates the whole file. Resolving only the conflicted hunks (with
  surrounding context) and splicing them back into verbatim stable spans would
  cut output tokens ~60–90% on large files — and would *further* reduce the
  code-loss risk, since unchanged spans are copied, never regenerated. The
  current line-based segmenter is the foundation for this. It is deferred
  because it changes the model contract and needs its own careful test matrix.

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
- Diff-based verify/judge prompts (send hunks, not whole files).
