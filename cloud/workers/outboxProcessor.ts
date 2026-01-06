/**
 * @fileoverview Outbox processor for ClickHouse sync.
 *
 * Shared processing logic for both Queue Consumer and local polling worker.
 * Handles span extraction from PostgreSQL, transformation to ClickHouse format,
 * and batch insertion with retry logic.
 */

import { Effect } from "effect";
import { and, eq, lte } from "drizzle-orm";
import { DrizzleORM } from "@/db/client";
import { ClickHouseClient } from "@/clickhouse/client";
import { spansOutbox, spans, traces } from "@/db/schema";
import type { Span } from "@/db/schema/spans";
import type { Trace } from "@/db/schema/traces";
import { DatabaseError } from "@/errors";

// =============================================================================
// Types
// =============================================================================

export type OutboxMessage = {
  spanId: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  messageKey: string;
};

export type SpanAnalyticsRow = {
  id: string;
  trace_db_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  environment_id: string;
  project_id: string;
  organization_id: string;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  name: string;
  name_lower: string;
  kind: number | null;
  status_code: number | null;
  status_message: string | null;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  function_id: string | null;
  function_name: string | null;
  function_version: string | null;
  error_type: string | null;
  error_message: string | null;
  attributes: string;
  events: string | null;
  links: string | null;
  service_name: string | null;
  service_version: string | null;
  resource_attributes: string | null;
  created_at: string;
  synced_at: string;
  _version: number;
};

// =============================================================================
// Constants
// =============================================================================

const MAX_RETRIES = 5;
const MAX_ERROR_MESSAGE_LENGTH = 1000;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate exponential backoff delay for retries.
 */
const calculateBackoff = (retryCount: number): Date => {
  const baseDelayMs = 1000; // 1 second
  const maxDelayMs = 300000; // 5 minutes
  const delayMs = Math.min(baseDelayMs * Math.pow(2, retryCount), maxDelayMs);
  return new Date(Date.now() + delayMs);
};

/**
 * Sanitize error message to prevent excessive storage.
 */
const sanitizeErrorMessage = (error: string): string => {
  return error.slice(0, MAX_ERROR_MESSAGE_LENGTH);
};

/**
 * Extract attribute value from JSONB attributes.
 */
const getAttributeValue = (
  attributes: Record<string, unknown> | null,
  key: string,
): unknown => {
  if (!attributes) return null;
  return attributes[key] ?? null;
};

/**
 * Transform a span + trace into ClickHouse analytics format.
 */
