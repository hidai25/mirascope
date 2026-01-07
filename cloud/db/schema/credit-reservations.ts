import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  pgEnum,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Reservation status enum for tracking fund reservation lifecycle.
 *
 * - active: Reservation is active and funds are locked
 * - settled: Request completed successfully, meter charged with actual cost
 * - released: Request failed or had no usage, funds released without charge
 * - expired: Reservation expired due to timeout (handled by future CRON job)
 */
export const reservationStatusEnum = pgEnum("reservation_status", [
  "active",
  "settled",
  "released",
  "expired",
]);

/**
 * Credit reservations table for preventing overdraft in concurrent router requests.
 *
 * ## Problem
 * Without reservations, concurrent requests could race to check balance, both see
 * sufficient funds, and both proceed - causing overdraft. Example:
 * - Balance: $10
 * - Request A checks balance → $10 available → proceeds
 * - Request B checks balance → $10 available → proceeds (race!)
 * - Both requests charge $8 → Total used: $16 → Overdraft by $6
 *
 * ## Solution: Two-Phase Reservation Pattern
 * When a router request is received:
 * 1. **Reserve**: Atomically lock estimated funds before making the provider request
 *    - Calculate: available = total_balance - SUM(active_reservations)
 *    - If available >= estimated_cost: create active reservation
 *    - If available < estimated_cost: reject request immediately
 * 2. **Process**: Make the actual request to the AI provider
 * 3. **Settle or Release**:
 *    - Success: Settle with actual cost (update reservation, charge meter)
 *    - Error/No usage: Release reservation (free up the funds)
 *
 * ## Lifecycle
 * - **active**: Reservation created, funds locked (initial state)
 * - **settled**: Request succeeded, actual cost charged to meter
 * - **released**: Request failed or had no usage, funds freed
 * - **expired**: Reservation timed out (handled by future CRON job)
 *
 * ## Expiration Safety Net
 * The expires_at field (default 5 minutes) provides a safety net for orphaned
 * reservations from server crashes or bugs. Under normal operation (99.9%+ of cases),
 * reservations are explicitly settled or released. The CRON job is a defensive measure.
 *
 * TODO: Implement CRON job to expire orphaned reservations:
 * - Run every 5 minutes
 * - Find reservations WHERE status='active' AND expires_at < NOW()
 * - Mark them as 'expired' and release the funds
 * - Log these occurrences for monitoring (should be rare - indicates bugs or crashes)
 * - Use the expires_at index for efficient querying
 */
export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    organizationId: uuid("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    // Cost tracking
    estimatedCost: numeric("estimated_cost", {
      precision: 10,
      scale: 6,
    }).notNull(),
    actualCost: numeric("actual_cost", { precision: 10, scale: 6 }),

    // Status tracking
    status: reservationStatusEnum("status").default("active").notNull(),

    // Request metadata for debugging
    requestId: text("request_id"),
    model: text("model"),
    provider: text("provider"),

    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    settledAt: timestamp("settled_at"),
    releasedAt: timestamp("released_at"),
    expiresAt: timestamp("expires_at")
      .notNull()
      .$defaultFn(() => new Date(Date.now() + 5 * 60 * 1000)), // 5 minutes from now
  },
  (table) => ({
    // Index for fast lookup of active reservations by customer
    customerStatusIndex: index("credit_reservations_customer_status_index").on(
      table.stripeCustomerId,
      table.status,
    ),
    // Index for future CRON job to expire old active reservations
    expiresAtIndex: index("credit_reservations_expires_at_index")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'active'`),
  }),
);

export const creditReservationsRelations = relations(
  creditReservations,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [creditReservations.organizationId],
      references: [organizations.id],
    }),
  }),
);

// Internal types
export type CreditReservation = typeof creditReservations.$inferSelect;
export type NewCreditReservation = typeof creditReservations.$inferInsert;
export type ReservationStatus =
  (typeof reservationStatusEnum.enumValues)[number];
