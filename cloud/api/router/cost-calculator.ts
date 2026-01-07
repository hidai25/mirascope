/**
 * @fileoverview Base cost calculator and provider-specific implementations.
 *
 * Provides a unified interface for extracting usage from provider responses
 * and calculating costs using models.dev pricing data.
 */

import { Effect } from "effect";
import {
  getModelPricing,
  type TokenUsage,
  type CostBreakdown,
  type FormattedCostBreakdown,
} from "@/api/router/pricing";
import type { ProviderName } from "@/api/router/providers";

/**
 * Base cost calculator that handles shared logic for all providers.
 *
 * Subclasses implement provider-specific usage extraction.
 */
export abstract class BaseCostCalculator {
  protected readonly provider: ProviderName;

  constructor(provider: ProviderName) {
    this.provider = provider;
  }

  /**
   * Extracts token usage from a provider response.
   *
   * Must be implemented by each provider-specific calculator.
   *
   * @param body - The parsed provider response body
   * @returns Validated TokenUsage with non-negative numbers, or null if extraction fails
   */
  public abstract extractUsage(body: unknown): TokenUsage | null;

  /**
   * Extracts token usage from a streaming chunk.
   *
   * Must be implemented by each provider-specific calculator to handle
   * streaming-specific formats (e.g., OpenAI Responses API, Anthropic deltas).
   *
   * @param chunk - A parsed chunk from the streaming response
   * @returns Validated TokenUsage with non-negative numbers, or null if extraction fails
   */
  public abstract extractUsageFromStreamChunk(
    chunk: unknown,
  ): TokenUsage | null;

  /**
   * Calculates cost from TokenUsage using models.dev pricing data.
   *
   * @param modelId - The model ID
   * @param usage - Token usage data from the provider response
   * @returns Effect with cost data, or null if pricing unavailable
   */
  public calculate(
    modelId: string,
    usage: TokenUsage,
  ): Effect.Effect<
    {
      cost: CostBreakdown;
      formattedCost: FormattedCostBreakdown;
    } | null,
    Error
  > {
    return Effect.gen(this, function* () {
      // Get pricing data (null if unavailable)
      const pricing = yield* getModelPricing(this.provider, modelId).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      );

      if (!pricing) {
        return null;
      }

      // Calculate costs (all costs in models.dev are per million tokens)
      const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
      const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;

      const cacheReadCost =
        usage.cacheReadTokens && pricing.cache_read
          ? (usage.cacheReadTokens / 1_000_000) * pricing.cache_read
          : undefined;

      const cacheWriteCost =
        usage.cacheWriteTokens && pricing.cache_write
          ? (usage.cacheWriteTokens / 1_000_000) * pricing.cache_write
          : undefined;

      const totalCost =
        inputCost + outputCost + (cacheReadCost || 0) + (cacheWriteCost || 0);

      // Validate that costs are valid numbers (not NaN or negative)
      if (
        isNaN(inputCost) ||
        isNaN(outputCost) ||
        isNaN(totalCost) ||
        inputCost < 0 ||
        outputCost < 0 ||
        totalCost < 0
      ) {
        return null;
      }

      const cost: CostBreakdown = {
        inputCost,
        outputCost,
        cacheReadCost,
        cacheWriteCost,
        totalCost,
      };

      // Format costs as strings with 6 decimal places
      const formatCost = (value: number) => `$${value.toFixed(6)}`;

      const formattedCost: FormattedCostBreakdown = {
        input: formatCost(inputCost),
        output: formatCost(outputCost),
        cacheRead: cacheReadCost ? formatCost(cacheReadCost) : undefined,
        cacheWrite: cacheWriteCost ? formatCost(cacheWriteCost) : undefined,
        total: formatCost(totalCost),
      };

      return {
        cost,
        formattedCost,
      };
    });
  }
}

/**
 * OpenAI-specific cost calculator.
 *
 * Supports both:
 * - Completions API: uses prompt_tokens/completion_tokens
 * - Responses API: uses input_tokens/output_tokens
 */
export class OpenAICostCalculator extends BaseCostCalculator {
  constructor() {
    super("openai");
  }

  public extractUsage(body: unknown): TokenUsage | null {
    if (typeof body !== "object" || body === null) return null;

    const bodyObj = body as Record<string, unknown>;
    const usage = bodyObj.usage as Record<string, unknown> | undefined;

    if (!usage) return null;

    // Check for Responses API format (input_tokens/output_tokens)
    if ("input_tokens" in usage && "output_tokens" in usage) {
      const inputTokensDetails = usage.input_tokens_details as
        | { cached_tokens?: number }
        | undefined;

      return {
        inputTokens: usage.input_tokens as number,
        outputTokens: usage.output_tokens as number,
        cacheReadTokens: inputTokensDetails?.cached_tokens,
      };
    }

    // Fall back to Completions API format (prompt_tokens/completion_tokens)
    if ("prompt_tokens" in usage && "completion_tokens" in usage) {
      const promptTokensDetails = usage.prompt_tokens_details as
        | { cached_tokens?: number }
        | undefined;

      return {
        inputTokens: usage.prompt_tokens as number,
        outputTokens: usage.completion_tokens as number,
        cacheReadTokens: promptTokensDetails?.cached_tokens,
      };
    }

    return null;
  }

