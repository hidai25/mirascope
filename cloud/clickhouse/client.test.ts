import { describe, it, expect } from "@/tests/clickhouse";
import { Effect, Layer } from "effect";
import {
  ClickHouseClient,
  ClickHouseWorkersClient,
  ClickHouseClientWorkersLive,
} from "@/clickhouse/client";
import { SettingsService, type Settings } from "@/settings";
import { ClickHouseError } from "@/errors";
import { it as vitestIt, vi } from "vitest";

const createTestSettings = (overrides: Partial<Settings> = {}): Settings => ({
  env: "local",
  CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? "default",
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? "clickhouse",
  CLICKHOUSE_DATABASE: process.env.CLICKHOUSE_DATABASE ?? "mirascope_analytics",
  CLICKHOUSE_TLS_ENABLED: false,
  CLICKHOUSE_TLS_HOSTNAME_VERIFY: true,
  ...overrides,
});

const makeTestSettingsLayer = (settings: Settings) =>
  Layer.succeed(SettingsService, settings);

describe("ClickHouseClient", () => {
  describe("ClickHouseClientNodeLive", () => {
    it.effect("creates a Layer successfully", () =>
      Effect.gen(function* () {
        const client = yield* ClickHouseClient;
        expect(client).toBeDefined();
        expect(client.sql).toBeDefined();
        expect(client.unsafeQuery).toBeDefined();
        expect(client.insert).toBeDefined();
        expect(client.command).toBeDefined();
      }),
    );

    it.effect("executes unsafeQuery successfully", () =>
      Effect.gen(function* () {
        const client = yield* ClickHouseClient;

        const result = yield* client.unsafeQuery<{ n: number }>(
          "SELECT 1 as n",
        );

        expect(result).toHaveLength(1);
        expect(result[0]?.n).toBe(1);
      }),
    );

    it.effect("executes query with sql template and parameters", () =>
      Effect.gen(function* () {
        const { sql } = yield* ClickHouseClient;
        const value = 42;

        // Use Effect SQL template for parameterized queries
        const result = yield* sql<{ n: number }>`SELECT ${value} as n`;

        expect(result).toHaveLength(1);
        expect(result[0]?.n).toBe(42);
      }),
    );

    it.effect("handles unsafeQuery errors with ClickHouseError", () =>
      Effect.gen(function* () {
        const client = yield* ClickHouseClient;

        const error = yield* client
          .unsafeQuery("SELECT * FROM non_existent_table_xyz_123")
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(ClickHouseError);
        expect(error.message).toContain("ClickHouse operation failed");
      }),
    );

    it.effect("executes command successfully", () =>
      Effect.gen(function* () {
        const client = yield* ClickHouseClient;

        // Use a simple command that doesn't require a real table
        yield* client.command("SELECT 1");
      }),
    );

    it.effect("skips insert for empty rows", () =>
      Effect.gen(function* () {
        const client = yield* ClickHouseClient;

        // Should not error even though table doesn't exist (no-op for empty array)
        yield* client.insert("any_table", []);
      }),
    );
  });

  describe("ClickHouseClientWorkersLive", () => {
    const createWorkersTestLayer = (settings: Settings) =>
      ClickHouseClientWorkersLive.pipe(
        Layer.provide(makeTestSettingsLayer(settings)),
      );

    vitestIt("executes unsafeQuery via HTTP API", async () => {
      const settings = createTestSettings();
      const program = Effect.gen(function* () {
        const client = yield* ClickHouseWorkersClient;
        return yield* client.unsafeQuery<{ n: number }>("SELECT 1 as n");
      });

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(createWorkersTestLayer(settings))),
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.n).toBe(1);
    });

    vitestIt("handles empty response", async () => {
      const settings = createTestSettings();
      const program = Effect.gen(function* () {
        const client = yield* ClickHouseWorkersClient;
        return yield* client.unsafeQuery<{ n: number }>(
          "SELECT 1 as n WHERE 1 = 0",
        );
      });

      const result = await Effect.runPromise(
        program.pipe(Effect.provide(createWorkersTestLayer(settings))),
      );

      expect(result).toEqual([]);
    });

    vitestIt("handles HTTP errors from ClickHouse", async () => {
      const settings = createTestSettings();
      const program = Effect.gen(function* () {
        const client = yield* ClickHouseWorkersClient;
        return yield* client
          .unsafeQuery("SELECT * FROM non_existent_table_xyz_123")
          .pipe(Effect.flip);
      });

      const error = await Effect.runPromise(
        program.pipe(Effect.provide(createWorkersTestLayer(settings))),
      );

      expect(error).toBeInstanceOf(ClickHouseError);
      expect(error.message).toContain("ClickHouse operation failed");
    });

    vitestIt("validates https in production", async () => {
      const settings = createTestSettings({
        env: "production",
        CLICKHOUSE_URL: "http://clickhouse.example.com",
      });

      const program = Effect.gen(function* () {
        yield* ClickHouseWorkersClient;
      });

      await expect(
        Effect.runPromise(
          program.pipe(Effect.provide(createWorkersTestLayer(settings))),
        ),
      ).rejects.toThrow("must use https://");
    });

    vitestIt("skips insert for empty rows (Workers)", async () => {
      const settings = createTestSettings();
      const program = Effect.gen(function* () {
        const client = yield* ClickHouseWorkersClient;
        yield* client.insert("any_table", []);
      });

      await Effect.runPromise(
        program.pipe(Effect.provide(createWorkersTestLayer(settings))),
      );
    });

    vitestIt("executes command via HTTP API", async () => {
      const settings = createTestSettings();
      const program = Effect.gen(function* () {
        const client = yield* ClickHouseWorkersClient;
        yield* client.command("SELECT 1");
      });

      await Effect.runPromise(
        program.pipe(Effect.provide(createWorkersTestLayer(settings))),
      );
    });
  });

  describe("TLS configuration validation", () => {
    vitestIt("throws error when TLS_SKIP_VERIFY is true", async () => {
      const settings = createTestSettings({
        CLICKHOUSE_TLS_ENABLED: true,
        CLICKHOUSE_TLS_SKIP_VERIFY: true,
      });

      const program = Effect.gen(function* () {
        yield* ClickHouseClient;
      });

      await expect(
        Effect.runPromise(
          program.pipe(
            Effect.provide(ClickHouseClient.Default),
            Effect.provide(makeTestSettingsLayer(settings)),
          ),
        ),
      ).rejects.toThrow("CLICKHOUSE_TLS_SKIP_VERIFY=true is not supported");
    });

    vitestIt("throws error when TLS_HOSTNAME_VERIFY is false", async () => {
      const settings = createTestSettings({
        CLICKHOUSE_TLS_ENABLED: true,
        CLICKHOUSE_TLS_HOSTNAME_VERIFY: false,
      });

      const program = Effect.gen(function* () {
        yield* ClickHouseClient;
      });

      await expect(
        Effect.runPromise(
          program.pipe(
            Effect.provide(ClickHouseClient.Default),
            Effect.provide(makeTestSettingsLayer(settings)),
          ),
        ),
      ).rejects.toThrow(
        "CLICKHOUSE_TLS_HOSTNAME_VERIFY=false is not supported",
      );
    });

    vitestIt("logs warning when TLS_MIN_VERSION is non-default", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const settings = createTestSettings({
        CLICKHOUSE_TLS_ENABLED: true,
        CLICKHOUSE_TLS_CA: "/nonexistent/ca.pem",
        CLICKHOUSE_TLS_MIN_VERSION: "TLSv1.3",
      });

      const program = Effect.gen(function* () {
        yield* ClickHouseClient;
      });

      // Will fail because CA file doesn't exist, but warning should be logged first
      await expect(
        Effect.runPromise(
          program.pipe(
            Effect.provide(ClickHouseClient.Default),
            Effect.provide(makeTestSettingsLayer(settings)),
          ),
        ),
      ).rejects.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("CLICKHOUSE_TLS_MIN_VERSION=TLSv1.3"),
      );

      consoleSpy.mockRestore();
    });

    vitestIt("does not throw when TLS settings are valid", async () => {
      const settings = createTestSettings({
        CLICKHOUSE_TLS_ENABLED: true,
        CLICKHOUSE_TLS_SKIP_VERIFY: false,
        CLICKHOUSE_TLS_HOSTNAME_VERIFY: true,
        CLICKHOUSE_TLS_MIN_VERSION: "TLSv1.2",
        // Without CA, it won't throw for validation but will fail on connection
      });

      const program = Effect.gen(function* () {
        const client = yield* ClickHouseClient;
        return client;
      });

      // Should create client without validation errors (may fail on actual connection)
      const client = await Effect.runPromise(
        program.pipe(
          Effect.provide(ClickHouseClient.Default),
          Effect.provide(makeTestSettingsLayer(settings)),
        ),
      );

      expect(client).toBeDefined();
    });
  });

  describe("ClickHouseClient.layer", () => {
    vitestIt("creates a layer with provided configuration", () => {
      const layer = ClickHouseClient.layer({
        url: "http://localhost:8123",
        user: "default",
        password: "test",
        database: "test_db",
      });

      expect(layer).toBeDefined();
      expect(Layer.isLayer(layer)).toBe(true);
    });

    vitestIt("creates a layer with default configuration", () => {
      const layer = ClickHouseClient.layer();

      expect(layer).toBeDefined();
      expect(Layer.isLayer(layer)).toBe(true);
    });

    vitestIt("layer works with unsafeQuery", async () => {
      const program = Effect.gen(function* () {
        const client = yield* ClickHouseClient;
        return yield* client.unsafeQuery<{ n: number }>("SELECT 1 as n");
      });

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(
            ClickHouseClient.layer({
              url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
              user: process.env.CLICKHOUSE_USER ?? "default",
              password: process.env.CLICKHOUSE_PASSWORD ?? "clickhouse",
              database:
                process.env.CLICKHOUSE_DATABASE ?? "mirascope_analytics",
            }),
          ),
        ),
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.n).toBe(1);
    });
  });
});
