/**
 * @fileoverview ClickHouse client service for analytics data access.
 *
 * Provides Effect-based ClickHouse client implementations for both
 * Node.js and Cloudflare Workers environments.
 *
 * ## Architecture
 *
 * ```
 * ClickhouseClient.layer (HTTP connection)
 *   └── ClickHouseClient (Effect Service)
 *         └── SqlClient (Effect SQL)
 * ```
 *
 * ## Usage
 *
 * - Node.js (local dev, API handlers): Use `ClickHouseClientNodeLive`
 * - Workers (Queue Consumer, Cron): Use `ClickHouseClientWorkersLive`
 *
 * ## TLS Constraints
 *
 * - Node.js: Full TLS configuration support (custom CA, hostname verify, etc.)
 * - Workers: System CA only (Cloudflare-managed), no custom CA support
 *
 * @example
 * ```ts
 * import { ClickHouseClient, ClickHouseClientNodeLive } from "@/clickhouse/client";
 *
 * const program = Effect.gen(function* () {
 *   const { sql } = yield* ClickHouseClient;
 *   const spans = yield* sql<SpanRow>`SELECT * FROM spans_analytics LIMIT 10`;
 *   return spans;
 * });
 *
 * await Effect.runPromise(
 *   program.pipe(Effect.provide(ClickHouseClientNodeLive))
 * );
 * ```
 */

import { Context, Effect, Layer } from "effect";
import { ClickhouseClient as EffectClickhouseClient } from "@effect/sql-clickhouse";
import { SqlClient } from "@effect/sql";
import { NodeContext } from "@effect/platform-node";
import * as fs from "node:fs";
import { ClickHouseError } from "@/errors";
import { SettingsService, type Settings } from "@/settings";

// =============================================================================
// Service Interface
// =============================================================================

/**
 * ClickHouseClient configuration options.
 */
export interface ClickHouseConfig {
  /** ClickHouse HTTP URL (e.g., http://localhost:8123) */
  url?: string;
  /** ClickHouse username */
  user?: string;
  /** ClickHouse password */
  password?: string;
  /** ClickHouse database name */
  database?: string;
}

/**
 * ClickHouseClient service interface type.
 *
 * Provides both low-level Effect SQL access and convenience methods.
 * The convenience methods (unsafeQuery, insert, command) match
 * ClickHouseWorkersClientService for easy environment switching.
 * Node.js additionally exposes sql and clickhouse for Effect SQL templates.
 */
export interface ClickHouseClientService {
  /** The Effect SQL client for executing queries with sql`` template. */
  readonly sql: SqlClient.SqlClient;
  /** The ClickHouse-specific client for insert operations. */
  readonly clickhouse: EffectClickhouseClient.ClickhouseClient;
  /**
   * Execute a raw SQL query without parameterization.
   * WARNING: This method is unsafe and should only be used for trusted SQL.
   * For parameterized queries, use the `sql` template instead:
   * @example
   * ```ts
   * const { sql } = yield* ClickHouseClient;
   * const rows = yield* sql`SELECT * FROM table WHERE id = ${id}`;
   * ```
   */
  readonly unsafeQuery: <T extends object>(
    sql: string,
  ) => Effect.Effect<readonly T[], ClickHouseError>;
  /** Insert rows into a table in JSONEachRow format. */
  readonly insert: <T extends Record<string, unknown>>(
    table: string,
    rows: T[],
  ) => Effect.Effect<void, ClickHouseError>;
  /** Execute a DDL/DML command (CREATE, ALTER, etc.). */
  readonly command: (sql: string) => Effect.Effect<void, ClickHouseError>;
}

/**
 * ClickHouseClient service.
 *
 * Provides Effect SQL client for ClickHouse operations.
 * Uses the same pattern as PostgreSQL with @effect/sql-pg.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const { sql, clickhouse } = yield* ClickHouseClient;
 *
 *   // Query using Effect SQL template
 *   const rows = yield* sql`SELECT * FROM spans_analytics LIMIT 10`;
 *
 *   // Insert using ClickHouse insertQuery
 *   yield* clickhouse.insertQuery({
 *     table: "spans_analytics",
 *     values: rows,
 *     format: "JSONEachRow",
 *   });
 *
 *   return rows;
 * });
 * ```
 */
export class ClickHouseClient extends Context.Tag("ClickHouseClient")<
  ClickHouseClient,
  ClickHouseClientService
