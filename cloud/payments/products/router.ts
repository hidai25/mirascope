/**
 * @fileoverview Router product billing service.
 *
 * Provides Router-specific billing operations including usage metering,
 * fund reservations, and credit management. This service implements the
 * two-phase reservation pattern to prevent overdraft in concurrent scenarios.
 */

import { Effect } from "effect";
import { Stripe } from "@/payments/client";
import { DrizzleORM } from "@/db/client";
import {
  StripeError,
  DatabaseError,
  InsufficientFundsError,
  ReservationStateError,
} from "@/errors";
import Decimal from "decimal.js";
import { eq, and, sql } from "drizzle-orm";
import { creditReservations } from "@/db/schema";

/**
 * Gas fee percentage applied to router usage charges.
 * A value of 0.05 represents a 5% fee.
 */
const GAS_FEE_PERCENTAGE = 0.05;

/**
 * Default router usage meter unit price in cents.
 * This is the expected fallback value if Stripe price retrieval fails.
 * A value of 0.01 represents $0.0001 per unit.
 */
export const ROUTER_USAGE_METER_UNIT_PRICE = 0.01;

/**
 * Router product billing service.
 *
 * Handles all Router-specific billing operations including:
 * - Usage metering and balance tracking
 * - Fund reservations (two-phase pattern for concurrency safety)
 * - Credit charging with gas fees
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const payments = yield* Payments;
 *
 *   // Get usage meter balance
 *   const balance = yield* payments.products.router.getUsageMeterBalance("cus_123");
 *
 *   // Reserve funds before request
 *   const reservationId = yield* payments.products.router.reserveFunds({
 *     customerId: "cus_123",
 *     organizationId: "org_123",
 *     estimatedCost: 0.05,
 *   });
 *
 *   // After request completes:
 *   yield* payments.products.router.settleFunds(reservationId, 0.045);
 * });
 * ```
 */
export class Router {
  /**
   * Gets the router price unit amount in cents.
   *
   * Retrieves the price configuration from Stripe and returns the unit amount
   * (or unit_amount_decimal) in cents. Falls back to ROUTER_USAGE_METER_UNIT_PRICE
   * if price doesn't have a unit amount configured.
   *
   * This is used for meter value calculations to ensure they stay in sync with
   * Stripe's pricing configuration.
   *
   * @returns The unit amount in cents (e.g., 0.01 for $0.0001 per unit)
   * @throws StripeError - If price retrieval fails
   */
  private getRouterPriceUnitAmount(): Effect.Effect<
    number,
    StripeError,
    Stripe
  > {
    return Effect.gen(function* () {
      const stripe = yield* Stripe;

      const price = yield* stripe.prices.retrieve(stripe.config.routerPriceId);

      const unitAmountInCents =
        price.unit_amount_decimal && price.unit_amount_decimal !== "0"
          ? new Decimal(price.unit_amount_decimal)
          : price.unit_amount
            ? new Decimal(price.unit_amount)
            : new Decimal(ROUTER_USAGE_METER_UNIT_PRICE);

      return unitAmountInCents.toNumber();
    });
  }

  /**
   * Gets the accumulated meter usage balance for a Stripe customer.
   *
   * Fetches meter event summaries for the current billing period and returns
   * the total usage in dollars. This represents how much the customer has used
   * in the current billing cycle but not yet been invoiced for.
   *
   * @param customerId - The Stripe customer ID
   * @returns The accumulated meter usage in dollars (e.g., 5.00 for $5 usage)
   * @throws StripeError - If API call fails
   */
  getUsageMeterBalance(
    customerId: string,
  ): Effect.Effect<number, StripeError, Stripe> {
    return Effect.gen(this, function* () {
      const stripe = yield* Stripe;

      // Get active subscription to find current billing period
      const subscriptions = yield* stripe.subscriptions.list({
        customer: customerId,
        status: "active",
        limit: 1,
      });

      // If no active subscription, no meter usage
      if (subscriptions.data.length === 0) {
        return 0;
      }

      const subscription = subscriptions.data[0];
      const currentPeriodStart = subscription.current_period_start;
      const currentPeriodEnd = subscription.current_period_end;

      // Fetch meter event summaries for current billing period
      const summaries = yield* stripe.billing.meters.listEventSummaries(
        stripe.config.routerMeterId,
        {
          customer: customerId,
          start_time: currentPeriodStart,
          end_time: currentPeriodEnd,
        },
      );

      // Sum up aggregated values (meter units, not cents)
      let totalUnits = 0;
      for (const summary of summaries.data) {
        totalUnits += summary.aggregated_value;
      }

      // Get unit price and convert meter units to dollars using Decimal for precision
      const unitAmountInCents = yield* this.getRouterPriceUnitAmount();
      return new Decimal(totalUnits).mul(unitAmountInCents).div(100).toNumber();
    });
  }

