/**
 * @fileoverview Utilities for parsing and extracting usage from streaming responses.
 *
 * Handles Server-Sent Events (SSE) and NDJSON streaming formats from AI providers,
 * extracting usage information while allowing the stream to pass through to the client.
 */

import { Effect } from "effect";
import { ProxyError } from "@/errors";
import { getCostCalculator, type ProviderName } from "@/api/router/providers";
import type { TokenUsage } from "@/api/router/pricing";

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
 * Parses a streaming response to extract usage data.
 *
 * This function:
 * 1. Intercepts the response stream using a TransformStream
 * 2. Parses each chunk as it streams (SSE or NDJSON format)
 * 3. Extracts usage information from chunks using provider-specific cost calculator
 * 4. Returns the response with preserved streaming to the client
 *
 * The original response stream is passed through unmodified, so the client receives
 * all chunks in real-time. Usage extraction happens transparently.
 *
 * @param response - The streaming response from the provider
 * @param format - The streaming format ("sse" or "ndjson")
 * @param provider - The provider name for usage extraction
 * @returns Effect that resolves to StreamParseResult with response and usage data
 */
export function parseStreamingResponse(
  response: Response,
  format: "sse" | "ndjson",
  provider: ProviderName,
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
                } catch {
                  // Ignore callback errors to prevent stream interruption
                }
              });
            }
          }
        },
        flush() {
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
                  } catch /* v8 ignore next */ {
                    // Ignore callback errors to prevent stream interruption
                  }
                });
              }
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
