/**
 * Drives the real resolution pipeline against the demo repo using the GitHub
 * App credentials in .env — the same code path a webhook triggers, invoked
 * directly so no public tunnel is needed.
 *
 *   node scripts/run-demo-test.cjs check          # verify creds + list PRs (no writes)
 *   node scripts/run-demo-test.cjs run <prNumber> # process the merge of <prNumber>
 *
 * Never prints credentials.
 */
process.env.NODE_ENV ||= 'production';

const mode = process.argv[2] || 'check';
const prNum = parseInt(process.argv[3] || '0', 10);

const OWNER = process.env.DEMO_OWNER || 'ArsenalAI-Official';
const REPO = process.env.DEMO_REPO || 'ai-auto-merge-demo';

(async () => {
  const { config } = require('../dist/utils/config.js');
  const { initGithubApp, getGithubApp, getInstallationOctokit } = require('../dist/services/github.js');
  const { processMergedPR } = require('../dist/services/prProcessor.js');

  console.log(`provider=${config.llm.provider}  repo=${OWNER}/${REPO}`);
  await initGithubApp();
  const app = getGithubApp();

  // Resolve the installation id from the repo (proves the App is installed + creds valid).
  const { data: inst } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', {
    owner: OWNER, repo: REPO,
  });
  console.log(`✓ App is installed on ${OWNER}/${REPO} (installation ${inst.id})`);

  const octokit = await getInstallationOctokit(inst.id);
  const { data: pulls } = await octokit.pulls.list({ owner: OWNER, repo: REPO, state: 'open' });
  console.log('open PRs:');
  for (const p of pulls) console.log(`  #${p.number} "${p.title}" [${p.head.ref} → ${p.base.ref}] mergeable=${p.mergeable}`);

  if (mode === 'run') {
    const { data: pr } = await octokit.pulls.get({ owner: OWNER, repo: REPO, pull_number: prNum });
    const event = {
      prNumber: pr.number,
      prTitle: pr.title,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      repoOwner: OWNER,
      repoName: REPO,
      installationId: inst.id,
      mergedAt: pr.merged_at || new Date().toISOString(),
      mergedBy: pr.merged_by?.login || 'tester',
    };
    console.log(`\n→ Simulating webhook for merged PR #${event.prNumber}; resolving any now-conflicting PRs...\n`);
    await processMergedPR(event);
    console.log('\n✓ processMergedPR completed');
  }
})().catch((e) => {
  console.error(`ERROR (${e.status || ''}):`, e.message);
  process.exit(1);
});