  /**
   * Charges the usage meter for a Stripe customer for Router.
   *
   * Records a meter event for the customer's usage, applying a gas fee.
   * The actual amount charged to the meter is `amount * (1 + GAS_FEE_PERCENTAGE)`.
   *
   * The meter value is calculated based on the price's unit_amount (or unit_amount_decimal)
   * to ensure it stays in sync with Stripe's pricing configuration.
   *
   * @param customerId - The Stripe customer ID
   * @param amount - The base usage amount in dollars (e.g., 1.00 for $1)
   * @returns Effect that succeeds when meter is charged
   * @throws StripeError - If meter event creation fails or price retrieval fails
   */
  chargeUsageMeter(
    customerId: string,
    amount: number,
  ): Effect.Effect<void, StripeError, Stripe> {
    return Effect.gen(this, function* () {
      const stripe = yield* Stripe;

      // Apply gas fee using Decimal for precision
      const chargedAmount = new Decimal(amount).mul(
        new Decimal(1).plus(GAS_FEE_PERCENTAGE),
      );

      // Get unit price
      const unitAmountInCents = yield* this.getRouterPriceUnitAmount();

      // Calculate meter value based on unit price using Decimal
      // meter_value = (amount_in_dollars * 100) / unit_amount_in_cents
      const meterValue = chargedAmount
        .mul(100)
        .div(unitAmountInCents)
        .round()
        .toNumber();

      // Create meter event
      yield* stripe.billing.meterEvents.create({
        event_name: "use_credits",
        payload: {
          stripe_customer_id: customerId,
          value: Math.max(meterValue, 1).toString(),
        },
        timestamp: Math.floor(Date.now() / 1000),
      });
    });
  }

  /**
   * Gets the router credit balance from Stripe credit grants.
   *
   * Fetches all credit grants for the customer and filters for those that are
   * applicable to the router price (metered usage-based billing).
   *
   * @param customerId - The Stripe customer ID
   * @returns The total credit grants in dollars (e.g., 10.00 for $10)
   * @throws StripeError - If API call fails
   */
  getCreditBalance(
    customerId: string,
  ): Effect.Effect<number, StripeError, Stripe> {
    return Effect.gen(function* () {
      const stripe = yield* Stripe;

      const credit_grants = yield* stripe.billing.creditGrants.list({
        customer: customerId,
      });

      let totalCredits = 0;

      for (const grant of credit_grants.data) {
        if (!grant.amount.monetary) continue;

        const config = grant.applicability_config;
        if (
          !config.scope ||
          !config.scope.prices?.some(
            (price) => price.id === stripe.config.routerPriceId,
          )
        )
          continue;

        const { value, currency } = grant.amount.monetary;
        if (currency === "usd") {
          totalCredits += value / 100;
        }
      }

      return totalCredits;
    });
  }

  /**
   * Gets the available router balance for a Stripe customer.
   *
   * Calculates: credit grants - meter usage = available balance.
   * This represents how much the customer can spend on router requests.
   *
   * @param customerId - The Stripe customer ID
   * @returns The available balance in dollars (e.g., 5.00 means $5 available to spend)
   * @throws StripeError - If API call fails
   */
  getAvailableBalance(
    customerId: string,
  ): Effect.Effect<number, StripeError, Stripe> {
    return Effect.gen(this, function* () {
      const creditBalance = yield* this.getCreditBalance(customerId);
      const meterUsage = yield* this.getUsageMeterBalance(customerId);
      return creditBalance - meterUsage;
    });
  }

