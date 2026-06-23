# ai-auto-merge

When you merge a pull request, you often break the other open ones. Every PR that touched the same lines now conflicts with the base branch, and each author has to drop what they're doing, rebase, re-resolve the conflict by hand, and ask for review again. The busier the repository, the more time the team loses to conflicts nobody intended to create.

ai-auto-merge is a self-hosted GitHub App that closes that loop. The moment a PR lands on a branch, it finds every other open PR that now conflicts, resolves each conflicted file with an LLM, checks the result, pushes the fix back to the PR branch, and leaves a comment explaining exactly what it changed and what it cost. If it isn't confident, it doesn't push — it flags the file for a human instead. And it pays attention to what happens next: when people accept or undo its work, it learns which kinds of conflicts your team actually trusts it with.

[![CI](https://github.com/ArsenalAI-Official/ai-auto-merge/actions/workflows/ci.yml/badge.svg)](https://github.com/ArsenalAI-Official/ai-auto-merge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ArsenalAI-Official/ai-auto-merge/actions/workflows/codeql.yml/badge.svg)](https://github.com/ArsenalAI-Official/ai-auto-merge/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org)

---

## Contents

- [How it works, end to end](#how-it-works-end-to-end)
- [What makes it different](#what-makes-it-different)
- [How it compares to other tools](#how-it-compares-to-other-tools)
- [Quickstart](#quickstart)
- [Detailed setup](#detailed-setup)
- [Slash commands](#slash-commands)
- [Per-repository configuration](#per-repository-configuration)
- [Environment variables](#environment-variables)
- [How resolution works](#how-resolution-works)
- [Adaptive learning](#adaptive-learning)
- [Observability](#observability)
- [Model providers](#model-providers)
- [Architecture](#architecture)
- [Security](#security)
- [Development and testing](#development-and-testing)
- [Author](#author)
- [License](#license)

---

## How it works, end to end

It runs as a GitHub App and reacts to three things: a PR being merged, a `/ai-merge` comment, and pushes to PR branches (used only for learning).

When a PR merges into a branch, the app:

1. Lists every other open PR targeting that branch and asks GitHub which ones are now conflicting.
2. For each conflicted PR, clones the branch into an isolated, throwaway workspace and merges the base branch to reproduce the exact conflict.
3. Resolves each conflicted file. Simple cases (two sides adding different code, or just import lines) are merged by deterministic rules with no model call at all. Everything else goes to the LLM, which sees only the conflicting regions plus a little surrounding context.
4. Validates the result: no conflict markers left behind, both sides' changes preserved, the file still parses. If a syntax check fails, it asks the model once to repair it.
5. Optionally formats the changed files with your repository's own Prettier config, and can run a command you define (for example, regenerating API types) so the branch comes out clean.
6. Pushes the fix back to the PR branch as an ordinary commit, using `--force-with-lease` so it can never clobber work the author pushed in the meantime.
7. Comments on the PR with a per-file summary, the confidence level, and the token cost.

Nothing is auto-applied unless the app is confident. Low-confidence resolutions are pushed nowhere; they are reported for a person to handle. And every successful resolution is just a commit on a branch that still goes through your normal review and CI before it merges, so a human is always the last line of defense.

---

## What makes it different

**It triggers itself.** Most tools wait for a person — a mention, a button, an IDE shortcut. This one acts the moment an upstream merge creates the conflict, so PRs stay mergeable without anyone noticing they briefly weren't.

**It resolves at the hunk level, not the whole file.** Instead of regenerating an entire file to fix a three-line conflict, it sends the model only each conflicting region and splices the answer back into the untouched file, byte for byte. This is the same "edit, don't rewrite" approach Cursor and Claude Code use. It means a small conflict in a several-thousand-line file resolves fine (whole-file regeneration hits the model's output-size limit and fails on large files), it costs far fewer tokens because the unchanged 99 percent of the file is never regenerated, and it is safer because the model can't accidentally alter code it never saw. If a file's conflict markers are malformed, it falls back to whole-file resolution automatically.

**It keeps both sides by default.** The resolver is biased toward the union of both branches' changes. It only collapses two versions into one when they edit the very same line, and a separate deterministic check refuses to push a resolution that quietly dropped one side. Losing your code is the failure mode it works hardest to prevent.

**It learns from your team.** When the app resolves a file, that resolution is provisional. If a human later edits it, that's recorded as an override; if the PR merges untouched, that's an acceptance. Once a category of conflict (per repository, file type, and resolution method) crosses an override threshold, the app stops auto-applying it and routes it to manual review instead. No redeploy, no config change. It stops repeating the mistakes a given codebase punishes.

**It tells you what it cost.** Every PR comment ends with the number of model calls, tokens used, percent served from cache, and an estimated dollar figure. There is a live dashboard and Prometheus metrics for the same data across all runs.

---

## How it compares to other tools

|  | ai-auto-merge | GitHub Copilot conflict fix | Merge queues (Mergify, Aviator, Graphite) |
|---|---|---|---|
| Trigger | Automatic, on upstream merge | Human (mention or button) | Automatic, on enqueue |
| On conflict | Resolves with AI | Resolves with AI | Ejects the PR, asks a human |
| Learns from human corrections | Yes | No | No |
| Per-PR cost shown | Yes | No | Not applicable |
| Deterministic fast paths (no AI cost) | Yes | No | Not applicable |
| Self-hostable / open source | Yes (MIT) | No | No (SaaS) |
| Model choice | Any Claude or OpenAI model | Fixed | Not applicable |

This is meant to sit alongside a merge queue, not replace one. Point the queue at your branches and let ai-auto-merge keep them mergeable, so the queue stops ejecting them. It is also not trying to be an IDE assistant — it is the unattended, server-side half of the problem.

---

## Quickstart

```bash
git clone https://github.com/ArsenalAI-Official/ai-auto-merge.git
cd ai-auto-merge

npm install
cp .env.example .env        # fill in the GitHub App and model credentials
npm run dev                 # development with auto-reload
# or: npm run build && npm start  for production
```

Point your GitHub App's webhook at `POST /webhook`, then open `http://localhost:3000/dashboard`.

Prefer containers: `docker compose up --build` starts the app together with a Redis instance.

The [detailed setup](#detailed-setup) below walks through creating the GitHub App and obtaining the three credentials from scratch. If you are using this for a team and want a longer, screenshot-friendly walkthrough, see [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md).

---

## Detailed setup

You need three things from GitHub (an App ID, a private key, and a webhook secret) and one model API key (Anthropic or OpenAI). Here is the whole process.

### 1. Create the GitHub App

Go to **Settings > Developer settings > GitHub Apps > New GitHub App** (under your personal account, or an organization's settings if the App should belong to the org).

Fill in:

- **GitHub App name**: anything unique, for example `your-org-ai-auto-merge`.
- **Homepage URL**: your repository URL is fine.
- **Webhook > Active**: checked.
- **Webhook URL**: where this server will receive events, for example `https://your-server.com/webhook`. For local development, see [running locally behind a tunnel](#5-running-locally-behind-a-tunnel) below.
- **Webhook secret**: generate a random string (for example `openssl rand -hex 32`) and keep it — it goes in `.env` as `GITHUB_WEBHOOK_SECRET`.

Set **Repository permissions**:

| Permission | Access | Why |
|---|---|---|
| Contents | Read and write | Clone branches and push the resolved commit |
| Pull requests | Read and write | Read PR metadata, find conflicting PRs |
| Commit statuses | Read and write | Post the app's own status on the PR |
| Issues | Read and write | Post comments and reactions, handle slash commands |

Leave **Workflows** unset. Without that permission the App physically cannot modify files under `.github/workflows`, which is the safe default — conflicts in workflow files are flagged for a human instead of resolved.

Under **Subscribe to events**, check **Pull request** and **Issue comment**.

Choose whether the App can be installed only on your account or on any account, then click **Create GitHub App**.

### 2. Collect the three credentials

After the App is created:

- **App ID**: shown at the top of the App's settings page. This is `GITHUB_APP_ID`.
- **Private key**: scroll to "Private keys", click **Generate a private key**, and a `.pem` file downloads. This is the key the App signs its requests with. You can either point the app at the file or inline it (see the next step).
- **Webhook secret**: the random string you set in step 1. This is `GITHUB_WEBHOOK_SECRET`.

Then **install the App**: open the App's "Install App" tab, install it on the account or organization that owns your repositories, and grant it access to the repositories you want covered.

### 3. Get a model API key

- For Anthropic (the default): create a key at the Anthropic console. This is `ANTHROPIC_API_KEY`.
- For OpenAI: create a key at the OpenAI dashboard and set `LLM_PROVIDER=openai`. This is `OPENAI_API_KEY`.

You only need a key for the provider you actually use; the app requires just that one at startup.

### 4. Configure the environment

Copy `.env.example` to `.env` and fill it in. A minimal Anthropic configuration:

```env
GITHUB_APP_ID=123456
GITHUB_WEBHOOK_SECRET=the-random-string-from-step-1
ANTHROPIC_API_KEY=sk-ant-...

# Provide the private key one of two ways:
# (a) Recommended — point at the downloaded .pem file:
GITHUB_PRIVATE_KEY_PATH=/absolute/path/to/your-app.private-key.pem
# (b) Or inline the PEM with literal \n for each newline:
# GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

NODE_ENV=production
AUTO_APPLY_CONFIDENCE_THRESHOLD=high
DASHBOARD_TOKEN=a-long-random-string

# Optional
# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
# REDIS_URL=redis://localhost:6379
```

Prefer `GITHUB_PRIVATE_KEY_PATH` over the inline form — pasting a multi-line PEM into an env var is the single most common setup mistake. If you do inline it with `GITHUB_PRIVATE_KEY`, every newline must be a literal `\n`. The app validates the key shape at startup and fails with a clear message if the markers are missing.

Always set `DASHBOARD_TOKEN` in any deployment that is reachable by others. Without it, the dashboard and JSON endpoints are public and expose repository names, PR titles, and spend.

### 5. Running locally behind a tunnel

GitHub has to reach your webhook over the public internet, so for local development you need a tunnel that forwards a public URL to `http://localhost:3000`. Any tunneling tool works (for example `ngrok http 3000`, or `cloudflared`). Take the public HTTPS URL it gives you, append `/webhook`, and set that as the App's Webhook URL in its settings. Then:

```bash
npm run dev
```

Open a PR, merge another that conflicts with it, and watch the app pick it up. The dashboard at `http://localhost:3000/dashboard` shows each run.

### 6. Running in production

```bash
npm run build && npm start
```

Or with Docker:

```bash
docker compose up --build
```

Put it behind HTTPS, set `DASHBOARD_TOKEN`, and set `TRUST_PROXY=true` only if it sits behind a reverse proxy or load balancer (so client IPs for the rate limiter come from `X-Forwarded-For` rather than the socket). If you expect high volume, set `REDIS_URL` to enable durable BullMQ queueing; without it the app uses a bounded in-process queue with webhook de-duplication, which is fine for most teams.

---

## Slash commands

Anyone with write access to the repository can drive the app from a PR comment:

| Command | Effect |
|---|---|
| `/ai-merge` or `/ai-merge resolve` | Resolve this PR's conflicts now |
| `/ai-merge dry-run` | Post the proposed resolutions as a comment without pushing |
| `/ai-merge status` | Show mergeability, configuration, queue state, and the last run |
| `/ai-merge help` | List the commands |

Permission is checked live against the repository, with the comment author's association as a fallback, so accounts without write access cannot trigger spend.

---

## Per-repository configuration

Drop a `.auto-merge.yml` at the root of any repository the App is installed on to override the server defaults for that repository. It is always read from the base branch, never from a PR's head — so a pull request can't weaken the bot's own guardrails. See [.auto-merge.example.yml](.auto-merge.example.yml) for a fully commented template.

```yaml
# Turn the bot off for this repo entirely.
enabled: true

# Minimum confidence to auto-apply without flagging: high | medium | low
autoApplyConfidenceThreshold: high

# Skip PRs with more conflicted files than this.
maxFilesToAutoResolve: 20

# Never auto-resolve these paths; always flag them for review.
excludePaths:
  - "*.generated.ts"
  - "migrations/**"

# Propose resolutions as a comment but do not push (good for trialing the bot).
dryRun: false

# Arm GitHub's native auto-merge after a fully clean resolution.
autoMergeOnCIPass: false

# Auto-format resolved files with this repo's own Prettier before committing.
# Only touches files the bot resolved, and reverts if the result no longer parses.
format: true

# Optional command run in the workspace after resolving and before committing,
# for example to regenerate code or types so the pushed branch is clean. It runs
# with secrets scrubbed from its environment and under a timeout; if it fails,
# nothing is committed and the PR is flagged for review.
# postResolve: "cd app && npm ci && npm run gen:api"
# postResolveTimeoutSec: 180
```

Supported keys: `enabled`, `autoApplyConfidenceThreshold`, `maxFilesToAutoResolve`, `excludePaths`, `dryRun`, `autoMergeOnCIPass`, `format`, `postResolve`, `postResolveTimeoutSec`.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_APP_ID` | required | Numeric App ID |
| `GITHUB_PRIVATE_KEY_PATH` | one of these two | Path to the downloaded `.pem` (recommended) |
| `GITHUB_PRIVATE_KEY` | one of these two | The PEM inlined, with `\n` for each newline |
| `GITHUB_WEBHOOK_SECRET` | required | Webhook signature secret |
| `LLM_PROVIDER` | `anthropic` | `anthropic` (native, default) or `openai` |
| `ANTHROPIC_API_KEY` | required if provider is anthropic | Anthropic API key |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Model used for resolution and repair |
| `ANTHROPIC_JUDGE_MODEL` | `claude-haiku-4-5` | Cheaper model used for the verifier and judge |
| `ANTHROPIC_EFFORT` | `medium` | Thinking effort: `low`, `medium`, `high`, `max` |
| `OPENAI_API_KEY` | required if provider is openai | OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o` | Resolution model (any chat-completions model your key allows) |
| `OPENAI_JUDGE_MODEL` | `gpt-4o-mini` | Cheaper model for the verifier and judge |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for Azure OpenAI or an OpenAI-compatible gateway |
| `OPENAI_MAX_OUTPUT_TOKENS` | `16384` | The model's completion-token limit. Only used to size whole-file fallbacks; hunk-level resolution is unaffected |
| `RESOLUTION_MODE` | `adaptive` | `adaptive` (resolve, verify, escalate on doubt) or `thorough` (always run two strategies and a judge) |
| `RESOLUTION_GRANULARITY` | `auto` | `auto` / `hunk` resolve only the conflict regions and splice them back in; `file` regenerates the whole file. All fall back to whole-file when markers can't be parsed |
| `HUNK_CONTEXT_LINES` | `12` | Lines of surrounding context sent with each conflict hunk |
| `FORMAT_RESOLVED` | `true` | Auto-format resolved files with the repo's Prettier before commit (per-repo `format:` overrides) |
| `POST_RESOLVE_TIMEOUT_SEC` | `180` | Default ceiling for a repo's `postResolve` command (per-repo config can set 10–1800) |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `development` or `production` |
| `AUTO_APPLY_CONFIDENCE_THRESHOLD` | `high` | Minimum confidence to auto-push: `high`, `medium`, `low` |
| `MAX_FILES_TO_AUTO_RESOLVE` | `20` | Skip PRs with more conflicted files than this |
| `MAX_FILE_BYTES` | `262144` | Conflicted files larger than this are flagged, not sent to the model |
| `ALLOW_WORKFLOW_FILES` | `false` | Attempt to resolve `.github/workflows/*` — only if the App has the `workflows` permission |
| `AUTO_MERGE_ON_CI_PASS` | `false` | Arm GitHub auto-merge after a fully clean resolution |
| `AUTO_MERGE_METHOD` | `SQUASH` | `MERGE`, `SQUASH`, or `REBASE` |
| `LEARNING_ENABLED` | `true` | Enable the adaptive learning loop |
| `LEARNING_MIN_SAMPLES` | `5` | Observations before a category can gate |
| `LEARNING_OVERRIDE_THRESHOLD` | `0.5` | Override rate at which a category is routed to review |
| `SLACK_WEBHOOK_URL` | unset | Slack or Discord incoming webhook for run notifications |
| `NOTIFY_WEBHOOK_URL` | unset | Generic webhook receiving the full run summary as JSON |
| `NOTIFY_ONLY_OUTCOMES` | unset | Comma-separated outcomes to notify on; empty means all meaningful ones |
| `DASHBOARD_TOKEN` | unset | Bearer token guarding `/dashboard`, `/api/*`, and `/metrics` |
| `RATE_LIMIT_PER_MIN` | `300` | Per-IP request ceiling; `0` disables it |
| `TRUST_PROXY` | `false` | Set true only when behind a reverse proxy |
| `REDIS_URL` | unset | Enables BullMQ queueing when set |
| `QUEUE_CONCURRENCY` | `3` | BullMQ worker concurrency |
| `INPROCESS_CONCURRENCY` | `2` | Concurrent merge events handled without Redis |
| `PR_CONCURRENCY` | `1` | Conflicted PRs resolved at once per merge (`1` is sequential, one at a time) |

---

## How resolution works

For each conflicted file, the app first tries to avoid the model entirely. Two sides adding different, non-overlapping code is merged by keeping both. A conflict that is only import lines is merged and de-duplicated. Generated lockfiles are never merged — you get the exact regenerate command instead. Workflow files and binaries are flagged. None of these cost a token.

Anything left goes to the LLM, by default at the hunk level:

1. The app extracts each conflict region with a few lines of surrounding context and asks the model to resolve only that region. The PR's title, description, and full diff are sent once as a separately cached block, so they are read cheaply for every file and every call.
2. A cheaper "judge" model independently verifies the proposed resolution: no markers left, both sides' intent preserved, the code is plausible. If it approves with confidence, the resolution ships after one expensive call rather than two.
3. If the verifier has any doubt, the app escalates: it generates a second resolution with a different strategy. If the two agree, confidence is high; if they diverge, the judge picks the better one or rejects both.
4. The resolved region is spliced back into the verbatim file, the whole file is syntax-checked (and repaired once if needed), then formatted and run through the learning gate before it is applied.

In `thorough` mode, both strategies always run and the judge always reconciles — higher assurance at roughly double the cost. Whichever path is taken, the untrusted PR content (titles, descriptions, diffs, file contents) is treated strictly as data, never as instructions, and is size-capped. The real backstop against a bad resolution is that every result is a normal commit on a PR branch that a human reviews before it merges.

---

## Adaptive learning

The learning loop needs no configuration to work, but you can tune or disable it.

1. When the bot resolves a PR, each applied file is provisional.
2. If a human later pushes a commit that edits a file the bot resolved, that file's category is recorded as an override.
3. If the PR merges with the resolution intact, the category is recorded as an acceptance.
4. Once a `(repository, file type, method)` category has at least `LEARNING_MIN_SAMPLES` observations and an override rate at or above `LEARNING_OVERRIDE_THRESHOLD`, new resolutions in that category are routed to manual review automatically.

Everything it has learned is visible on the dashboard and at `GET /api/insights`. Set `LEARNING_ENABLED=false` for fully static behavior.

---

## Observability

| Endpoint | Contents |
|---|---|
| `GET /dashboard` | Live HTML: runs, outcomes, learning insights, tokens, estimated spend |
| `GET /api/stats` | Aggregate statistics as JSON |
| `GET /api/runs?limit=50` | Recent run records with per-file detail |
| `GET /api/insights` | Learned accept/override rates and which categories are gated |
| `GET /metrics` | Prometheus text format |
| `GET /health` | Liveness, version, queue mode, model, learning and notification status |

Set `DASHBOARD_TOKEN` in production; these endpoints then require `Authorization: Bearer <token>` or `?token=`.

---

## Model providers

The resolver does not care which model it talks to. Set `LLM_PROVIDER`:

- **`anthropic`** (default): uses the Anthropic SDK with streaming, prompt caching, and adaptive thinking/effort — the most token-efficient path. Set `ANTHROPIC_API_KEY` and optionally `ANTHROPIC_MODEL`.
- **`openai`**: uses the OpenAI chat-completions API in JSON mode, dependency-free via `fetch`. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL`. Works with Azure OpenAI or any OpenAI-compatible gateway through `OPENAI_BASE_URL`. Prompt caching and thinking/effort are Anthropic-only and are simply skipped.

Only the selected provider's key is required at boot. The full pipeline — hunk-level resolution, adaptive verify and escalate, syntax gate, formatting, learning, cost accounting — runs identically on either, and cost is estimated from the active model's published rates.

There are runnable end-to-end harnesses that need no GitHub App:

```bash
npm run e2e:local        # real git plumbing, fast paths, and hunk splicing; no API key
npm run e2e:integration  # full pipeline on real git, model stubbed
npm run e2e:openai       # full pipeline on the OpenAI path, network stubbed
npm run e2e:live         # LIVE: a real API call using the key in .env (small spend)
```

---

## Architecture

```
GitHub webhook (PR merged / PR synchronize / issue comment)
        |  raw-byte HMAC verification
  handlers/webhook.ts ------ /ai-merge commands (permission gated)
        |                     learning signals (override / acceptance)
  services/queue.ts  (BullMQ if REDIS_URL is set, else bounded in-process + dedup)
        |  per-PR lock
  services/prProcessor.ts
    |-- github: find conflicting PRs (parallel mergeability check, fork filter)
    |-- git: clone PR branch, merge base, detect conflicts
    |-- services/conflictClassifier.ts   fast paths, lockfile detection, hunk extraction
    |-- services/conflictResolver.ts     adaptive resolve + verify, escalate on doubt
    |-- services/hunkResolver.ts         per-hunk resolution and splicing
    |-- services/syntaxCheck.ts          parse gate, one AI repair on failure
    |-- services/postProcess.ts          Prettier formatting + optional postResolve command
    |-- services/learning.ts             adaptive gate based on history
    |-- git: write resolved files, commit, push --force-with-lease
    |-- github: comment with cost, set commit status, optional auto-merge
    |-- services/notify.ts               Slack / generic webhook
    \-- services/runHistory.ts + utils/metrics.ts  -> dashboard, /api/*, /metrics
```

---

## Security

The app holds write access to PR branches and processes input from anyone who can open a PR, so it is built defensively: raw-byte webhook signature verification, strict owner/repo/ref validation, workspace-contained file operations with symlinks disabled at clone, secrets scrubbed from logs and from any command it runs, constant-time token comparison on protected endpoints, security headers, a spoof-resistant rate limiter, and prompt-injection mitigations that treat all PR content as untrusted data. Per-repository configuration is read only from the base branch, so a pull request cannot lower the bot's own guardrails. The full threat model and a deployment hardening checklist are in [SECURITY.md](SECURITY.md). Please report vulnerabilities privately through GitHub Security Advisories.

---

## Development and testing

```bash
npm run lint
npm run build
npm test
```

The unit tests mock every external service and never make a real network call. The `e2e:local` harness exercises the real git plumbing and the hunk-splicing path against throwaway repositories, also with no API key. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project map, commit conventions, and the pull request process.

---

## Author

Built and maintained by **Manikya Rathna**.

If you fork or template this repository for your own use, do a single search-and-replace of `ArsenalAI-Official` for your own organization across the badges, links, `package.json`, the files under `.github/`, and the comment footer in `src/services/comments.ts`.

---

## License

[MIT](LICENSE)

Competitive landscape researched June 2026: [GitHub Copilot conflict resolution](https://github.blog/changelog/2026-04-13-fix-merge-conflicts-in-three-clicks-with-copilot-cloud-agent/), [Graphite merge queue](https://graphite.com/guides/merge-queue-tools-options), [Aviator MergeQueue](https://www.aviator.co/merge-queue), [Mergify](https://mergify.com/).
