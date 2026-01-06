import { Effect, Layer } from "effect";
import { describe, expect } from "@effect/vitest";
import { createCustomIt } from "@/tests/shared";
import { ClickHouseClient } from "@/clickhouse/client";
import { SettingsService, type Settings } from "@/settings";

// Re-export describe and expect for convenience
export { describe, expect };

// Environment variables for ClickHouse connection
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER ?? "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "clickhouse";
const CLICKHOUSE_DATABASE =
  process.env.CLICKHOUSE_DATABASE ?? "mirascope_analytics";

/**
 * Test settings for ClickHouse.
 */
const testSettings: Settings = {
  env: "local",
  CLICKHOUSE_URL,
  CLICKHOUSE_USER,
  CLICKHOUSE_PASSWORD,
  CLICKHOUSE_DATABASE,
  CLICKHOUSE_TLS_ENABLED: false,
};

/**
 * Settings layer for tests.
 */
const TestSettingsLayer = Layer.succeed(SettingsService, testSettings);

/**
 * ClickHouseClient layer for tests.
 * Note: Layer may fail with SqlError | ConfigError during initialization.
 */
export const TestClickHouseClient = ClickHouseClient.Default.pipe(
  Layer.provide(TestSettingsLayer),
);

/**
 * Services that are automatically provided to all `it.effect` tests.
 */
export type TestServices = ClickHouseClient;

/**
 * Wraps a test function to automatically provide TestClickHouseClient.
 */
const wrapEffectTest =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (original: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (name: any, fn: any, timeout?: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
      return original(
        name,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion
        () => (fn() as any).pipe(Effect.provide(TestClickHouseClient)),
        timeout,
      );
    };

/**
 * Type-safe `it` with `it.effect` that automatically provides TestClickHouseClient.
 *
 * Use this instead of importing directly from @effect/vitest.
 */
export const it = createCustomIt<TestServices>(wrapEffectTest);
