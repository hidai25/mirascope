/**
 * @fileoverview Local development polling worker for ClickHouse sync.
 *
 * Alternative to Cloudflare Queue Consumer for local development.
 * Uses polling instead of queue-based processing.
 *
 * ## Key Design
 *
 * - Uses the same processOutboxMessages() as Queue Consumer
 * - Node.js environment (uses @clickhouse/client via ClickHouseClientNodeLive)
 * - Polling-based with configurable interval
 * - Includes stale lock reclamation
 *
 * ## Usage
 *
 * ```ts
 * import { runLocalSyncWorker } from "./clickhouseSyncLocal";
 *
 * await runLocalSyncWorker({
 *   pollIntervalMs: 1000,
 *   batchSize: 100,
 *   lockTimeoutMs: 30000,
 *   maxRetries: 5,
 * });
 * ```
 */

import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Schedule, Duration } from "effect";
import { DrizzleORM } from "@/db/client";
import {
  ClickHouseClientNodeLive,
  ClickHouseWorkersClientFromNode,
  ClickHouseWorkersClient,
} from "@/clickhouse/client";
import { spansOutbox } from "@/db/schema";
import { and, eq, lt, lte, or, isNull } from "drizzle-orm";
import { SettingsService, getSettings } from "@/settings";
import { DatabaseError } from "@/errors";
import {
  processOutboxMessages,
  type OutboxMessage,
} from "@/workers/outboxProcessor";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for the local sync worker.
 */
export interface SyncWorkerConfig {
  /** Polling interval in milliseconds (default: 1000) */
  pollIntervalMs: number;
  /** Maximum batch size per poll (default: 100) */
  batchSize: number;
  /** Lock timeout in milliseconds (default: 30000) */
  lockTimeoutMs: number;
  /** Maximum retry count (default: 5) */
  maxRetries: number;
}

/**
 * Default configuration values.
 */
export const defaultConfig: SyncWorkerConfig = {
  pollIntervalMs: 1000,
  batchSize: 100,
  lockTimeoutMs: 30000,
  maxRetries: 5,
};

// =============================================================================
// Worker ID Generation
// =============================================================================

/**
 * Generate a unique worker ID for lock identification.
 * Format: hostname-pid-uuid8
 */
const generateWorkerId = (): string => {
  const hostname = os.hostname();
  const pid = process.pid;
  const uuid = crypto.randomUUID().slice(0, 8);
  return `${hostname}-${pid}-${uuid}`;
};

// =============================================================================
// Stale Lock Reclamation
// =============================================================================

/**
 * Reclaim stale locks from crashed workers.
 *
 * Rows that have been in 'processing' state longer than lockTimeoutMs
 * are reset to 'pending' for reprocessing.
 */
const reclaimStaleLocks = (config: SyncWorkerConfig) =>
  Effect.gen(function* () {
    const client = yield* DrizzleORM;
    const staleTime = new Date(Date.now() - config.lockTimeoutMs);

    yield* client
      .update(spansOutbox)
      .set({
        status: "pending",
        lockedAt: null,
        lockedBy: null,
      })
      .where(
        and(
          eq(spansOutbox.status, "processing"),
          lt(spansOutbox.lockedAt, staleTime),
        ),
      )
      .pipe(
        Effect.mapError(
          (e) =>
            new DatabaseError({
              message: "Failed to reclaim stale locks",
              cause: e,
            }),
        ),
      );
  });

// =============================================================================
// Batch Fetching
// =============================================================================

/**
 * Fetch pending outbox rows ready for processing.
 */