>() {
  /**
   * Default layer using SettingsService for configuration.
   * Requires SettingsService to be provided.
   *
   * Uses @effect/sql-clickhouse over ClickHouse HTTP for Node.js.
   */
  static Default = Layer.effect(
    ClickHouseClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const clickhouse = yield* EffectClickhouseClient.ClickhouseClient;

      const toClickHouseError = (e: unknown): ClickHouseError =>
        e instanceof ClickHouseError
          ? e
          : new ClickHouseError({
              message: `ClickHouse operation failed: ${e instanceof Error ? e.message : String(e)}`,
              cause: e instanceof Error ? e : undefined,
            });

      return {
        sql,
        clickhouse,
        unsafeQuery: <T extends object>(
          query: string,
        ): Effect.Effect<readonly T[], ClickHouseError> =>
          sql
            .unsafe<T>(query)
            .pipe(Effect.catchAll((e) => Effect.fail(toClickHouseError(e)))),
        insert: <T extends Record<string, unknown>>(
          table: string,
          rows: T[],
        ): Effect.Effect<void, ClickHouseError> => {
          if (rows.length === 0) return Effect.void;
          return clickhouse
            .insertQuery({
              table,
              values: rows,
              format: "JSONEachRow",
            })
            .pipe(Effect.catchAll((e) => Effect.fail(toClickHouseError(e))));
        },
        command: (query: string): Effect.Effect<void, ClickHouseError> =>
          sql.unsafe(query).pipe(
            Effect.asVoid,
            Effect.catchAll((e) => Effect.fail(toClickHouseError(e))),
          ),
      };
    }),
  ).pipe(
    Layer.provide(
      Layer.unwrapEffect(
        Effect.gen(function* () {
          const settings = yield* SettingsService;
          return createEffectClickhouseClientLayer(settings);
        }),
      ),
    ),
    Layer.provide(NodeContext.layer),
  );

  /**
   * Creates a layer with direct configuration.
   * Does not require SettingsService.
   *
   * @param config - ClickHouse connection configuration
   */
  static layer = (config: ClickHouseConfig = {}) => {
    const settings: Settings = {
      env: "local",
      CLICKHOUSE_URL: config.url ?? "http://localhost:8123",
      CLICKHOUSE_USER: config.user ?? "default",
      CLICKHOUSE_PASSWORD: config.password,
      CLICKHOUSE_DATABASE: config.database ?? "mirascope_analytics",
    };

    return ClickHouseClient.Default.pipe(
      Layer.provide(Layer.succeed(SettingsService, settings)),
    );
  };
}

// =============================================================================
// Node.js Implementation (@effect/sql-clickhouse over HTTP)
// =============================================================================

/**
 * Validates TLS settings for compatibility with @effect/sql-clickhouse.
 *
 * ## TLS Limitations
 *
 * The @effect/sql-clickhouse package uses @clickhouse/client internally,
 * which only supports:
 * - `ca_cert` - Custom CA certificate (BasicTLSOptions)
 * - `cert` + `key` - Client certificate for mutual TLS (MutualTLSOptions)
 *
 * The following settings are NOT supported:
 * - `CLICKHOUSE_TLS_SKIP_VERIFY` - Cannot skip certificate verification
 * - `CLICKHOUSE_TLS_HOSTNAME_VERIFY` - Cannot disable hostname verification
 * - `CLICKHOUSE_TLS_MIN_VERSION` - Cannot set minimum TLS version
 *
 * @param settings - Application settings including ClickHouse configuration
 * @throws Error if unsupported TLS settings are configured
 */
const validateTLSSettings = (settings: Settings): void => {
  if (settings.CLICKHOUSE_TLS_ENABLED) {
    if (settings.CLICKHOUSE_TLS_SKIP_VERIFY) {
      throw new Error(
        "CLICKHOUSE_TLS_SKIP_VERIFY=true is not supported by @effect/sql-clickhouse. " +
          "The library always verifies certificates when TLS is enabled. " +
          "Use a valid CA certificate via CLICKHOUSE_TLS_CA instead.",
      );
    }

    if (settings.CLICKHOUSE_TLS_HOSTNAME_VERIFY === false) {
      throw new Error(
        "CLICKHOUSE_TLS_HOSTNAME_VERIFY=false is not supported by @effect/sql-clickhouse. " +
          "The library always performs hostname verification. " +
          "Ensure your certificate CN/SAN matches the ClickHouse hostname.",
      );
    }

    if (
      settings.CLICKHOUSE_TLS_MIN_VERSION &&
      settings.CLICKHOUSE_TLS_MIN_VERSION !== "TLSv1.2"
    ) {
      // Log warning but don't fail - TLSv1.2+ is typically enforced by Node.js
      console.warn(
        `CLICKHOUSE_TLS_MIN_VERSION=${settings.CLICKHOUSE_TLS_MIN_VERSION} is not directly ` +
          "configurable in @effect/sql-clickhouse. Node.js defaults apply (typically TLSv1.2+).",
      );
    }
  }
};

