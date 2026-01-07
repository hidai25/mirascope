import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { estimateCost, getFallbackEstimate } from "@/api/router/cost-estimator";
import * as pricing from "@/api/router/pricing";

describe("cost-estimator", () => {
  describe("estimateCost", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("should estimate cost for OpenAI request with messages", async () => {
      const mockPricing = {
        input: 10, // $10 per million
        output: 30, // $30 per million
      };

      vi.spyOn(pricing, "getModelPricing").mockReturnValue(
        Effect.succeed(mockPricing),
      );

      const requestBody = {
        model: "gpt-4",
        messages: [
          { role: "user", content: "Hello world" }, // ~11 chars + 4 role = 15 chars = ~4 tokens
        ],
        max_tokens: 100,
      };

      const result = await Effect.runPromise(
        estimateCost({
          provider: "openai",
          model: "gpt-4",
          requestBody,
        }),
      );

      expect(result).toBeDefined();
      expect(result?.inputTokens).toBeGreaterThan(0);
      expect(result?.outputTokens).toBe(100);
      expect(result?.cost).toBeGreaterThan(0);
    });

    it("should estimate cost for Anthropic request with multimodal content", async () => {
      const mockPricing = {
        input: 15,
        output: 75,
      };

      vi.spyOn(pricing, "getModelPricing").mockReturnValue(
        Effect.succeed(mockPricing),
      );

      const requestBody = {
        model: "claude-3-opus-20240229",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What's in this image?" },
              { type: "image", source: { type: "base64", data: "..." } },
            ],
          },
        ],
        max_tokens: 500,
      };

      const result = await Effect.runPromise(
        estimateCost({
          provider: "anthropic",
          model: "claude-3-opus-20240229",
          requestBody,
        }),
      );

      expect(result).toBeDefined();
      expect(result?.inputTokens).toBeGreaterThan(0);
      expect(result?.outputTokens).toBe(500);
      expect(result?.cost).toBeGreaterThan(0);
    });

    it("should estimate cost for Google request with contents", async () => {
      const mockPricing = {
        input: 5,
        output: 15,
      };

      vi.spyOn(pricing, "getModelPricing").mockReturnValue(
        Effect.succeed(mockPricing),
      );

      const requestBody = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello from Google" }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 200,
        },
      };

      const result = await Effect.runPromise(
        estimateCost({
          provider: "google",
          model: "gemini-pro",
          requestBody,
        }),
      );

      expect(result).toBeDefined();
      expect(result?.inputTokens).toBeGreaterThan(0);
      expect(result?.outputTokens).toBe(200);
      expect(result?.cost).toBeGreaterThan(0);
    });

    it("should use default output tokens when max_tokens not specified", async () => {
      const mockPricing = {
        input: 10,
        output: 30,
      };

      vi.spyOn(pricing, "getModelPricing").mockReturnValue(
        Effect.succeed(mockPricing),
      );

      const requestBody = {
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = await Effect.runPromise(
        estimateCost({
          provider: "openai",
          model: "gpt-4",
          requestBody,
        }),
      );

      expect(result).toBeDefined();
      expect(result?.outputTokens).toBe(1000); // DEFAULT_OUTPUT_TOKENS_ESTIMATE
    });

    it("should return null when pricing unavailable", async () => {
      vi.spyOn(pricing, "getModelPricing").mockReturnValue(
        Effect.fail(new Error("Pricing not found")),
      );

      const requestBody = {
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = await Effect.runPromise(
        estimateCost({
          provider: "openai",
          model: "unknown-model",
          requestBody,
        }),
      );

      expect(result).toBeNull();
    });

    it("should handle empty request body", async () => {
      const mockPricing = {
        input: 10,
        output: 30,
      };

      vi.spyOn(pricing, "getModelPricing").mockReturnValue(
        Effect.succeed(mockPricing),
      );

      const result = await Effect.runPromise(
        estimateCost({
          provider: "openai",
          model: "gpt-4",
          requestBody: {},
        }),
      );

      expect(result).toBeDefined();
      expect(result?.inputTokens).toBeGreaterThan(0); // Fallback to stringifying
      expect(result?.outputTokens).toBe(1000);
    });

    it("should handle null request body", async () => {
      const mockPricing = {
        input: 10,
        output: 30,
      };

      vi.spyOn(pricing, "getModelPricing").mockReturnValue(
        Effect.succeed(mockPricing),
      );

      const result = await Effect.runPromise(
        estimateCost({
          provider: "openai",
          model: "gpt-4",
          requestBody: null,
        }),
      );

      expect(result).toBeDefined();
      expect(result?.inputTokens).toBe(0);
      expect(result?.outputTokens).toBe(1000);
    });
  });

  describe("getFallbackEstimate", () => {
    it("should return conservative estimate for OpenAI request", () => {
      const requestBody = {
        messages: [
          { role: "user", content: "Hello world" },
          { role: "assistant", content: "Hi there!" },
        ],
        max_tokens: 500,
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(500);
      expect(result.cost).toBeGreaterThan(0);

      // Should use high-end pricing ($15/M input, $75/M output)
      const expectedCost =
        (result.inputTokens / 1_000_000) * 15 +
        (result.outputTokens / 1_000_000) * 75;
      expect(result.cost).toBeCloseTo(expectedCost, 10);
    });

    it("should return conservative estimate with default output tokens", () => {
      const requestBody = {
        messages: [{ role: "user", content: "Test message" }],
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(1000); // Default
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle Google format", () => {
      const requestBody = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello from Google" }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 300,
        },
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(300);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle empty request body", () => {
      const result = getFallbackEstimate({});

      expect(result.inputTokens).toBeGreaterThan(0); // Fallback to stringify
      expect(result.outputTokens).toBe(1000);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle null request body", () => {
      const result = getFallbackEstimate(null);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(1000);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle multimodal content", () => {
      const requestBody = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What's this?" },
              { type: "image", source: "..." },
            ],
          },
        ],
        max_tokens: 200,
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(200);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle Google contents without parts", () => {
      const requestBody = {
        contents: [
          {
            role: "user",
          },
        ],
        generationConfig: {
          maxOutputTokens: 100,
        },
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(100);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle Google contents without role", () => {
      const requestBody = {
        contents: [
          {
            parts: [{ text: "Hello" }],
          },
        ],
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(1000);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle Google contents with non-text parts", () => {
      const requestBody = {
        contents: [
          {
            role: "user",
            parts: [{ image: "base64data" }, { video: "url" }],
          },
        ],
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(1000);
      expect(result.cost).toBeGreaterThan(0);
    });

    it("should handle invalid maxOutputTokens (zero)", () => {
      const requestBody = {
        messages: [{ role: "user", content: "Test" }],
        generationConfig: {
          maxOutputTokens: 0,
        },
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.outputTokens).toBe(1000); // Should use default
    });

    it("should handle invalid maxOutputTokens (negative)", () => {
      const requestBody = {
        messages: [{ role: "user", content: "Test" }],
        generationConfig: {
          maxOutputTokens: -100,
        },
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.outputTokens).toBe(1000); // Should use default
    });

    it("should handle invalid max_tokens (zero)", () => {
      const requestBody = {
        messages: [{ role: "user", content: "Test" }],
        max_tokens: 0,
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.outputTokens).toBe(1000); // Should use default
    });

    it("should handle messages without role", () => {
      const requestBody = {
        messages: [{ content: "Test message" }],
        max_tokens: 100,
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(100);
    });

    it("should handle messages with non-string role", () => {
      const requestBody = {
        messages: [{ role: 123, content: "Test" }],
        max_tokens: 100,
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(100);
    });

    it("should handle messages with content that is neither string nor array", () => {
      const requestBody = {
        messages: [{ role: "user", content: null }],
        max_tokens: 100,
      };

      const result = getFallbackEstimate(requestBody);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBe(100);
    });
  });
});
