import {
  describe,
  it,
  expect,
  checkClickHouseAvailable,
} from "@/tests/clickhouse";
import { Effect, Layer } from "effect";
import { ClickHouseClient } from "@/clickhouse/client";
import { ClickHouseSearchService } from "@/clickhouse/search";
import { SettingsService, type Settings } from "@/settings";
import { beforeAll, afterAll, it as vitestIt } from "vitest";

// Track if ClickHouse is available for conditional test skipping
let clickHouseAvailable = false;

// Test data IDs
const TEST_ENVIRONMENT_ID = "00000000-0000-0000-0000-000000000001";
const TEST_PROJECT_ID = "00000000-0000-0000-0000-000000000002";
const TEST_ORG_ID = "00000000-0000-0000-0000-000000000003";
const TEST_TRACE_ID = "abc123def456";
const TEST_SPAN_ID_1 = "span001";
const TEST_SPAN_ID_2 = "span002";

const createTestSettings = (): Settings => ({
  env: "local",
  CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? "default",
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? "clickhouse",
  CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE ?? "mirascope_analytics",
  CLICKHOUSE_TLS_ENABLED: false,
  CLICKHOUSE_TLS_HOSTNAME_VERIFY: true,
});

const makeTestLayers = () => {
  const settings = createTestSettings();
  const settingsLayer = Layer.succeed(SettingsService, settings);
  const clickHouseLayer = ClickHouseClient.Default.pipe(
    Layer.provide(settingsLayer),
  );
  const searchLayer = ClickHouseSearchService.Default.pipe(
    Layer.provide(clickHouseLayer),
  );
  return Layer.mergeAll(searchLayer, clickHouseLayer);
};

// Setup and teardown for test data
async function setupTestData(): Promise<void> {
  const settings = createTestSettings();
  const authHeader = `Basic ${btoa(`${settings.CLICKHOUSE_USER ?? "default"}:${settings.CLICKHOUSE_PASSWORD ?? ""}`)}`;
  const baseUrl = settings.CLICKHOUSE_URL;
  const database = settings.CLICKHOUSE_DATABASE ?? "mirascope_analytics";

  // Insert test spans
  const testSpans = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      trace_db_id: "22222222-2222-2222-2222-222222222222",
      trace_id: TEST_TRACE_ID,
      span_id: TEST_SPAN_ID_1,
      parent_span_id: null,
      environment_id: TEST_ENVIRONMENT_ID,
      project_id: TEST_PROJECT_ID,
      organization_id: TEST_ORG_ID,
      start_time: "2024-01-15T10:00:00.000000000",
      end_time: "2024-01-15T10:00:01.000000000",
      duration_ms: 1000,
      name: "llm call openai",
      kind: 1,
      status_code: 0,
      status_message: null,
      model: "gpt-4",
      provider: "openai",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost_usd: 0.01,
      function_id: null,
      function_name: "my_function",
      function_version: "v1",
      error_type: null,
      error_message: null,
      attributes: "{}",
      events: null,
      links: null,
      service_name: "test-service",
      service_version: "1.0.0",
      resource_attributes: null,
      created_at: "2024-01-15T10:00:00.000",
      _version: Date.now(),
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      trace_db_id: "22222222-2222-2222-2222-222222222222",
      trace_id: TEST_TRACE_ID,
      span_id: TEST_SPAN_ID_2,
      parent_span_id: TEST_SPAN_ID_1,
      environment_id: TEST_ENVIRONMENT_ID,
      project_id: TEST_PROJECT_ID,
      organization_id: TEST_ORG_ID,
      start_time: "2024-01-15T10:00:00.100000000",
      end_time: "2024-01-15T10:00:00.500000000",
      duration_ms: 400,
      name: "embedding call",
      kind: 1,
      status_code: 0,
      status_message: null,
      model: "text-embedding-3-small",
      provider: "openai",
      input_tokens: 50,
      output_tokens: 0,
      total_tokens: 50,
      cost_usd: 0.001,
      function_id: null,
      function_name: null,
      function_version: null,
      error_type: null,
      error_message: null,
      attributes: "{}",
      events: null,
      links: null,
      service_name: "test-service",
      service_version: "1.0.0",
      resource_attributes: null,
      created_at: "2024-01-15T10:00:00.100",
      _version: Date.now(),
    },
  ];

  const insertQuery = `INSERT INTO spans_analytics FORMAT JSONEachRow`;
  const body = testSpans.map((span) => JSON.stringify(span)).join("\n");

  const urlParams = new URLSearchParams({
    database,
    query: insertQuery,
  });

  const response = await fetch(`${baseUrl}/?${urlParams}`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "text/plain",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(`Failed to insert test data: ${text}`);
  }
}