/**
 * Creates a @effect/sql-clickhouse layer from Settings.
 *
 * @param settings - Application settings including ClickHouse configuration
 * @returns Layer providing ClickhouseClient and SqlClient
 */
const createEffectClickhouseClientLayer = (settings: Settings) => {
  // Validate TLS settings before creating layer
  validateTLSSettings(settings);

  // TLS CA certificate loading with explicit error handling
  let caCert: Buffer | undefined;
  if (settings.CLICKHOUSE_TLS_ENABLED && settings.CLICKHOUSE_TLS_CA) {
    try {
      caCert = fs.readFileSync(settings.CLICKHOUSE_TLS_CA);
    } catch (error) {
      throw new Error(
        `Failed to read ClickHouse TLS CA certificate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Build TLS options only if explicitly enabled with CA cert
  // Note: @clickhouse/client only supports ca_cert in BasicTLSOptions
  // Other TLS settings (HOSTNAME_VERIFY, MIN_VERSION, SKIP_VERIFY) are
  // validated at settings.ts level for production safety
  const tlsOptions =
    settings.CLICKHOUSE_TLS_ENABLED && caCert ? { ca_cert: caCert } : undefined;

  return EffectClickhouseClient.layer({
    url: settings.CLICKHOUSE_URL,
    username: settings.CLICKHOUSE_USER,
    password: settings.CLICKHOUSE_PASSWORD,
    database: settings.CLICKHOUSE_DATABASE,
    tls: tlsOptions,
    // Backpressure control: limit concurrent connections
    // @clickhouse/client manages connection pooling internally
    max_open_connections: 10,
    // Request timeout for individual queries
    request_timeout: 30000,
  });
};

/**
 * ClickHouseClient implementation for Node.js environment.
 * Alias for ClickHouseClient.Default.
 *
 * Uses `@effect/sql-clickhouse` over the ClickHouse HTTP interface
 * with full Effect integration.
 */
export const ClickHouseClientNodeLive = ClickHouseClient.Default;

// =============================================================================
// Cloudflare Workers Implementation (fetch + HTTP API)
// =============================================================================

/**
 * Internal Workers HTTP client for ClickHouse.
 *
 * Uses fetch API with the ClickHouse HTTP interface.
 * TLS is handled by Cloudflare's system CA (no custom CA support).
 */
const createWorkersClickHouseClient = (settings: Settings) => {
  const baseUrl = settings.CLICKHOUSE_URL;

  // Production validation: require HTTPS
  if (settings.env === "production" && !baseUrl?.startsWith("https://")) {
    throw new Error(
      "CLICKHOUSE_URL must use https:// in production (Workers environment)",
    );
  }

  const database = settings.CLICKHOUSE_DATABASE ?? "default";
  const authHeader = `Basic ${btoa(`${settings.CLICKHOUSE_USER ?? "default"}:${settings.CLICKHOUSE_PASSWORD ?? ""}`)}`;

  return {
    query: async <T>(
      sql: string,
      params?: Record<string, unknown>,
    ): Promise<T[]> => {
      const urlParams = new URLSearchParams({
        database,
        default_format: "JSONEachRow",
      });

      // Add query parameters
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          urlParams.set(`param_${key}`, String(value));
        }
      }

      const response = await fetch(`${baseUrl}/?${urlParams}`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "text/plain",
        },
        body: sql,
      });

      if (!response.ok) {
        throw new Error(
          `ClickHouse query failed: ${response.status} ${await response.text()}`,
        );
      }

      const text = await response.text();
      if (!text.trim()) return [];

      // Parse JSONEachRow format (one JSON object per line)
      return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as T);
    },

    insert: async <T extends Record<string, unknown>>(
      table: string,
      rows: T[],
    ): Promise<void> => {
      if (rows.length === 0) return;

      const urlParams = new URLSearchParams({
        database,
        query: `INSERT INTO ${table} FORMAT JSONEachRow`,
      });

      const body = rows.map((row) => JSON.stringify(row)).join("\n");

      const response = await fetch(`${baseUrl}/?${urlParams}`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "text/plain",
        },
        body,
      });

      if (!response.ok) {
        throw new Error(
          `ClickHouse insert failed: ${response.status} ${await response.text()}`,
        );
      }
    },

    command: async (sql: string): Promise<void> => {
      const urlParams = new URLSearchParams({ database });

      const response = await fetch(`${baseUrl}/?${urlParams}`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "text/plain",
        },
        body: sql,
      });

      if (!response.ok) {
        throw new Error(
          `ClickHouse command failed: ${response.status} ${await response.text()}`,
        );
      }
    },
  };
};

/**
 * Workers-specific ClickHouse client service interface.
 *
 * Uses fetch API instead of @effect/sql-clickhouse for Workers compatibility.
 * Interface matches ClickHouseClientService for easy environment switching.
 */
export interface ClickHouseWorkersClientService {
  /**
   * Execute a raw SQL query without parameterization.
   * WARNING: This method is unsafe and should only be used for trusted SQL.
   */
  readonly unsafeQuery: <T extends object>(
    sql: string,
  ) => Effect.Effect<readonly T[], ClickHouseError>;
  /** Insert rows into a table in JSONEachRow format. */
  readonly insert: <T extends Record<string, unknown>>(
    table: string,
    rows: T[],
  ) => Effect.Effect<void, ClickHouseError>;
  /** Execute a DDL/DML command (CREATE, ALTER, etc.). */
  readonly command: (sql: string) => Effect.Effect<void, ClickHouseError>;
}

/**
 * ClickHouseWorkersClient service tag for Workers environment.
 */
export class ClickHouseWorkersClient extends Context.Tag(
  "ClickHouseWorkersClient",
)<ClickHouseWorkersClient, ClickHouseWorkersClientService>() {}

/**
 * ClickHouseClient implementation for Cloudflare Workers environment.
 *
 * Uses fetch API with ClickHouse HTTP interface.
 *
 * TLS Constraints:
 * - System CA only (Cloudflare-managed root certificates)
 * - Custom CA certificates are NOT supported
 * - ClickHouse must have a public CA signed certificate in production
 */
export const ClickHouseClientWorkersLive = Layer.effect(
  ClickHouseWorkersClient,
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const client = createWorkersClickHouseClient(settings);

    return {
      unsafeQuery: <T extends object>(
        sql: string,
      ): Effect.Effect<readonly T[], ClickHouseError> =>
        Effect.tryPromise({
          try: async () => client.query<T>(sql) as Promise<readonly T[]>,
          catch: (e) =>
            new ClickHouseError({
              message: `ClickHouse operation failed: ${e instanceof Error ? e.message : String(e)}`,
              cause: e,
            }),
        }),

      insert: <T extends Record<string, unknown>>(table: string, rows: T[]) =>
        Effect.tryPromise({
          try: () => client.insert(table, rows),
          catch: (e) =>
            new ClickHouseError({
              message: `ClickHouse operation failed: ${e instanceof Error ? e.message : String(e)}`,
              cause: e,
            }),
        }),

      command: (sql: string) =>
        Effect.tryPromise({
          try: () => client.command(sql),
          catch: (e) =>
            new ClickHouseError({
              message: `ClickHouse operation failed: ${e instanceof Error ? e.message : String(e)}`,
              cause: e,
            }),
        }),
    };
  }),
);

// =============================================================================
// Node.js to Workers Adapter
// =============================================================================

/**
 * Adapter layer that provides ClickHouseWorkersClient from ClickHouseClient.
 * Use this in Node.js environment when you need ClickHouseWorkersClient interface.
 *
 * @example
 * ```ts
 * const layer = Layer.mergeAll(
 *   ClickHouseClientNodeLive,
 *   ClickHouseWorkersClientFromNode,
 * );
 * ```
 */
export const ClickHouseWorkersClientFromNode = Layer.effect(
  ClickHouseWorkersClient,
  Effect.gen(function* () {
    const client = yield* ClickHouseClient;
    const service: ClickHouseWorkersClientService = {
      unsafeQuery: <T extends object>(sql: string) =>
        client.unsafeQuery<T>(sql),
      insert: <T extends Record<string, unknown>>(table: string, rows: T[]) =>
        client.insert<T>(table, rows),
      command: (sql: string) => client.command(sql),
    };
    return service;
  }),
);

// =============================================================================
// Default Export (Node.js)
// =============================================================================

/**
 * Default ClickHouseClient layer for local development and testing.
 * Uses Node.js implementation with `@effect/sql-clickhouse`.
 */
export const ClickHouseClientLive = ClickHouseClientNodeLive;
