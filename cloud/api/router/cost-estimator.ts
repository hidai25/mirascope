/**
 * @fileoverview Cost estimation for router requests.
 *
 * Provides utilities for estimating the cost of AI provider requests before they're made.
 * This is used by the reservation system to lock sufficient funds for concurrent requests.
 */

import { Effect } from "effect";
import { getModelPricing } from "@/api/router/pricing";
import type { ProviderName } from "@/api/router/providers";

/**
 * Default estimate for output tokens when not specified.
 * Conservative estimate to avoid underestimating costs.
 */
const DEFAULT_OUTPUT_TOKENS_ESTIMATE = 1000;

/**
 * Rough heuristic for token counting: 4 characters per token.
 * This is an approximation used for input token estimation.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Parameters for cost estimation.
 */
export interface EstimateCostParams {
  /** Provider name (openai, anthropic, google) */
  provider: ProviderName;
  /** Model ID */
  model: string;
  /** Parsed request body */
  requestBody: unknown;
}

/**
 * Result of cost estimation.
 */
export interface EstimatedCost {
  /** Estimated cost in dollars (e.g., 0.05 for $0.05) */
  cost: number;
  /** Estimated input tokens */
  inputTokens: number;
  /** Estimated output tokens */
  outputTokens: number;
}

/**
 * Estimates the number of input tokens from a request body.
 *
 * Uses a simple character-counting heuristic (4 chars per token) since we don't
 * have access to the actual tokenizer before making the request. This is intentionally
 * conservative and may overestimate slightly - better to reserve too much and release
 * the difference than to underestimate and cause failed reservations.
 *
 * Handles different provider formats:
 * - OpenAI/Anthropic: messages array with content field
 * - Google: contents array with parts
 * - Multimodal: handles both string and array content blocks
 *
 * @param requestBody - Parsed request body
 * @returns Estimated input token count
 */
function estimateInputTokens(requestBody: unknown): number {
  if (typeof requestBody !== "object" || requestBody === null) {
    return 0;
  }

  const body = requestBody as Record<string, unknown>;

  // OpenAI/Anthropic format: messages array
  if (Array.isArray(body.messages)) {
    const messages = body.messages as Array<Record<string, unknown>>;
    let totalChars = 0;

    for (const message of messages) {
      if (typeof message.content === "string") {
        totalChars += message.content.length;
      } else if (Array.isArray(message.content)) {
        // Handle multimodal content (array of content blocks)
        for (const block of message.content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof (block as { text?: unknown }).text === "string"
          ) {
            totalChars += (block as { text: string }).text.length;
          }
        }
      }

      // Add role overhead (system/user/assistant)
      if (typeof message.role === "string") {
        totalChars += message.role.length;
      }
    }

    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  // Google format: contents array
  if (Array.isArray(body.contents)) {
    const contents = body.contents as Array<Record<string, unknown>>;
    let totalChars = 0;

    for (const content of contents) {
      if (Array.isArray(content.parts)) {
        for (const part of content.parts) {
          if (
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            totalChars += (part as { text: string }).text.length;
          }
        }
      }

      // Add role overhead
      if (typeof content.role === "string") {
        totalChars += content.role.length;
      }
    }

    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  // Fallback: stringify and count characters
  return Math.ceil(JSON.stringify(requestBody).length / CHARS_PER_TOKEN);
}

/**
 * Estimates the number of output tokens from a request body.
 *
 * Uses the max_tokens parameter if specified, otherwise returns a conservative default.
 *
 * @param requestBody - Parsed request body
 * @returns Estimated output token count
 */
function estimateOutputTokens(requestBody: unknown): number {
  if (typeof requestBody !== "object" || requestBody === null) {
    return DEFAULT_OUTPUT_TOKENS_ESTIMATE;
  }

  const body = requestBody as Record<string, unknown>;

  // Check for max_tokens (OpenAI/Anthropic)
  if (typeof body.max_tokens === "number" && body.max_tokens > 0) {
    return body.max_tokens;
  }

  // Check for maxOutputTokens (Google)
  if (
    typeof body.generationConfig === "object" &&
    body.generationConfig !== null
  ) {
    const config = body.generationConfig as Record<string, unknown>;
    if (
      typeof config.maxOutputTokens === "number" &&
      config.maxOutputTokens > 0
    ) {
      return config.maxOutputTokens;
    }
  }

  // Default conservative estimate
  return DEFAULT_OUTPUT_TOKENS_ESTIMATE;
}

/**
 * Estimates the cost of a router request before it's made.
 *
 * This function:
 * 1. Estimates input/output token counts from the request body
 * 2. Fetches pricing data for the model
 * 3. Calculates estimated cost
 *
 * The estimate is intentionally conservative (tends to overestimate) to ensure
 * sufficient funds are reserved. The actual cost will be charged on settlement.
 *
 * @param params - Cost estimation parameters
 * @returns Estimated cost in dollars, or null if pricing unavailable
 *
 * @example
 * ```ts
 * const estimate = yield* estimateCost({
 *   provider: "anthropic",
 *   model: "claude-3-opus-20240229",
 *   requestBody: { messages: [...], max_tokens: 1024 }
 * });
 *
 * if (estimate) {
 *   console.log(`Estimated cost: $${estimate.cost.toFixed(4)}`);
 * }
 * ```
 */
export function estimateCost({
  provider,
  model,
  requestBody,
}: EstimateCostParams): Effect.Effect<EstimatedCost | null, Error> {
  return Effect.gen(function* () {
    const inputTokens = estimateInputTokens(requestBody);
    const outputTokens = estimateOutputTokens(requestBody);

    // Get pricing data
    const pricing = yield* getModelPricing(provider, model).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );

    if (!pricing) {
      return null;
    }

    // Calculate cost (convert from per-million to actual tokens)
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const totalCost = inputCost + outputCost;

    return {
      cost: totalCost,
      inputTokens,
      outputTokens,
    };
  });
}

/**
 * Gets a fallback cost estimate when model pricing is unavailable.
 *
 * Returns a conservative fixed estimate based on typical high-end model pricing.
 * This ensures reservations are made even when pricing data is unavailable.
 *
 * @param requestBody - Parsed request body for token estimation
 * @returns Conservative cost estimate
 */
export function getFallbackEstimate(requestBody: unknown): EstimatedCost {
  const inputTokens = estimateInputTokens(requestBody);
  const outputTokens = estimateOutputTokens(requestBody);

  // Use high-end pricing as fallback ($15/M input, $75/M output - Claude Opus level)
  const inputCost = (inputTokens / 1_000_000) * 15;
  const outputCost = (outputTokens / 1_000_000) * 75;

  return {
    cost: inputCost + outputCost,
    inputTokens,
    outputTokens,
  };
}