export const transformSpanForClickHouse = (
  span: Span,
  trace: Trace,
): SpanAnalyticsRow => {
  const attributes = span.attributes as Record<string, unknown> | null;
  const status = span.status as { code?: number; message?: string } | null;

  // Calculate duration in milliseconds
  let durationMs: number | null = null;
  if (span.startTimeUnixNano && span.endTimeUnixNano) {
    const startNs = BigInt(span.startTimeUnixNano);
    const endNs = BigInt(span.endTimeUnixNano);
    durationMs = Number((endNs - startNs) / BigInt(1000000));
  }

  // Convert Unix nano to ISO string
  const startTime = span.startTimeUnixNano
    ? new Date(
        Number(BigInt(span.startTimeUnixNano) / BigInt(1000000)),
      ).toISOString()
    : new Date().toISOString();
  const endTime = span.endTimeUnixNano
    ? new Date(
        Number(BigInt(span.endTimeUnixNano) / BigInt(1000000)),
      ).toISOString()
    : null;

  return {
    id: span.id,
    trace_db_id: span.traceId,
    trace_id: span.otelTraceId,
    span_id: span.otelSpanId,
    parent_span_id: span.parentSpanId,
    environment_id: span.environmentId,
    project_id: span.projectId,
    organization_id: span.organizationId,
    start_time: startTime,
    end_time: endTime,
    duration_ms: durationMs,
    name: span.name,
    name_lower: span.name.toLowerCase(),
    kind: span.kind,
    status_code: status?.code ?? null,
    status_message: status?.message ?? null,
    // LLM-specific attributes
    model: getAttributeValue(attributes, "gen_ai.request.model") as
      | string
      | null,
    provider: getAttributeValue(attributes, "gen_ai.system") as string | null,
    input_tokens: getAttributeValue(attributes, "gen_ai.usage.input_tokens") as
      | number
      | null,
    output_tokens: getAttributeValue(
      attributes,
      "gen_ai.usage.output_tokens",
    ) as number | null,
    total_tokens: null, // Calculated if needed
    cost_usd: getAttributeValue(attributes, "gen_ai.usage.cost") as
      | number
      | null,
    function_id: getAttributeValue(attributes, "mirascope.function_id") as
      | string
      | null,
    function_name: getAttributeValue(attributes, "mirascope.function_name") as
      | string
      | null,
    function_version: getAttributeValue(
      attributes,
      "mirascope.function_version",
    ) as string | null,
    error_type: getAttributeValue(attributes, "exception.type") as
      | string
      | null,
    error_message: getAttributeValue(attributes, "exception.message") as
      | string
      | null,
    // Full JSON attributes
    attributes: JSON.stringify(attributes ?? {}),
    events: span.events ? JSON.stringify(span.events) : null,
    links: span.links ? JSON.stringify(span.links) : null,
    // Trace-level info
    service_name: trace.serviceName,
    service_version: trace.serviceVersion,
    resource_attributes: trace.resourceAttributes
      ? JSON.stringify(trace.resourceAttributes)
      : null,
    // Timestamps
    created_at: span.createdAt?.toISOString() ?? new Date().toISOString(),
    synced_at: new Date().toISOString(),
    _version: Date.now(),
  };
};

// =============================================================================
// Main Processing Function
// =============================================================================

/**
 * Process a batch of outbox messages.
 *
 * Shared between Queue Consumer and local polling worker.
 * Handles locking, transformation, ClickHouse insertion, and status updates.
 *
 * @param messages - Array of outbox messages to process
 * @param onAck - Callback when message is successfully processed or should not be retried
 * @param onRetry - Callback when message should be retried
 */