  /**
   * Extracts usage from streaming chunks, handling OpenAI Responses API format.
   *
   * OpenAI Responses API sends usage in a special wrapper:
   * { type: "response.completed", response: { usage: { ... } } }
   */
  public extractUsageFromStreamChunk(chunk: unknown): TokenUsage | null {
    if (typeof chunk !== "object" || chunk === null) return null;

    const obj = chunk as Record<string, unknown>;

    // Handle OpenAI Responses API format
    if (obj.type === "response.completed" && obj.response) {
      const response = obj.response as Record<string, unknown>;
      if (response.usage) {
        // Extract from nested response.usage
        return this.extractUsage(response);
      }
    }

    // Fall back to standard extraction (handles Completions API)
    return this.extractUsage(chunk);
  }
}

/**
 * Anthropic-specific cost calculator.
 *
 * IMPORTANT: Anthropic's input_tokens does NOT include cache tokens.
 * Total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *
 * CACHE PRICING NORMALIZATION:
 * Anthropic provides detailed cache breakdown via usage.cache_creation:
 * - ephemeral_5m_input_tokens: 5-minute TTL caches (cost 1.25x input price)
 * - ephemeral_1h_input_tokens: 1-hour TTL caches (cost 2.0x input price per Anthropic docs)
 *
 * We normalize these to a single cacheWriteTokens value by converting 1h tokens to
 * 5m-equivalent: 1h_normalized = 1h_tokens × (2.0 / 1.25) = 1h_tokens × 1.6
 *
 * This allows calculateCost() to use models.dev's 5m pricing (1.25x) for all cache writes,
 * while ensuring correct costs: 5m stays 1:1, 1h effectively costs 2.0x input price.
 *
 * TODO: At some point we will likely want to display the per-request cost-breakdown for users.
 * We'll need to update the cost calculators to store this information at that time.
 */
export class AnthropicCostCalculator extends BaseCostCalculator {
  constructor() {
    super("anthropic");
  }

  // Normalize: 5m tokens stay 1:1, 1h tokens scaled by 1.6
  static readonly EPHEMERAL_1H_CACHE_INPUT_TOKENS_MULTIPLIER = 1.6;

  public extractUsage(body: unknown): TokenUsage | null {
    if (typeof body !== "object" || body === null) return null;

    const usage = (
      body as {
        usage?: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          // Detailed cache breakdown (available in recent API versions)
          cache_creation?: {
            ephemeral_5m_input_tokens?: number;
            ephemeral_1h_input_tokens?: number;
          };
        };
      }
    ).usage;

    if (!usage) return null;

    const cacheReadTokens = usage.cache_read_input_tokens || 0;

    // Normalize cache write tokens for accurate pricing
    // If detailed breakdown is available, normalize 1h tokens to 5m-equivalent
    // Since 1h costs 2.0x input and 5m costs 1.25x input:
    //   1h_normalized = 1h_tokens * (2.0 / 1.25) = 1h_tokens * 1.6
    // This way, multiplying total by 5m price gives correct cost for both
    let cacheWriteTokens: number;
    const ephemeral5mTokens =
      usage.cache_creation?.ephemeral_5m_input_tokens || 0;
    const ephemeral1hTokens =
      usage.cache_creation?.ephemeral_1h_input_tokens || 0;

    if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
      cacheWriteTokens =
        ephemeral5mTokens +
        ephemeral1hTokens *
          AnthropicCostCalculator.EPHEMERAL_1H_CACHE_INPUT_TOKENS_MULTIPLIER;
    } else {
      // Fallback to aggregate value (backwards compatibility)
      cacheWriteTokens = usage.cache_creation_input_tokens || 0;
    }

    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
      cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
    };
  }

  /**
   * Extracts usage from streaming chunks.
   *
   * Anthropic provides cumulative token counts in message_delta events during streaming.
   * Each message_delta contains the running total of tokens used up to that point.
   * This ensures accurate usage tracking even if the stream is stopped early.
   */
  public extractUsageFromStreamChunk(chunk: unknown): TokenUsage | null {
    // Delegate to standard extraction - Anthropic format is the same for streaming
    return this.extractUsage(chunk);
  }
}

/**
 * Google AI-specific cost calculator.
 */
export class GoogleCostCalculator extends BaseCostCalculator {
  constructor() {
    super("google");
  }

  public extractUsage(body: unknown): TokenUsage | null {
    if (typeof body !== "object" || body === null) return null;

    const bodyObj = body as Record<string, unknown>;

    if (!bodyObj.usageMetadata) {
      return null;
    }

    const metadata = bodyObj.usageMetadata as
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
          cachedContentTokenCount?: number;
        }
      | undefined;

    if (
      !metadata ||
      metadata.promptTokenCount === undefined ||
      metadata.candidatesTokenCount === undefined
    ) {
      return null;
    }

    return {
      inputTokens: metadata.promptTokenCount,
      outputTokens: metadata.candidatesTokenCount,
      cacheReadTokens: metadata.cachedContentTokenCount,
    };
  }

  /**
   * Extracts usage from streaming chunks.
   *
   * Google streams usage in the final chunk with usageMetadata.
   */
  public extractUsageFromStreamChunk(chunk: unknown): TokenUsage | null {
    // Delegate to standard extraction - Google format is the same for streaming
    return this.extractUsage(chunk);
  }
}
