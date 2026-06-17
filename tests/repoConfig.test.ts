import { getRepoConfig } from '../src/services/repoConfig';

// Minimal octokit stub: returns a base64 .auto-merge.yml, or throws 404.
function octokitWith(yamlText: string | null) {
  return {
    repos: {
      getContent: async () => {
        if (yamlText === null) {
          const err = new Error('Not Found') as Error & { status: number };
          err.status = 404;
          throw err;
        }
        return { data: { content: Buffer.from(yamlText, 'utf-8').toString('base64'), encoding: 'base64' } };
      },
    },
  } as never;
}

const get = (yamlText: string | null) => getRepoConfig(octokitWith(yamlText), 'o', 'r', 'main');

describe('getRepoConfig — postResolve / format parsing', () => {
  it('defaults to format on, postResolve off when there is no config file', async () => {
    const cfg = await get(null);
    expect(cfg.format).toBe(true);
    expect(cfg.postResolve).toBeNull();
    expect(cfg.postResolveTimeoutSec).toBe(180);
  });

  it('parses a string postResolve command and format flag', async () => {
    const cfg = await get('format: false\npostResolve: "cd app && npm run gen:api"\npostResolveTimeoutSec: 300');
    expect(cfg.format).toBe(false);
    expect(cfg.postResolve).toBe('cd app && npm run gen:api');
    expect(cfg.postResolveTimeoutSec).toBe(300);
  });

  it('refuses a non-string postResolve (cannot enable command execution via wrong type)', async () => {
    for (const bad of ['postResolve: true', 'postResolve: 42', 'postResolve:\n  - a\n  - b', 'postResolve: ""', 'postResolve: "   "']) {
      const cfg = await get(bad);
      expect(cfg.postResolve).toBeNull();
    }
  });

  it('clamps the timeout to a sane range and falls back on garbage', async () => {
    expect((await get('postResolveTimeoutSec: 999999')).postResolveTimeoutSec).toBe(1800);
    expect((await get('postResolveTimeoutSec: 1')).postResolveTimeoutSec).toBe(10);
    expect((await get('postResolveTimeoutSec: "lots"')).postResolveTimeoutSec).toBe(180);
  });

  it('ignores a non-boolean format value', async () => {
    expect((await get('format: "yes"')).format).toBe(true); // falls back to default
  });
});