  /**
   * Reserves funds for a router request to prevent overdraft in concurrent scenarios.
   *
   * This method implements the first phase of the two-phase reservation pattern:
   * 1. Check if customer has sufficient available balance (total balance - active reservations)
   * 2. If sufficient, create a reservation record atomically
   * 3. Return reservation ID for later settlement/release
   *
   * The reservation "locks" the estimated cost so other concurrent requests can't use it.
   * This prevents race conditions where multiple requests could overdraft the account.
   *
   * After the request completes, caller MUST either:
   * - Call `settleFunds()` with actual cost (on success)
   * - Call `releaseFunds()` (on error or no usage)
   *
   * @param customerId - Stripe customer ID
   * @param organizationId - Organization UUID
   * @param estimatedCost - Estimated cost in dollars (e.g., 0.05 for $0.05)
   * @param requestId - Optional request ID for debugging
   * @param model - Optional model name for debugging
   * @param provider - Optional provider name for debugging
   * @returns Reservation ID to use for settlement/release
   * @throws DatabaseError - If reservation creation fails
   * @throws InsufficientFundsError - If customer has insufficient available funds
   */
  reserveFunds({
    customerId,
    organizationId,
    estimatedCost,
    requestId,
    model,
    provider,
  }: {
    customerId: string;
    organizationId: string;
    estimatedCost: number;
    requestId?: string;
    model?: string;
    provider?: string;
  }): Effect.Effect<
    string,
    DatabaseError | InsufficientFundsError | StripeError,
    DrizzleORM | Stripe
  > {
    return Effect.gen(this, function* () {
      const db = yield* DrizzleORM;

      // Get available balance
      const availableBalance = yield* this.getAvailableBalance(customerId);

      // Calculate active reservations
      const activeReservationsResult = yield* db
        .select({
          sum: sql<string>`COALESCE(SUM(${creditReservations.estimatedCost}), 0)`,
        })
        .from(creditReservations)
        .where(
          and(
            eq(creditReservations.stripeCustomerId, customerId),
            eq(creditReservations.status, "active"),
          ),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new DatabaseError({
                message: "Failed to calculate active reservations",
                cause: error,
              }),
          ),
        );

      const activeReservationsTotal = parseFloat(
        activeReservationsResult[0]?.sum ?? "0",
      );

      // Check if sufficient funds available
      const netAvailable = availableBalance - activeReservationsTotal;
      if (netAvailable < estimatedCost) {
        return yield* new InsufficientFundsError({
          message: `Insufficient available funds. Required: $${estimatedCost.toFixed(2)}, Available: $${netAvailable.toFixed(2)} (Balance: $${availableBalance.toFixed(2)}, Reserved: $${activeReservationsTotal.toFixed(2)})`,
          required: estimatedCost,
          available: netAvailable,
        });
      }

      const [reservation] = yield* db
        .insert(creditReservations)
        .values({
          stripeCustomerId: customerId,
          organizationId,
          estimatedCost: estimatedCost.toString(),
          status: "active",
          requestId,
          model,
          provider,
        })
        .returning({ id: creditReservations.id })
        .pipe(
          Effect.mapError(
            (error) =>
              new DatabaseError({
                message: "Failed to create credit reservation",
                cause: error,
              }),
          ),
        );

      return reservation.id;
    });
  }

  /**
   * Settles a reservation with the actual cost after request completion.
   *
   * This is the second phase of the two-phase reservation pattern for successful requests.
   * Updates the reservation record with the actual cost and marks it as settled.
   * The actual cost is then charged to the meter.
   *
   * @param reservationId - Reservation ID from reserveFunds()
   * @param actualCost - Actual cost in dollars (e.g., 0.045 for $0.045)
   * @returns Effect that succeeds when settlement is complete
   * @throws DatabaseError - If database operation fails
   * @throws ReservationStateError - If reservation not found or already settled/released
   * @throws StripeError - If meter charging fails
   */
  settleFunds(
    reservationId: string,
    actualCost: number,
  ): Effect.Effect<
    void,
    DatabaseError | StripeError | ReservationStateError,
    Stripe | DrizzleORM
  > {
    return Effect.gen(this, function* () {
      const db = yield* DrizzleORM;

      // Update reservation to settled status
      const result = yield* db
        .update(creditReservations)
        .set({
          actualCost: actualCost.toString(),
          status: "settled",
          settledAt: new Date(),
        })
        .where(
          and(
            eq(creditReservations.id, reservationId),
            eq(creditReservations.status, "active"),
          ),
        )
        .returning({ customerId: creditReservations.stripeCustomerId })
        .pipe(
          Effect.mapError(
            (error) =>
              new DatabaseError({
                message: "Failed to settle credit reservation",
                cause: error,
              }),
          ),
        );

      if (result.length === 0) {
        return yield* new ReservationStateError({
          message: `Reservation not found or already settled/released`,
          reservationId,
        });
      }

      // Charge the meter with actual cost
      yield* this.chargeUsageMeter(result[0].customerId, actualCost);
    });
  }

  /**
   * Releases a reservation without charging when request fails or has no usage.
   *
   * This is the alternative second phase of the two-phase reservation pattern for failed requests.
   * Marks the reservation as released, freeing up the reserved funds for other requests.
   *
   * @param reservationId - Reservation ID from reserveFunds()
   * @returns Effect that succeeds when release is complete
   * @throws DatabaseError - If database operation fails
   * @throws ReservationStateError - If reservation not found or already settled/released
   */
  releaseFunds(
    reservationId: string,
  ): Effect.Effect<void, DatabaseError | ReservationStateError, DrizzleORM> {
    return Effect.gen(function* () {
      const db = yield* DrizzleORM;

      // Update reservation to released status
      const result = yield* db
        .update(creditReservations)
        .set({
          status: "released",
          releasedAt: new Date(),
        })
        .where(
          and(
            eq(creditReservations.id, reservationId),
            eq(creditReservations.status, "active"),
          ),
        )
        .returning({ id: creditReservations.id })
        .pipe(
          Effect.mapError(
            (error) =>
              new DatabaseError({
                message: "Failed to release credit reservation",
                cause: error,
              }),
          ),
        );

      if (result.length === 0) {
        return yield* new ReservationStateError({
          message: `Reservation not found or already settled/released`,
          reservationId,
        });
      }
    });
  }
}
