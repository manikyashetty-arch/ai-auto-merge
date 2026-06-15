/**
 * OpenAI provider path for the LLM abstraction. Config is mocked to select the
 * openai provider; global.fetch is mocked so no network call is made.
 */
jest.mock('../src/utils/config', () => ({
  config: {
    llm: { provider: 'openai', resolutionMode: 'adaptive' },
    openai: { apiKey: 'sk-openai-test', model: 'gpt-4o', judgeModel: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
    anthropic: { apiKey: '', model: 'claude-opus-4-8', judgeModel: 'claude-haiku-4-5', effort: 'medium' },
  },
}));

import { complete, activeModels } from '../src/services/llm';

const realFetch = global.fetch;
let lastRequest: { url: string; body: any; headers: any };

function mockFetchOnce(payload: object, ok = true, status = 200) {
  global.fetch = jest.fn(async (url: any, init: any) => {
    lastRequest = { url, body: JSON.parse(init.body), headers: init.headers };
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as any;
  }) as any;
}

afterEach(() => { global.fetch = realFetch; });

describe('OpenAI provider', () => {
  it('reports the active OpenAI models', () => {
    expect(activeModels()).toEqual({ resolve: 'gpt-4o', judge: 'gpt-4o-mini', provider: 'openai' });
  });

  it('posts a chat-completions request with JSON mode and the resolve model', async () => {
    mockFetchOnce({
      choices: [{ message: { content: '{"resolved_content":"x","confidence":"high","explanation":"ok","needs_review":false}' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 } },
    });

    const res = await complete({
      system: 'SYS', tier: 'resolve', maxTokens: 8000,
      blocks: [{ text: 'pr context', cacheable: true }, { text: 'file block' }, { text: 'instruction' }],
    });

    expect(lastRequest.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(lastRequest.headers.authorization).toBe('Bearer sk-openai-test');
    expect(lastRequest.body.model).toBe('gpt-4o');
    expect(lastRequest.body.response_format).toEqual({ type: 'json_object' });
    expect(lastRequest.body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    // user blocks are concatenated
    expect(lastRequest.body.messages[1].content).toContain('pr context');
    expect(lastRequest.body.messages[1].content).toContain('instruction');
    // returns text + normalized usage + model
    expect(res.model).toBe('gpt-4o');
    expect(res.text).toContain('resolved_content');
    expect(res.usage).toEqual({
      input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 400, cache_creation_input_tokens: 0,
    });
  });

  it('uses the cheaper judge model for the judge tier', async () => {
    mockFetchOnce({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
    const res = await complete({ system: 'V', tier: 'judge', maxTokens: 512, blocks: [{ text: 'verify' }] });
    expect(lastRequest.body.model).toBe('gpt-4o-mini');
    expect(res.usage.input_tokens).toBe(50);
    expect(res.usage.cache_read_input_tokens).toBe(0);
  });

  it('throws with status and body on a non-2xx response', async () => {
    mockFetchOnce({ error: { message: 'invalid api key' } }, false, 401);
    await expect(
      complete({ system: 'S', tier: 'resolve', maxTokens: 100, blocks: [{ text: 'x' }] })
    ).rejects.toThrow(/OpenAI 401/);
  });

  it('throws when the response has no content', async () => {
    mockFetchOnce({ choices: [{ message: {} }], usage: {} });
    await expect(
      complete({ system: 'S', tier: 'resolve', maxTokens: 100, blocks: [{ text: 'x' }] })
    ).rejects.toThrow(/no message content/);
  });
});