const fetchPendingBatch = (config: SyncWorkerConfig) =>
  Effect.gen(function* () {
    const client = yield* DrizzleORM;
    const now = new Date();
    const staleTime = new Date(Date.now() - config.lockTimeoutMs);

    const rows = yield* client
      .select({
        spanId: spansOutbox.spanId,
        operation: spansOutbox.operation,
      })
      .from(spansOutbox)
      .where(
        and(
          eq(spansOutbox.status, "pending"),
          lte(spansOutbox.processAfter, now),
          lt(spansOutbox.retryCount, config.maxRetries),
          or(isNull(spansOutbox.lockedAt), lt(spansOutbox.lockedAt, staleTime)),
        ),
      )
      .orderBy(spansOutbox.createdAt)
      .limit(config.batchSize)
      .pipe(
        Effect.mapError(
          (e) =>
            new DatabaseError({
              message: "Failed to fetch pending batch",
              cause: e,
            }),
        ),
      );

    return rows;
  });

// =============================================================================
// Main Worker Loop
// =============================================================================

/**
 * Run a single poll iteration.
 *
 * 1. Reclaim stale locks
 * 2. Fetch pending batch
 * 3. Process batch using shared processOutboxMessages
 */
const pollIteration = (config: SyncWorkerConfig, workerId: string) =>
  Effect.gen(function* () {
    // 1. Reclaim stale locks
    yield* reclaimStaleLocks(config);

    // 2. Fetch pending batch
    const batch = yield* fetchPendingBatch(config);

    if (batch.length === 0) {
      return;
    }

    console.log(`[${workerId}] Processing ${batch.length} outbox rows`);

    // 3. Convert to OutboxMessage format and process
    const messages: OutboxMessage[] = batch.map((row) => ({
      spanId: row.spanId,
      operation: row.operation as "INSERT" | "UPDATE" | "DELETE",
      messageKey: `${row.spanId}:${row.operation}`,
    }));

    // Local worker: ack/retry are no-ops since we're polling
    yield* processOutboxMessages(
      messages,
      () => {
        /* no-op: local polling doesn't need ack */
      },
      () => {
        /* no-op: retry is handled by next poll */
      },
      workerId,
    );
  });

/**
 * Run the local sync worker with the given configuration.
 *
 * This function runs indefinitely, polling for pending outbox rows
 * and processing them in batches.
 *
 * @param config - Worker configuration
 * @returns Effect that runs the worker loop
 */
export const runLocalSyncWorker = (
  config: Partial<SyncWorkerConfig> = {},
): Effect.Effect<
  number,
  DatabaseError,
  DrizzleORM | ClickHouseWorkersClient
> => {
  const fullConfig = { ...defaultConfig, ...config };
  const workerId = generateWorkerId();

  console.log(
    `[${workerId}] Starting local sync worker with config:`,
    fullConfig,
  );

  return Effect.repeat(
    pollIteration(fullConfig, workerId).pipe(
      Effect.catchAll((error) => {
        console.error(`[${workerId}] Poll iteration failed:`, error);
        return Effect.void;
      }),
    ),
    Schedule.spaced(Duration.millis(fullConfig.pollIntervalMs)),
  );
};

// =============================================================================
// Standalone Entry Point
// =============================================================================

/**
 * Main entry point for running as a standalone process.
 *
 * Usage: npx tsx workers/clickhouseSyncLocal.ts
 */
const main = async () => {
  const settings = getSettings();

  if (!settings.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const drizzleLayer = DrizzleORM.layer({
    connectionString: settings.DATABASE_URL,
  });

  const settingsLayer = Layer.succeed(SettingsService, settings);

  const clickhouseClientLayer = ClickHouseClientNodeLive.pipe(
    Layer.provide(settingsLayer),
  );
  const clickhouseWorkersLayer = ClickHouseWorkersClientFromNode.pipe(
    Layer.provide(clickhouseClientLayer),
  );
  const runtimeLayer = Layer.mergeAll(
    clickhouseClientLayer,
    clickhouseWorkersLayer,
    drizzleLayer,
  );

  console.log("Starting ClickHouse sync worker for local development...");

  await Effect.runPromise(
    runLocalSyncWorker().pipe(
      Effect.provide(runtimeLayer),
      Effect.catchAllCause((cause) => {
        console.error("Worker crashed:", cause);
        return Effect.void;
      }),
    ),
  );
};

// Run if executed directly (ESM check)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