export const processOutboxMessages = (
  messages: OutboxMessage[],
  onAck: (messageKey: string) => void,
  onRetry: (messageKey: string) => void,
) =>
  Effect.gen(function* () {
    const client = yield* DrizzleORM;
    const clickhouse = yield* ClickHouseClient;

    const clickhouseRows: SpanAnalyticsRow[] = [];
    const processedMessages: OutboxMessage[] = [];

    for (const outboxMessage of messages) {
      // 0. Check if outbox row exists
      const [existingRow] = yield* client
        .select()
        .from(spansOutbox)
        .where(
          and(
            eq(spansOutbox.spanId, outboxMessage.spanId),
            eq(spansOutbox.operation, outboxMessage.operation),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (e) =>
              new DatabaseError({
                message: "Failed to query outbox",
                cause: e,
              }),
          ),
        );

      if (!existingRow) {
        // Orphan message - ack and skip
        onAck(outboxMessage.messageKey);
        continue;
      }

      // 1. Try to lock the outbox row
      const now = new Date();
      const [outboxRow] = yield* client
        .update(spansOutbox)
        .set({ status: "processing", lockedAt: now })
        .where(
          and(
            eq(spansOutbox.spanId, outboxMessage.spanId),
            eq(spansOutbox.operation, outboxMessage.operation),
            eq(spansOutbox.status, "pending"),
            lte(spansOutbox.processAfter, now),
          ),
        )
        .returning()
        .pipe(
          Effect.mapError(
            (e) =>
              new DatabaseError({
                message: "Failed to lock outbox row",
                cause: e,
              }),
          ),
        );

      if (!outboxRow) {
        // Failed to acquire lock - already processing, completed, or not ready
        onAck(outboxMessage.messageKey);
        continue;
      }

      // 2. Get span with trace info from PostgreSQL
      const [spanWithTrace] = yield* client
        .select({
          span: spans,
          trace: traces,
        })
        .from(spans)
        .innerJoin(traces, eq(spans.traceId, traces.id))
        .where(eq(spans.id, outboxMessage.spanId))
        .limit(1)
        .pipe(
          Effect.mapError(
            (e) =>
              new DatabaseError({
                message: "Failed to query span with trace",
                cause: e,
              }),
          ),
        );

      if (!spanWithTrace) {
        // Span not found - mark as completed
        yield* client
          .update(spansOutbox)
          .set({ status: "completed", processedAt: now })
          .where(
            and(
              eq(spansOutbox.spanId, outboxMessage.spanId),
              eq(spansOutbox.operation, outboxMessage.operation),
            ),
          )
          .pipe(
            Effect.mapError(
              (e) =>
                new DatabaseError({
                  message: "Failed to update outbox status",
                  cause: e,
                }),
            ),
          );
        onAck(outboxMessage.messageKey);
        continue;
      }

      // 3. Transform to ClickHouse format
      clickhouseRows.push(
        transformSpanForClickHouse(spanWithTrace.span, spanWithTrace.trace),
      );
      processedMessages.push(outboxMessage);
    }

    if (clickhouseRows.length === 0) return;

    // 4. Bulk insert to ClickHouse
    yield* clickhouse.insert("spans_analytics", clickhouseRows).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.gen(function* () {
            // 5. On success, mark as completed
            for (const processedMessage of processedMessages) {
              yield* client
                .update(spansOutbox)
                .set({ status: "completed", processedAt: new Date() })
                .where(
                  and(
                    eq(spansOutbox.spanId, processedMessage.spanId),
                    eq(spansOutbox.operation, processedMessage.operation),
                  ),
                )
                .pipe(
                  Effect.mapError(
                    (e) =>
                      new DatabaseError({
                        message: "Failed to update outbox status",
                        cause: e,
                      }),
                  ),
                );
              onAck(processedMessage.messageKey);
            }
          }),
        onFailure: (error) =>
          Effect.gen(function* () {
            // ClickHouse insert failed - retry with exponential backoff or fail
            for (const processedMessage of processedMessages) {
              const [current] = yield* client
                .select({ retryCount: spansOutbox.retryCount })
                .from(spansOutbox)
                .where(
                  and(
                    eq(spansOutbox.spanId, processedMessage.spanId),
                    eq(spansOutbox.operation, processedMessage.operation),
                  ),
                )
                .pipe(
                  Effect.mapError(
                    (e) =>
                      new DatabaseError({
                        message: "Failed to query retry count",
                        cause: e,
                      }),
                  ),
                );

              const newRetryCount = (current?.retryCount ?? 0) + 1;

              if (newRetryCount >= MAX_RETRIES) {
                // Max retries exceeded - mark as failed
                yield* client
                  .update(spansOutbox)
                  .set({
                    status: "failed",
                    retryCount: newRetryCount,
                    lastError: sanitizeErrorMessage(String(error)),
                    lockedAt: null,
                  })
                  .where(
                    and(
                      eq(spansOutbox.spanId, processedMessage.spanId),
                      eq(spansOutbox.operation, processedMessage.operation),
                    ),
                  )
                  .pipe(
                    Effect.mapError(
                      (e) =>
                        new DatabaseError({
                          message: "Failed to update outbox status",
                          cause: e,
                        }),
                    ),
                  );
                onAck(processedMessage.messageKey); // Failed is acked (no more retries)
              } else {
                // Schedule retry with exponential backoff
                yield* client
                  .update(spansOutbox)
                  .set({
                    status: "pending",
                    retryCount: newRetryCount,
                    processAfter: calculateBackoff(newRetryCount),
                    lastError: sanitizeErrorMessage(String(error)),
                    lockedAt: null,
                  })
                  .where(
                    and(
                      eq(spansOutbox.spanId, processedMessage.spanId),
                      eq(spansOutbox.operation, processedMessage.operation),
                    ),
                  )
                  .pipe(
                    Effect.mapError(
                      (e) =>
                        new DatabaseError({
                          message: "Failed to update outbox status",
                          cause: e,
                        }),
                    ),
                  );
                onRetry(processedMessage.messageKey);
              }
            }
          }),
      }),
    );
  });
