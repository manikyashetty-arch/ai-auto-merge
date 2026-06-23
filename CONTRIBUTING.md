# Contributing to ai-auto-merge

Thanks for your interest. This guide covers the dev loop, conventions, and PR process.

## Dev setup

```bash
git clone https://github.com/ArsenalAI-Official/ai-auto-merge.git
cd ai-auto-merge
npm install
cp .env.example .env   # fill in real values
npm run dev
```

You will need:
- Node.js 20 or 22 (`.nvmrc` pins 22)
- A GitHub App with read/write on Contents, Pull requests, Commit statuses, and Issues, subscribed to the **Pull request** and **Issue comment** events
- An Anthropic API key
- (Optional) Redis if you set `REDIS_URL` to enable BullMQ-backed queueing

While developing, `http://localhost:3000/dashboard` shows live runs, token usage and cost, and `GET /metrics` exposes Prometheus metrics. Use `ngrok http 3000` or `gh webhook forward` to receive real webhooks locally.

## Project layout

| Path | What lives there |
|---|---|
| `src/handlers/webhook.ts` | Webhook verification + `/ai-merge` slash commands |
| `src/services/prProcessor.ts` | Orchestration: locks, syntax gate, comments, auto-merge |
| `src/services/conflictResolver.ts` | Claude pipeline: dual strategies, judge, repair |
| `src/services/prompts.ts` | All Claude prompts |
| `src/services/conflictClassifier.ts` | Fast paths: additive, imports, lockfiles |
| `src/services/gitOps.ts` | Clone / merge / push plumbing + input validation |
| `src/services/learning.ts` | Adaptive learning store + gating (pure decision logic) |
| `src/services/learningSignals.ts` | Bridges webhook events to the learning loop |
| `src/services/notify.ts` | Slack / generic webhook notifications |
| `src/services/queue.ts` | BullMQ + bounded in-process fallback |
| `src/services/runHistory.ts`, `src/utils/metrics.ts` | Observability backing `/dashboard`, `/api/*`, `/metrics` |
| `tests/` | Jest suites — mock all external services |

## Workflow

1. Open an issue first for non-trivial changes so we can align on scope.
2. Fork, branch from `main`, keep changes focused.
3. Add or update tests for any behavior change.
4. Run the full check locally before opening the PR:

   ```bash
   npm run lint
   npm run build
   npm test
   ```

5. Open a PR against `main`. CI will run lint, build, and the test matrix on Node 20 and 22.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/) — it keeps history readable and makes changelogs easy to assemble if you choose to cut releases.

| Prefix | Meaning |
|---|---|
| `feat:` | new feature (minor bump) |
| `fix:` | bug fix (patch bump) |
| `perf:` | performance fix |
| `refactor:` | code change with no behavior change |
| `docs:` | docs only |
| `test:` | test changes |
| `build:` | build system / deps |
| `ci:` | CI config |
| `chore:` | everything else |

Add `!` after the type (e.g. `feat!:`) or a `BREAKING CHANGE:` footer for major bumps.

## Code style

- TypeScript, 2-space indent, single quotes, trailing commas (see `.prettierrc.json`).
- Keep files under ~500 lines and modules focused.
- Validate input at boundaries (webhook payloads, env vars).
- No `console.log` in committed code — use the `logger` in `src/utils/logger.ts`.
- Never commit secrets or `.env` files.

## Testing

- Jest with `ts-jest` preset (see `package.json`).
- Tests live in `tests/` and follow the `*.test.ts` pattern.
- Mock external services (GitHub API, Anthropic) — never hit real APIs from tests.
- See `tests/README.md` for an overview of the existing suites.

## Security

Please do **not** open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the disclosure process.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you agree to its terms.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
