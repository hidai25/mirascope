/**
 * @fileoverview Utilities for parsing and extracting usage from streaming responses.
 *
 * Handles Server-Sent Events (SSE) and NDJSON streaming formats from AI providers,
 * extracting usage information while allowing the stream to pass through to the client.
 */

import { Effect } from "effect";
import { ProxyError } from "@/errors";
import {
  getCostCalculator,
  isValidProvider,
  type ProviderName,
} from "@/api/router/providers";
import type { TokenUsage } from "@/api/router/pricing";
import { Payments } from "@/payments";
import { Database } from "@/db";

/**
 * Result of parsing a streaming response.
 */
export interface StreamParseResult {
  /** The original response with a fresh stream for the client */
  response: Response;
  /** Promise that resolves to the final chunk containing usage data (or null if no usage found) */
  bodyPromise: Promise<unknown>;
  /** Register a callback to be invoked with usage data when found during streaming */
  onUsage: (callback: (usage: TokenUsage) => void) => void;
}

/**
 * Metering context for streaming responses.
 *
 * Provides the necessary information to calculate costs and settle/release
 * fund reservations when usage data is extracted from a streaming response.
 */
export interface StreamMeteringContext {
  /** The Stripe customer ID to charge */
  stripeCustomerId: string;
  /** Stripe API secret key for authentication */
  stripeSecretKey: string;
  /** Stripe price ID for router usage tracking */
  routerPriceId: string;
  /** Stripe meter ID for router usage tracking */
  routerMeterId: string;
  /** Provider name (e.g., "openai", "anthropic", "google") */
  provider: ProviderName;
  /** Model ID for cost calculation */
  model: string;
  /** Reservation ID for fund settlement */
  reservationId: string;
  /** Database connection string for reservation settlement */
  databaseUrl: string;
}

/**
 * Parses a single Server-Sent Event (SSE) line.
 *
 * SSE format: `data: {...}\n\n`
 *
 * @param line - A single line from the SSE stream
 * @returns Parsed JSON object or null if not parseable
 */
