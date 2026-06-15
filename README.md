# ai-auto-merge

Automatically resolve merge conflicts in open pull requests using Claude, the moment another PR lands on the base branch — then optionally merge them when CI passes. Self-hosted, model-agnostic, and the only resolver that learns from your team's corrections.

[![CI](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/ci.yml/badge.svg)](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/codeql.yml/badge.svg)](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org)
[![Use this template](https://img.shields.io/badge/use%20this-template-2ea44f?logo=github)](https://github.com/manikyashetty-arch/ai-auto-merge/generate)

---

## The problem

On any active repository, merging one pull request silently breaks others. Every open PR that touched the same lines now conflicts with the base branch, and each author has to stop, rebase, re-resolve by hand, and re-request review. The more your team ships, the more time it loses to conflicts it didn't cause.

Existing tooling treats the symptom, not the cause:

- **Merge queues** (Mergify, Aviator, Graphite) serialize merges to *avoid* conflicts. When a conflict happens anyway, they eject the PR from the queue and leave it for a human.
- **AI assistants** (GitHub Copilot, GitKraken, Cursor) can resolve a conflict well, but only when a person asks — a mention, a button, an IDE shortcut.

Nobody closes the loop: detect the conflict automatically, resolve it, and learn whether the resolution was any good.

## What ai-auto-merge does

It runs as a GitHub App. When a PR merges, it finds every other open PR that now conflicts, resolves each conflicted file with Claude, validates the result, pushes the fix back to the PR branch, and posts a transparent comment explaining what changed and what it cost. No human in the loop unless confidence is low.

Then it watches what happens next. If a human later edits or reverts a resolution, that is recorded as an override; if the PR merges with the resolution intact, that is an acceptance. Over time the bot learns which kinds of conflicts your team trusts it with and which it does not — and automatically stops auto-applying the categories you keep correcting.

---

## How it compares

| | ai-auto-merge | GitHub Copilot conflict fix | Merge queues (Mergify / Aviator / Graphite) |
|---|---|---|---|
| Trigger | Automatic, on upstream merge | Human (mention or button) | Automatic, on enqueue |
| On conflict | Resolves with AI | Resolves with AI | Ejects PR, asks a human |
| Learns from human corrections | Yes | No | No |
| Resolution cost shown per PR | Yes | No | N/A |
| Deterministic fast paths (no AI cost) | Yes | No | N/A |
| Self-hostable / open source | Yes (MIT) | No | No (SaaS) |
| Model choice | Any Claude model | Fixed | N/A |

ai-auto-merge is complementary to a merge queue, not a replacement for one: point the queue at the branches, and let ai-auto-merge keep them mergeable so the queue stops ejecting them. It is not trying to be an IDE assistant — it is the unattended, server-side half of the problem.

---

## Features

**Resolution**
- Adaptive, token-efficient pipeline: one resolution pass plus a cheap independent verifier on the common case; it escalates to a second full strategy and a judge model only when the verifier has doubts. Quality is preserved by always cross-checking; cost is roughly halved versus generating two full resolutions every time. A `thorough` mode is available when you want both strategies on every conflict.
- Cost controls throughout: prompt caching shares the PR context across every file (the diff is sent once and read at roughly a tenth of the price thereafter), output ceilings are sized to each file instead of a fixed maximum, and effort is tunable.
- Self-healing syntax gate: every resolved TypeScript, JavaScript, Python, and Go file is parsed before commit. A failure triggers one AI repair attempt with the exact error before the file is flagged for review.
- Deterministic fast paths: additive conflicts and import-only conflicts are merged by rule, with zero AI calls. Lockfiles (`package-lock.json`, `go.sum`, `Cargo.lock`, and a dozen more) are never AI-merged; you get the exact regenerate command instead.
- Confidence-gated auto-apply with a per-repo threshold; oversized files and high-fanout PRs are bounded to cap cost.

**Adaptive learning** (unique to this project)
- Tracks human accept/override signals per repository, file type, and resolution method.
- Once a category accumulates enough signal and crosses an override threshold, it is automatically routed to manual review — no redeploy, no config change. The bot stops repeating the mistakes a given codebase punishes.
- Fully visible on the dashboard and the `/api/insights` endpoint.

**Workflow and access**
- Slash commands on any PR: `/ai-merge` to resolve now, `/ai-merge dry-run` to preview, `/ai-merge status` to inspect. Write-access gated.
- Optional auto-merge: arms GitHub native auto-merge after a fully clean resolution, so conflict to resolved to CI-green to merged needs zero humans.
- Notifications: Slack, Discord, or any generic webhook on run completion.

**Operations**
- Live dashboard at `/dashboard`: runs, outcomes, fast-path vs AI share, what the bot has learned, token usage, and estimated spend.
- Prometheus metrics at `/metrics`, JSON at `/api/stats`, `/api/runs`, `/api/insights`.
- Cost transparency: every PR comment ends with calls, tokens, percent cached, and estimated dollars.
- Queue-aware: optional Redis and BullMQ for high volume, with a bounded-concurrency in-process fallback and webhook deduplication when Redis is absent.

---

## Quickstart

```bash
# Use this repository as a template (button above), then clone your copy
git clone https://github.com/YOUR_USER/ai-auto-merge.git && cd ai-auto-merge

npm install
cp .env.example .env        # fill in GitHub App and Anthropic credentials
npm run dev                 # or: npm run build && npm start
```

Point your GitHub App webhook at `POST /webhook` and open `http://localhost:3000/dashboard`.

Prefer containers: `docker compose up --build` brings up the app and a Redis instance.

If you fork or template this repository, do a single search-and-replace of `manikyashetty-arch` to your own org in the badges, links, `package.json`, `.github/`, and the bot comment footer in `src/services/comments.ts`.

---

## Setup

### 1. Create a GitHub App

Settings, Developer settings, GitHub Apps, New GitHub App.

- Webhook URL: `https://your-server.com/webhook`
- Webhook secret: a random string you also put in `.env`
- Repository permissions:
  - Contents: Read and write
  - Pull requests: Read and write
  - Commit statuses: Read and write
  - Issues: Read and write (for slash commands and reactions)
- Subscribe to events: Pull request, Issue comment
- Generate a private key (`.pem`), note the App ID, install the App on your repositories.

Do not grant Workflows permission. Without it, the App physically cannot modify `.github/workflows`, which is the safest default.

### 2. Configure environment

```env
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-webhook-secret
ANTHROPIC_API_KEY=sk-ant-...

NODE_ENV=production
AUTO_APPLY_CONFIDENCE_THRESHOLD=high
DASHBOARD_TOKEN=a-long-random-string

# Optional integrations
# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# REDIS_URL=redis://localhost:6379
```

`GITHUB_PRIVATE_KEY` takes the full PEM contents with literal `\n` for newlines.

### 3. Run

```bash
npm run dev                    # development, auto-reload
npm run build && npm start     # production
```

---

## Slash commands

Anyone with write access can drive the bot from a PR comment:

| Command | Effect |
|---|---|
| `/ai-merge` or `/ai-merge resolve` | Resolve this PR's conflicts now |
| `/ai-merge dry-run` | Post proposed resolutions without pushing |
| `/ai-merge status` | Show mergeability, configuration, queue, and last-run info |
| `/ai-merge help` | List commands |

Permission is checked live against the repository, with the comment author association as a fallback, so accounts without write access cannot trigger spend.

---

## Adaptive learning

The learning loop is what separates this from every other resolver. It needs no configuration to work, but you can tune or disable it.

How it learns:

1. When the bot resolves a PR, each applied file is provisional.
2. If a human later pushes a commit that edits a file the bot resolved, that file's category is recorded as an override.
3. If the PR merges with the resolution intact, the category is recorded as an acceptance.
4. Once a `(repo, file-type, method)` category has at least `LEARNING_MIN_SAMPLES` observations and an override rate at or above `LEARNING_OVERRIDE_THRESHOLD`, new resolutions in that category are automatically routed to manual review.

Everything it has learned is visible on the dashboard and at `GET /api/insights`. Set `LEARNING_ENABLED=false` for fully static behavior.

---

## Observability

| Endpoint | Contents |
|---|---|
| `GET /dashboard` | Live HTML: runs, outcomes, learning insights, tokens, estimated spend |
| `GET /api/stats` | Aggregate stats as JSON |
| `GET /api/runs?limit=50` | Recent run records with per-file detail |
| `GET /api/insights` | Learned accept/override rates and which categories are gated |
| `GET /metrics` | Prometheus text format |
| `GET /health` | Liveness, version, queue mode, model, learning and notification status |

Set `DASHBOARD_TOKEN` in production; these endpoints then require `Authorization: Bearer <token>` or `?token=`. Without it they are public, which exposes repository names, PR titles, and spend.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GITHUB_APP_ID` | required | Numeric App ID |
| `GITHUB_PRIVATE_KEY` | required | App private key PEM (use `\n` for newlines) |
| `GITHUB_WEBHOOK_SECRET` | required | Webhook signature secret |
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `LLM_PROVIDER` | `anthropic` | `anthropic` (Claude, native) or `openai` |
| `ANTHROPIC_API_KEY` | required if provider=anthropic | Anthropic key |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Model for resolution and repair |
| `ANTHROPIC_JUDGE_MODEL` | `claude-haiku-4-5` | Cheap model for the verifier and judge |
| `ANTHROPIC_EFFORT` | `medium` | Thinking effort for resolution (`low`, `medium`, `high`, `max`) |
| `OPENAI_API_KEY` | required if provider=openai | OpenAI key |
| `OPENAI_MODEL` | `gpt-4o` | Resolution model (any chat-completions model your key allows) |
| `OPENAI_JUDGE_MODEL` | `gpt-4o-mini` | Cheap model for the verifier and judge |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for Azure OpenAI or OpenAI-compatible gateways |
| `RESOLUTION_MODE` | `adaptive` | `adaptive` (verify, escalate on doubt) or `thorough` (always dual-strategy) |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `development` or `production` |
| `AUTO_APPLY_CONFIDENCE_THRESHOLD` | `high` | Minimum confidence to auto-push (`high`, `medium`, `low`) |
| `MAX_FILES_TO_AUTO_RESOLVE` | `20` | Skip PRs with more conflicted files than this |
| `MAX_FILE_BYTES` | `262144` | Files larger than this are flagged, not sent to the AI |
| `AUTO_MERGE_ON_CI_PASS` | `false` | Arm GitHub auto-merge after a fully clean resolution |
| `AUTO_MERGE_METHOD` | `SQUASH` | `MERGE`, `SQUASH`, or `REBASE` |
| `LEARNING_ENABLED` | `true` | Enable the adaptive learning loop |
| `LEARNING_MIN_SAMPLES` | `5` | Observations before a category can gate |
| `LEARNING_OVERRIDE_THRESHOLD` | `0.5` | Override rate at which a category is gated |
| `SLACK_WEBHOOK_URL` | unset | Slack/Discord incoming webhook for run notifications |
| `NOTIFY_WEBHOOK_URL` | unset | Generic webhook receiving the full run summary |
| `NOTIFY_ONLY_OUTCOMES` | unset | Comma-separated outcomes to notify on; empty means all meaningful ones |
| `DASHBOARD_TOKEN` | unset | Bearer token guarding `/dashboard`, `/api/*`, `/metrics` |
| `RATE_LIMIT_PER_MIN` | `300` | Per-IP request ceiling; `0` disables |
| `TRUST_PROXY` | `false` | Set true only behind a reverse proxy |
| `REDIS_URL` | unset | Enables BullMQ queueing when set |
| `QUEUE_CONCURRENCY` | `3` | BullMQ worker concurrency |
| `INPROCESS_CONCURRENCY` | `2` | Concurrent merge events without Redis |

Per-repository overrides live in `.auto-merge.yml`; see [`.auto-merge.example.yml`](.auto-merge.example.yml). Supported keys: `enabled`, `autoApplyConfidenceThreshold`, `maxFilesToAutoResolve`, `excludePaths`, `dryRun`, `autoMergeOnCIPass`.

---

## Model providers

The resolver is provider-agnostic. Set `LLM_PROVIDER`:

- **`anthropic`** (default, native): uses the Anthropic SDK with streaming, prompt caching, and adaptive thinking/effort — the most token-efficient path. Set `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_MODEL`.
- **`openai`**: uses the OpenAI chat-completions API in JSON mode (dependency-free, via `fetch`). Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL`. Works with Azure OpenAI or any OpenAI-compatible gateway via `OPENAI_BASE_URL`. Prompt caching and thinking/effort are Anthropic-only and are simply skipped.

Only the selected provider's key is required at boot. The full pipeline — adaptive verify/escalate, syntax gate, learning, cost accounting — runs identically on either; cost is estimated from the active model's published rates.

There are runnable end-to-end harnesses (no GitHub App required):

```bash
npm run e2e:local        # real git plumbing + fast paths, no API key
npm run e2e:integration  # full pipeline on real git, model stubbed
npm run e2e:openai       # full pipeline on the OpenAI path, fetch stubbed
npm run e2e:live         # LIVE: real API call using the key in .env (small spend)
```

## How resolution works

For each conflicted file, after fast-path and lockfile filtering, in the default adaptive mode:

1. One resolution is generated with adaptive thinking. The PR context (title, description, full diff) is a separately cached block, so it is sent once per PR and read cheaply for every file and call.
2. A cheap verifier (the judge model) independently checks the resolution: no markers left, both sides' intent preserved, code plausible. If it approves with confidence, the resolution ships — one expensive call, not two.
3. If the verifier has any doubt, the pipeline escalates: a second strategy is generated, and if the two converge the result is high-confidence; if they diverge the judge picks the better one or rejects both.
4. The chosen resolution is syntax-checked, repaired once if needed, then gated against the learning loop before being applied. Output ceilings are sized to the file, so a small conflict in a large file never pays for a large generation.

In `thorough` mode, both strategies always run and the judge always reconciles — higher assurance, roughly double the cost.

Untrusted PR content (titles, descriptions, diffs, file contents) is treated strictly as data, not instructions, and is size-capped. The decisive backstop against a wrong resolution is that every result is an ordinary commit on a PR branch that a human reviews before merge.

---

## Architecture

```
GitHub webhook (PR merged / PR synchronize / issue comment)
        |  raw-byte HMAC verification
  handlers/webhook.ts ------ /ai-merge commands (permission gated)
        |                     learning signals (override / acceptance)
  services/queue.ts  (BullMQ if REDIS_URL set, else bounded in-process + dedup)
        |  per-PR lock
  services/prProcessor.ts
    |-- github: find conflicted PRs (parallel mergeability, fork filter)
    |-- git: clone PR branch, merge base, detect conflicts
    |-- services/conflictClassifier.ts   fast paths + lockfile detection
    |-- services/conflictResolver.ts     adaptive: resolve + verify, escalate on doubt
    |-- services/syntaxCheck.ts          parse gate, AI repair on failure
    |-- services/learning.ts             adaptive gate on history
    |-- git: write resolved files, commit, push --force-with-lease
    |-- github: comment with cost, commit status, optional auto-merge
    |-- services/notify.ts               Slack / webhook
    \-- services/runHistory.ts + utils/metrics.ts  -> dashboard, /api/*, /metrics
```

---

## Security

ai-auto-merge holds write access to PR branches and processes input from anyone who can open a PR, so it is built defensively: raw-byte webhook verification, strict owner/repo/ref validation, workspace-contained file operations with symlinks disabled at clone, constant-time token comparison, security headers, a spoof-resistant rate limiter, prompt-injection mitigations, and supply-chain-hardened container builds. The full threat model and deployment hardening checklist are in [SECURITY.md](SECURITY.md). Report vulnerabilities privately via GitHub Security Advisories.

---

## Development

```bash
npm run lint
npm run build
npm test
```

Tests mock all external services and never hit a real API. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project map, commit conventions, and PR process.

## License

[MIT](LICENSE)

## Sources

Competitive landscape researched June 2026: [GitHub Copilot conflict resolution](https://github.blog/changelog/2026-04-13-fix-merge-conflicts-in-three-clicks-with-copilot-cloud-agent/), [Graphite merge queue](https://graphite.com/guides/merge-queue-tools-options), [Aviator MergeQueue](https://www.aviator.co/merge-queue), [Mergify](https://mergify.com/).
