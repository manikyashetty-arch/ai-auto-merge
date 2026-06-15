import { RunUsage } from '../types';

/**
 * USD per 1M tokens. Cache reads bill at ~0.1x input rate, 5-minute cache
 * writes at 1.25x. Source: platform.claude.com pricing (2026).
 */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // OpenAI (approximate published rates; cost display is an estimate)
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'o3': { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
};

const DEFAULT_PRICE = { input: 5, output: 25 };

function priceFor(model: string): { input: number; output: number } {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Date-suffixed IDs like claude-haiku-4-5-20251001 match by prefix
  const key = Object.keys(MODEL_PRICES).find((k) => model.startsWith(k));
  return key ? MODEL_PRICES[key] : DEFAULT_PRICE;
}

/** Shape of the `usage` object on Anthropic API responses. */
export interface ApiUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function estimateCostUsd(model: string, usage: ApiUsageLike): number {
  const p = priceFor(model);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (input * p.input + cacheRead * p.input * 0.1 + cacheWrite * p.input * 1.25 + output * p.output) /
    1_000_000
  );
}

export function newRunUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0, costUsd: 0 };
}

/** Accumulate one API response's usage into a run total. Tolerates missing usage. */
export function recordUsage(run: RunUsage | undefined, model: string, usage?: ApiUsageLike | null): void {
  if (!run) return;
  run.apiCalls++;
  if (!usage) return;
  run.inputTokens += usage.input_tokens ?? 0;
  run.outputTokens += usage.output_tokens ?? 0;
  run.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  run.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  run.costUsd += estimateCostUsd(model, usage);
}

export function totalTokens(u: RunUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