async function cleanupTestData(): Promise<void> {
  const settings = createTestSettings();
  const authHeader = `Basic ${btoa(`${settings.CLICKHOUSE_USER ?? "default"}:${settings.CLICKHOUSE_PASSWORD ?? ""}`)}`;
  const baseUrl = settings.CLICKHOUSE_URL;
  const database = settings.CLICKHOUSE_DATABASE ?? "mirascope_analytics";

  const deleteQuery = `ALTER TABLE spans_analytics DELETE WHERE environment_id = '${TEST_ENVIRONMENT_ID}'`;

  const urlParams = new URLSearchParams({ database });

  await fetch(`${baseUrl}/?${urlParams}`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "text/plain",
    },
    body: deleteQuery,
  });
}

beforeAll(async () => {
  clickHouseAvailable = await checkClickHouseAvailable();
  if (!clickHouseAvailable) {
    console.warn(
      "⚠️ ClickHouse not available - skipping integration tests. " +
        "Run `bun run clickhouse:start` to enable.",
    );
  } else {
    await setupTestData();
  }
});

afterAll(async () => {
  if (clickHouseAvailable) {
    await cleanupTestData();
  }
});

describe("ClickHouseSearchService", () => {
  describe("search", () => {
    it.effect("returns spans matching query", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          query: "llm",
        });

        expect(result.spans.length).toBeGreaterThan(0);
        expect(result.spans[0]?.name).toContain("llm");
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("returns empty array for non-matching query", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          query: "nonexistentqueryterm",
        });

        expect(result.spans).toHaveLength(0);
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("filters by model", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          model: ["gpt-4"],
        });

        expect(result.spans.length).toBeGreaterThan(0);
        for (const span of result.spans) {
          expect(span.model).toBe("gpt-4");
        }
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("filters by provider", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          provider: ["openai"],
        });

        expect(result.spans.length).toBeGreaterThan(0);
        for (const span of result.spans) {
          expect(span.provider).toBe("openai");
        }
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("respects limit and offset", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          limit: 1,
          offset: 0,
        });

        expect(result.spans.length).toBeLessThanOrEqual(1);
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("sorts by start_time descending by default", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
        });

        if (result.spans.length >= 2) {
          const first = new Date(result.spans[0].startTime).getTime();
          const second = new Date(result.spans[1].startTime).getTime();
          expect(first).toBeGreaterThanOrEqual(second);
        }
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("returns total count and hasMore", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          limit: 1,
        });

        expect(typeof result.total).toBe("number");
        expect(typeof result.hasMore).toBe("boolean");
      }).pipe(Effect.provide(makeTestLayers())),
    );
  });

  describe("getTraceDetail", () => {
    it.effect("returns all spans for a trace", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.getTraceDetail({
          environmentId: TEST_ENVIRONMENT_ID,
          traceId: TEST_TRACE_ID,
        });

        expect(result.traceId).toBe(TEST_TRACE_ID);
        expect(result.spans.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("identifies root span", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.getTraceDetail({
          environmentId: TEST_ENVIRONMENT_ID,
          traceId: TEST_TRACE_ID,
        });

        expect(result.rootSpanId).toBe(TEST_SPAN_ID_1);
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("calculates total duration", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.getTraceDetail({
          environmentId: TEST_ENVIRONMENT_ID,
          traceId: TEST_TRACE_ID,
        });

        expect(result.totalDurationMs).toBeGreaterThan(0);
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("returns empty for non-existent trace", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.getTraceDetail({
          environmentId: TEST_ENVIRONMENT_ID,
          traceId: "non-existent-trace-id",
        });

        expect(result.spans).toHaveLength(0);
        expect(result.rootSpanId).toBeNull();
        expect(result.totalDurationMs).toBeNull();
      }).pipe(Effect.provide(makeTestLayers())),
    );
  });

  describe("getAnalyticsSummary", () => {
    it.effect("returns analytics summary", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.getAnalyticsSummary({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
        });

        expect(typeof result.totalSpans).toBe("number");
        expect(typeof result.errorRate).toBe("number");
        expect(typeof result.totalTokens).toBe("number");
        expect(Array.isArray(result.topModels)).toBe(true);
        expect(Array.isArray(result.topFunctions)).toBe(true);
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("returns top models", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.getAnalyticsSummary({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
        });

        if (result.topModels.length > 0) {
          expect(result.topModels[0]?.model).toBeDefined();
          expect(result.topModels[0]?.count).toBeGreaterThan(0);
        }
      }).pipe(Effect.provide(makeTestLayers())),
    );
  });

  describe("validation", () => {
    vitestIt("throws on time range exceeding 30 days for search", async () => {
      if (!clickHouseAvailable) return;

      const program = Effect.gen(function* () {
        const searchService = yield* ClickHouseSearchService;

        yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-03-01"), // 60 days
        });
      }).pipe(Effect.provide(makeTestLayers()));

      await expect(Effect.runPromise(program)).rejects.toThrow(
        /Time range exceeds maximum/,
      );
    });

    vitestIt("throws on query exceeding max length", async () => {
      if (!clickHouseAvailable) return;

      const longQuery = "a".repeat(501);

      const program = Effect.gen(function* () {
        const searchService = yield* ClickHouseSearchService;

        yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          query: longQuery,
        });
      }).pipe(Effect.provide(makeTestLayers()));

      await expect(Effect.runPromise(program)).rejects.toThrow(
        /Query exceeds maximum length/,
      );
    });

    vitestIt("throws on offset exceeding max", async () => {
      if (!clickHouseAvailable) return;

      const program = Effect.gen(function* () {
        const searchService = yield* ClickHouseSearchService;

        yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          offset: 10001,
        });
      }).pipe(Effect.provide(makeTestLayers()));

      await expect(Effect.runPromise(program)).rejects.toThrow(
        /Offset exceeds maximum/,
      );
    });

    vitestIt("throws on too many attribute filters", async () => {
      if (!clickHouseAvailable) return;

      const tooManyFilters = Array.from({ length: 11 }, (_, i) => ({
        key: `attr${i}`,
        operator: "eq" as const,
        value: "test",
      }));

      const program = Effect.gen(function* () {
        const searchService = yield* ClickHouseSearchService;

        yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          attributeFilters: tooManyFilters,
        });
      }).pipe(Effect.provide(makeTestLayers()));

      await expect(Effect.runPromise(program)).rejects.toThrow(
        /Too many attribute filters/,
      );
    });

    vitestIt("throws on too many model values", async () => {
      if (!clickHouseAvailable) return;

      const tooManyModels = Array.from({ length: 21 }, (_, i) => `model${i}`);

      const program = Effect.gen(function* () {
        const searchService = yield* ClickHouseSearchService;

        yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
          model: tooManyModels,
        });
      }).pipe(Effect.provide(makeTestLayers()));

      await expect(Effect.runPromise(program)).rejects.toThrow(
        /Too many model values/,
      );
    });
  });

  describe("transformations", () => {
    it.effect("transforms snake_case to camelCase in search results", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.search({
          environmentId: TEST_ENVIRONMENT_ID,
          startTime: new Date("2024-01-01"),
          endTime: new Date("2024-01-31"),
        });

        if (result.spans.length > 0) {
          const span = result.spans[0];
          // Verify camelCase keys exist
          expect("traceId" in span).toBe(true);
          expect("spanId" in span).toBe(true);
          expect("startTime" in span).toBe(true);
          expect("durationMs" in span).toBe(true);
          expect("totalTokens" in span).toBe(true);
          expect("functionId" in span).toBe(true);
          expect("functionName" in span).toBe(true);
        }
      }).pipe(Effect.provide(makeTestLayers())),
    );

    it.effect("transforms snake_case to camelCase in trace detail", () =>
      Effect.gen(function* () {
        if (!clickHouseAvailable) return;

        const searchService = yield* ClickHouseSearchService;

        const result = yield* searchService.getTraceDetail({
          environmentId: TEST_ENVIRONMENT_ID,
          traceId: TEST_TRACE_ID,
        });

        if (result.spans.length > 0) {
          const span = result.spans[0];
          // Verify camelCase keys exist
          expect("traceDbId" in span).toBe(true);
          expect("parentSpanId" in span).toBe(true);
          expect("environmentId" in span).toBe(true);
          expect("projectId" in span).toBe(true);
          expect("organizationId" in span).toBe(true);
          expect("statusCode" in span).toBe(true);
          expect("inputTokens" in span).toBe(true);
          expect("outputTokens" in span).toBe(true);
          expect("costUsd" in span).toBe(true);
          expect("errorType" in span).toBe(true);
          expect("serviceName" in span).toBe(true);
        }
      }).pipe(Effect.provide(makeTestLayers())),
    );
  });
});
