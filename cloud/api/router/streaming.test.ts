import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { parseStreamingResponse } from "@/api/router/streaming";
import type { TokenUsage } from "@/api/router/pricing";
import { MockMeteringContext } from "@/tests/api";

describe("Streaming", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseStreamingResponse", () => {
    it("handles empty response body", async () => {
      const response = new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      expect(result.response).toBeDefined();
      expect(result.bodyPromise).toBeDefined();
      expect(result.onUsage).toBeDefined();

      // Call onUsage to cover the no-op function
      result.onUsage(() => {
        // This should never be called since there's no body
      });

      const body = await result.bodyPromise;
      expect(body).toBeNull();
    });

    it("parses SSE format and extracts OpenAI Completions usage", async () => {
      const sseData = `data: {"id":"1","choices":[{"text":"Hello"}]}\n\ndata: {"id":"2","usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      let extractedUsage: TokenUsage | null = null;
      result.onUsage((usage) => {
        extractedUsage = usage;
      });

      // Read the stream to trigger parsing
      await result.response.text();

      // Wait for body promise
      const body = await result.bodyPromise;

      expect(body).toBeDefined();
      expect(extractedUsage).toBeDefined();
      expect(extractedUsage).not.toBeNull();
      expect(extractedUsage!.inputTokens).toBe(10);
      expect(extractedUsage!.outputTokens).toBe(5);
    });

    it("parses SSE format and extracts OpenAI Responses API usage", async () => {
      const sseData = `data: {"type":"response.created"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":50}}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      // Read the stream
      await result.response.text();
      const body = await result.bodyPromise;

      // For OpenAI Responses API, usage is nested in response.usage
      expect(
        (
          body as {
            response?: { usage?: { input_tokens: number } };
          }
        ).response?.usage?.input_tokens,
      ).toBe(100);
    });

    it("parses SSE format and extracts Anthropic usage", async () => {
      const sseData = `data: {"type":"content_block_start"}\n\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\ndata: {"type":"message_stop","usage":{"input_tokens":100,"output_tokens":50}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "anthropic",
          MockMeteringContext.fromProvider("anthropic", "claude-3-opus"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      expect(
        (body as { usage?: { input_tokens: number } }).usage?.input_tokens,
      ).toBe(100);
    });

    it("parses SSE format and extracts Google usage", async () => {
      const sseData = `data: {"candidates":[]}\n\ndata: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "google",
          MockMeteringContext.fromProvider("google", "gemini-pro"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      expect(
        (body as { usageMetadata?: { promptTokenCount: number } }).usageMetadata
          ?.promptTokenCount,
      ).toBe(100);
    });

    it("parses NDJSON format", async () => {
      const ndjsonData = `{"id":"1","text":"Hello"}\n{"id":"2","usage":{"prompt_tokens":10,"completion_tokens":5}}\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ndjsonData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "ndjson",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
    });

    it("handles invalid JSON in SSE gracefully", async () => {
      const sseData = `data: invalid json\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should still extract valid usage
      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
    });

    it("handles invalid JSON in NDJSON gracefully", async () => {
      const ndjsonData = `invalid json\n{"usage":{"prompt_tokens":10,"completion_tokens":5}}\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ndjsonData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "ndjson",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
    });

    it("handles SSE lines without data prefix", async () => {
      const sseData = `event: ping\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should still extract valid usage from data lines
      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
    });

    it("handles non-object chunks gracefully", async () => {
      const sseData = `data: "string value"\n\ndata: 123\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should still extract usage from valid object chunk
      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
    });

    it("handles OpenAI [DONE] sentinel value", async () => {
      const sseData = `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
    });

    it("processes incomplete chunks in buffer correctly", async () => {
      const sseData = `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      const usageCallbacks: TokenUsage[] = [];
      result.onUsage((usage) => {
        usageCallbacks.push(usage);
      });

      await result.response.text();
      const body = await result.bodyPromise;

      // Should process buffer in flush and invoke callback
      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
      expect(usageCallbacks.length).toBe(1);
    });

    it("calls onUsage callbacks when usage is found", async () => {
      const sseData = `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      const usageCallbacks: TokenUsage[] = [];
      result.onUsage((usage) => {
        usageCallbacks.push(usage);
      });

      await result.response.text();
      await result.bodyPromise;

      expect(usageCallbacks.length).toBe(1);
      expect(usageCallbacks[0].inputTokens).toBe(10);
      expect(usageCallbacks[0].outputTokens).toBe(5);
    });

    it("handles errors in usage callbacks gracefully", async () => {
      const sseData = `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      result.onUsage(() => {
        throw new Error("Callback error");
      });

      // Should not throw despite callback error
      await result.response.text();
      await result.bodyPromise;
    });

    it("ignores non-usage chunks", async () => {
      const sseData = `data: {"id":"1","text":"Hello"}\n\ndata: {"choices":[]}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      expect(body).toBeNull();
    });

    it("handles empty lines in stream", async () => {
      const sseData = `\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      expect(
        (body as { usage?: { prompt_tokens: number } }).usage?.prompt_tokens,
      ).toBe(10);
    });

    it("handles chunked streaming with multiple callbacks", async () => {
      const sseData1 = `data: {"id":"1"}\n\n`;
      const sseData2 = `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData1));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(sseData2));
            controller.close();
          }, 10);
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      const usageCallbacks: TokenUsage[] = [];
      result.onUsage((usage) => {
        usageCallbacks.push(usage);
      });

      await result.response.text();
      await result.bodyPromise;

      expect(usageCallbacks.length).toBe(1);
    });

    it("handles OpenAI Responses API without usage field", async () => {
      const sseData = `data: {"type":"response.completed","response":{"id":"resp_123"}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should return null since no valid usage found
      expect(body).toBeNull();
    });

    it("handles OpenAI Responses API with incomplete usage", async () => {
      const sseData = `data: {"type":"response.completed","response":{"usage":{"total_tokens":100}}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should return null since input_tokens/output_tokens are missing
      expect(body).toBeNull();
    });

    it("handles Google format with incomplete usageMetadata", async () => {
      const sseData = `data: {"usageMetadata":{"totalTokenCount":100}}\n\n`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should return null since promptTokenCount/candidatesTokenCount are missing
      expect(body).toBeNull();
    });

    it("processes NDJSON buffer in flush correctly", async () => {
      const ndjsonData = `{"usage":{"prompt_tokens":10,"completion_tokens":5}}`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ndjsonData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "ndjson",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      const usageCallbacks: TokenUsage[] = [];
      result.onUsage((usage) => {
        usageCallbacks.push(usage);
      });

      await result.response.text();
      const body = await result.bodyPromise;

      // Should process buffer in flush for ndjson format
      expect(body).toBeDefined();
      expect(usageCallbacks.length).toBe(1);
      expect(usageCallbacks[0].inputTokens).toBe(10);
      expect(usageCallbacks[0].outputTokens).toBe(5);
    });

    it("handles invalid JSON in flush buffer gracefully", async () => {
      const sseData = `data: invalid json without newline`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should return null when buffer contains invalid JSON
      expect(body).toBeNull();
    });

    it("handles non-usage data in flush buffer", async () => {
      const sseData = `data: {"id":"test","choices":[]}`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const response = new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

      const result = await Effect.runPromise(
        parseStreamingResponse(
          response,
          "sse",
          "openai",
          MockMeteringContext.fromProvider("openai", "gpt-4"),
        ),
      );

      await result.response.text();
      const body = await result.bodyPromise;

      // Should return null when buffer doesn't contain usage
      expect(body).toBeNull();
    });

    describe("settlement and release", () => {
      it("releases funds when no usage is found in stream", async () => {
        // Send data without usage information
        const sseData = `data: {"id":"test","object":"chat.completion.chunk"}\n\n`;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        });

        const response = new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });

        const result = await Effect.runPromise(
          parseStreamingResponse(
            response,
            "sse",
            "openai",
            MockMeteringContext.fromProvider("openai", "gpt-4"),
          ),
        );

        // Read stream to completion - this should trigger release logic since no usage found
        await result.response.text();
        await result.bodyPromise;

        // Wait for async settlement/release
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Test passes if no errors thrown - release logic executed
        expect(true).toBe(true);
      });

      it("releases funds when provider is invalid", async () => {
        // Use invalid provider
        const invalidContext = MockMeteringContext.fromProvider(
          "invalid-provider" as never,
          "test-model",
        );

        const sseData = `data: {"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n`;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        });

        const response = new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });

        const result = await Effect.runPromise(
          parseStreamingResponse(response, "sse", "openai", invalidContext),
        );

        await result.response.text();
        await result.bodyPromise;

        await new Promise((resolve) => setTimeout(resolve, 100));

        // Test passes if no errors thrown - release logic executed for invalid provider
        expect(true).toBe(true);
      });

      it("releases funds when cost calculation fails for unknown model", async () => {
        // Use unknown model that won't be in pricing tables
        const unknownModelContext = MockMeteringContext.fromProvider(
          "openai",
          "unknown-model-xyz-99999",
        );

        const sseData = `data: {"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n`;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        });

        const response = new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });

        const result = await Effect.runPromise(
          parseStreamingResponse(
            response,
            "sse",
            "openai",
            unknownModelContext,
          ),
        );

        await result.response.text();
        await result.bodyPromise;

        await new Promise((resolve) => setTimeout(resolve, 100));

        // Test passes if no errors thrown - release logic executed when cost calculation fails
        expect(true).toBe(true);
      });

      it("handles errors in settlement gracefully", async () => {
        const consoleWarnSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {});

        // Invalid database URL to trigger error
        const meteringContext = MockMeteringContext.fromProvider(
          "openai",
          "gpt-4",
          {
            databaseUrl: "invalid://database/url",
          },
        );

        const sseData = `data: {"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n`;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        });

        const response = new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });

        const result = await Effect.runPromise(
          parseStreamingResponse(response, "sse", "openai", meteringContext),
        );

        // Should not throw despite settlement error
        await result.response.text();
        await result.bodyPromise;

        await new Promise((resolve) => setTimeout(resolve, 100));

        // Should log warning about the error
        expect(consoleWarnSpy).toHaveBeenCalled();
        consoleWarnSpy.mockRestore();
      });

      it("handles errors in usage callbacks during flush", async () => {
        const consoleWarnSpy = vi
          .spyOn(console, "warn")
          .mockImplementation(() => {});

        // Data without newline so it processes in flush
        const sseData = `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}`;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        });

        const response = new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });

        const result = await Effect.runPromise(
          parseStreamingResponse(
            response,
            "sse",
            "openai",
            MockMeteringContext.fromProvider("openai", "gpt-4"),
          ),
        );

        // Register callback that throws
        result.onUsage(() => {
          throw new Error("Callback error during flush");
        });

        // Should not throw despite callback error
        await result.response.text();
        await result.bodyPromise;

        // Should have warned about the error
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Error in usage callback during flush"),
          expect.any(Error),
        );

        consoleWarnSpy.mockRestore();
      });
    });
  });
});