function parseSSELine(line: string): unknown {
  // SSE lines start with "data: "
  if (!line.startsWith("data: ")) {
    return null;
  }

  const data = line.slice(6); // Remove "data: " prefix

  // OpenAI sends "[DONE]" as the final message
  if (data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Parses an NDJSON line.
 *
 * @param line - A single line from the NDJSON stream
 * @returns Parsed JSON object or null if not parseable
 */
function parseNDJSONLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Parses a streaming response to extract usage data and handle fund settlement.
 *
 * This function:
 * 1. Intercepts the response stream using a TransformStream
 * 2. Parses each chunk as it streams (SSE or NDJSON format)
 * 3. Extracts usage information from chunks using provider-specific cost calculator
 * 4. Calculates costs and settles/releases fund reservations when streaming completes
 * 5. Returns the response with preserved streaming to the client
 *
 * The original response stream is passed through unmodified, so the client receives
 * all chunks in real-time. Usage extraction and settlement happen transparently.
 *
 * @param response - The streaming response from the provider
 * @param format - The streaming format ("sse" or "ndjson")
 * @param provider - The provider name for usage extraction
 * @param meteringContext - Context for automatic cost calculation and fund settlement
 * @returns Effect that resolves to StreamParseResult with response and usage data
 */
export function parseStreamingResponse(
  response: Response,
  format: "sse" | "ndjson",
  provider: ProviderName,
  meteringContext: StreamMeteringContext,
): Effect.Effect<StreamParseResult, ProxyError> {
  return Effect.succeed(
    (() => {
      const originalBody = response.body;
      if (!originalBody) {
        return {
          response,
          bodyPromise: Promise.resolve(null),
          onUsage: () => {},
        };
      }

      // Get the provider-specific cost calculator for usage extraction
      const costCalculator = getCostCalculator(provider);

      let lastUsageChunk: unknown = null;
      let buffer = "";
      const usageCallbacks: Array<(usage: TokenUsage) => void> = [];

      // Promise that will resolve when stream completes
      let resolveBodyPromise: (value: unknown) => void;
      const bodyPromise = new Promise((resolve) => {
        resolveBodyPromise = resolve;
      });

      // Create a transform stream that intercepts chunks as they pass through
      const transformStream = new TransformStream({
        transform(chunk: AllowSharedBufferSource | undefined, controller) {
          // Forward the chunk to the client immediately
          controller.enqueue(chunk);

          // Also parse it for usage
          const decoder = new TextDecoder();
          buffer += decoder.decode(chunk, { stream: true });

          // Split by newlines to process complete chunks
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            const parsed =
              format === "sse" ? parseSSELine(line) : parseNDJSONLine(line);
            if (!parsed) continue;

            // Check if this chunk contains usage information using provider-specific calculator
            const usage = costCalculator.extractUsageFromStreamChunk(parsed);
            if (usage) {
              lastUsageChunk = parsed; // Store the full chunk for bodyPromise
              // Invoke all registered callbacks immediately with extracted usage
              usageCallbacks.forEach((callback) => {
                try {
                  callback(usage);
                } catch (error) {
                  // Warn but don't interrupt stream
                  console.warn(
                    "Error in usage callback (stream not interrupted):",
                    error,
                  );
                }
              });
            }
          }
        },
        async flush() {
          // Process any remaining buffer
          if (buffer.trim()) {
            const parsed =
              format === "sse" ? parseSSELine(buffer) : parseNDJSONLine(buffer);
            if (parsed) {
              const usage = costCalculator.extractUsageFromStreamChunk(parsed);
              if (usage) {
                lastUsageChunk = parsed;
                usageCallbacks.forEach((callback) => {
                  try {
                    callback(usage);
                  } catch (error) {
                    // Warn but don't interrupt stream
                    console.warn(
                      "Error in usage callback during flush (stream not interrupted):",
                      error,
                    );
                  }
                });
              }
            }
          }

          // Settle or release reservation for streaming usage
          if (lastUsageChunk) {
            try {
              await Effect.runPromise(
                Effect.gen(function* () {
                  // Validate provider before calculating cost
                  if (!isValidProvider(meteringContext.provider)) {
                    // Release funds if provider is invalid
                    const payments = yield* Payments;
                    yield* payments.products.router
                      .releaseFunds(meteringContext.reservationId)
                      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
                    return;
                  }

                  // Calculate actual cost from usage data
                  // Note: lastUsageChunk is guaranteed to have usage since it was only set when extractUsageFromStreamChunk succeeded
                  const calculator = getCostCalculator(
                    meteringContext.provider,
                  );
                  const usage =
                    calculator.extractUsageFromStreamChunk(lastUsageChunk)!; // Non-null assertion safe here

                  const costResult = yield* calculator.calculate(
                    meteringContext.model,
                    usage,
                  );

                  const payments = yield* Payments;

                  if (costResult && costResult.cost.totalCost > 0) {
                    // Settle reservation with actual cost
                    yield* payments.products.router
                      .settleFunds(
                        meteringContext.reservationId,
                        costResult.cost.totalCost,
                      )
                      .pipe(
                        Effect.catchAll((error) => {
                          console.error(
                            "Failed to settle streaming funds:",
                            error,
                          );
                          return Effect.succeed(undefined);
                        }),
                      );
                  } else {
                    // No usage or calculation failed, release funds
                    yield* payments.products.router
                      .releaseFunds(meteringContext.reservationId)
                      .pipe(
                        Effect.catchAll((error) => {
                          console.error(
                            "Failed to release streaming funds:",
                            error,
                          );
                          return Effect.succeed(undefined);
                        }),
                      );
                  }
                }).pipe(
                  Effect.provide(
                    Database.Live({
                      database: {
                        connectionString: meteringContext.databaseUrl,
                      },
                      payments: {
                        apiKey: meteringContext.stripeSecretKey,
                        routerPriceId: meteringContext.routerPriceId,
                        routerMeterId: meteringContext.routerMeterId,
                      },
                    }),
                  ),
                ),
              );
            } catch (error) {
              // Warn but don't interrupt stream
              console.warn(
                "Error during fund settlement/release (stream not interrupted):",
                error,
              );
            }
          }

          // Resolve the promise now that stream is complete
          resolveBodyPromise(lastUsageChunk);
        },
      });

      // Pipe the original stream through our transform
      const transformedStream = originalBody.pipeThrough(transformStream);

      // Create a new response with the transformed stream
      const clientResponse = new Response(transformedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });

      return {
        response: clientResponse,
        bodyPromise,
        onUsage: (callback: (usage: TokenUsage) => void) => {
          usageCallbacks.push(callback);
        },
      };
    })(),
  );
}
