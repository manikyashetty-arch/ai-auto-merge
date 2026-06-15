import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { ApiUsageLike } from '../utils/pricing';

/**
 * Provider-agnostic LLM layer. The resolver talks to this, not to a specific
 * SDK, so the same pipeline runs on Claude or OpenAI by flipping LLM_PROVIDER.
 *
 * Two tiers:
 *   - 'resolve' uses the capable model (Opus / gpt-4o) for resolutions & repair.
 *   - 'judge' uses the cheap model (Haiku / gpt-4o-mini) for verify & judging.
 *
 * Anthropic uses streaming + prompt caching + adaptive thinking/effort. OpenAI
 * uses a single chat-completions request with JSON mode. Both return the raw
 * text plus a normalized usage object and the model id (for cost accounting).
 */

export interface LlmBlock {
  text: string;
  /** Anthropic: mark a stable prefix block as cacheable. Ignored by OpenAI. */
  cacheable?: boolean;
}

export interface CompleteOpts {
  system: string;
  blocks: LlmBlock[];
  maxTokens: number;
  tier: 'resolve' | 'judge';
}

export interface LlmResult {
  text: string;
  usage: ApiUsageLike;
  model: string;
  /** True if the model hit the output ceiling — the text is truncated and must not be applied. */
  truncated: boolean;
}

export function activeModels(): { resolve: string; judge: string; provider: string } {
  return config.llm.provider === 'openai'
    ? { resolve: config.openai.model, judge: config.openai.judgeModel, provider: 'openai' }
    : { resolve: config.anthropic.model, judge: config.anthropic.judgeModel, provider: 'anthropic' };
}

export async function complete(opts: CompleteOpts): Promise<LlmResult> {
  return config.llm.provider === 'openai' ? openaiComplete(opts) : anthropicComplete(opts);
}

// ─── Anthropic (native: streaming, caching, adaptive thinking/effort) ────────────

let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  return anthropicClient;
}

// Adaptive thinking / effort are only valid on recent Claude models.
function supportsThinking(model: string): boolean {
  return /opus-4-[6-9]|sonnet-4-[6-9]|fable/.test(model);
}
function supportsEffort(model: string): boolean {
  return /opus-4-[5-9]|sonnet-4-[6-9]|fable/.test(model);
}

async function anthropicComplete(opts: CompleteOpts): Promise<LlmResult> {
  const model = opts.tier === 'resolve' ? config.anthropic.model : config.anthropic.judgeModel;
  const content = opts.blocks.map((b) =>
    b.cacheable
      ? { type: 'text' as const, text: b.text, cache_control: { type: 'ephemeral' as const } }
      : { type: 'text' as const, text: b.text }
  );

  // Resolve tier streams (large outputs) with thinking/effort; judge tier is a
  // small, fast single request.
  if (opts.tier === 'resolve') {
    const stream = anthropic().messages.stream({
      model,
      max_tokens: opts.maxTokens,
      ...(supportsThinking(model) ? { thinking: { type: 'adaptive' } as never } : {}),
      ...(supportsEffort(model) ? { output_config: { effort: config.anthropic.effort } as never } : {}),
      system: opts.system,
      messages: [{ role: 'user', content }],
    });
    const message = await stream.finalMessage();
    return { text: extractText(message.content), usage: usageOf(message), model, truncated: isTruncated(message) };
  }

  const response = await anthropic().messages.create({
    model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: 'user', content }],
  });
  return { text: extractText(response.content), usage: usageOf(response), model, truncated: isTruncated(response) };
}

function isTruncated(message: unknown): boolean {
  return (message as { stop_reason?: string }).stop_reason === 'max_tokens';
}

function extractText(content: unknown): string {
  const blocks = content as Array<{ type: string; text?: string }>;
  const t = blocks.find((b) => b.type === 'text');
  if (!t || typeof t.text !== 'string') throw new Error('No text in model response');
  return t.text;
}

function usageOf(message: unknown): ApiUsageLike {
  return (message as { usage?: ApiUsageLike }).usage ?? {};
}

// ─── OpenAI (chat completions, JSON mode, dependency-free via fetch) ─────────────

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

const OPENAI_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openaiComplete(opts: CompleteOpts): Promise<LlmResult> {
  const model = opts.tier === 'resolve' ? config.openai.model : config.openai.judgeModel;
  const userContent = opts.blocks.map((b) => b.text).join('\n\n');
  const body = JSON.stringify({
    model,
    max_tokens: opts.maxTokens,
    // JSON mode — our system prompts already instruct "Return JSON only",
    // which the API requires when this is set.
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: userContent },
    ],
  });

  // The Anthropic SDK retries 429/5xx automatically; raw fetch does not, so we
  // mirror that here (respecting Retry-After) — a transient overload should not
  // bounce a resolution to a human.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openai.apiKey}` },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < OPENAI_MAX_ATTEMPTS) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
          logger.warn(`OpenAI ${res.status}, retrying in ${delay}ms (attempt ${attempt}/${OPENAI_MAX_ATTEMPTS})`);
          await sleep(delay);
          continue;
        }
        const errBody = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${errBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as OpenAIResponse;
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('OpenAI response had no message content');
      }
      const u = data.usage ?? {};
      return {
        text,
        usage: {
          input_tokens: u.prompt_tokens ?? 0,
          output_tokens: u.completion_tokens ?? 0,
          cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
          cache_creation_input_tokens: 0,
        },
        model,
        truncated: data.choices?.[0]?.finish_reason === 'length',
      };
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn(`OpenAI request timed out after 120s (attempt ${attempt}/${OPENAI_MAX_ATTEMPTS})`);
        if (attempt < OPENAI_MAX_ATTEMPTS) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error('OpenAI request timed out');
      }
      throw err; // non-retryable (e.g. 400/401/413, bad JSON)
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('OpenAI request failed');
}
