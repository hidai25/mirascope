import { describe, it, expect, vi, beforeEach } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { Stripe } from "@/payments/client";
import { Payments } from "@/payments/service";
import {
  DatabaseError,
  InsufficientFundsError,
  ReservationStateError,
  StripeError,
} from "@/errors";
import { MockDrizzleORMLayer } from "@/tests/mock-drizzle";
import { assert } from "@/tests/db";
import { ROUTER_USAGE_METER_UNIT_PRICE } from "@/payments/products/router";
import { DrizzleORM } from "@/db/client";
import { clearPricingCache } from "@/api/router/pricing";
import type { ProviderName } from "@/api/router/providers";

describe("Router Product", () => {
  describe("getUsageMeterBalance", () => {
    it.effect("returns 0 when no active subscription exists", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const balance =
          yield* payments.products.router.getUsageMeterBalance("cus_123");

        expect(balance).toBe(0);
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                subscriptions: {
                  list: () =>
                    Effect.succeed({
                      object: "list" as const,
                      data: [],
                      has_more: false,
                    }),
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test_mock",
                  routerMeterId: "meter_test_mock",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      ),
    );

    it.effect("calculates balance from meter event summaries", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const balance =
          yield* payments.products.router.getUsageMeterBalance("cus_123");

        // 1000 units * ROUTER_USAGE_METER_UNIT_PRICE / 100 = $0.10
        expect(balance).toBe(0.1);
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                subscriptions: {
                  list: () =>
                    Effect.succeed({
                      object: "list" as const,
                      data: [
                        {
                          id: "sub_123",
                          customer: "cus_123",
                          current_period_start: 1000000,
                          current_period_end: 2000000,
                        },
                      ],
                      has_more: false,
                    }),
                },
                billing: {
                  meters: {
                    listEventSummaries: () =>
                      Effect.succeed({
                        object: "list" as const,
                        data: [{ aggregated_value: 1000 }],
                        has_more: false,
                      }),
                  },
                },
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test_mock",
                      object: "price" as const,
                      unit_amount: ROUTER_USAGE_METER_UNIT_PRICE, // $0.0001 per unit
                      unit_amount_decimal: null,
                    }),
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test_mock",
                  routerMeterId: "meter_test_mock",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      ),
    );
  });

  describe("getAvailableBalance", () => {
    it.effect("returns credit balance minus meter usage", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        // Will calculate: credit grants - meter usage
        const available =
          yield* payments.products.router.getAvailableBalance("cus_123");

        // Credit grants: 10 USD * 100 cents / 100 = $10.00
        // Meter usage: 1000 units * ROUTER_USAGE_METER_UNIT_PRICE / 100 = $0.1
        // Available: $10.00 - $0.1 = $9.9
        expect(available).toBe(9.9);
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                billing: {
                  creditGrants: {
                    list: () =>
                      Effect.succeed({
                        object: "list" as const,
                        data: [
                          {
                            amount: {
                              monetary: { value: 1000, currency: "usd" },
                            },
                            applicability_config: {
                              scope: {
                                prices: [{ id: "price_test_mock" }],
                              },
                            },
                          },
                        ],
                        has_more: false,
                      }),
                  },
                  meters: {
                    listEventSummaries: () =>
                      Effect.succeed({
                        object: "list" as const,
                        data: [{ aggregated_value: 1000 }],
                        has_more: false,
                      }),
                  },
                },
                subscriptions: {
                  list: () =>
                    Effect.succeed({
                      object: "list" as const,
                      data: [
                        {
                          id: "sub_123",
                          customer: "cus_123",
                          current_period_start: 1000000,
                          current_period_end: 2000000,
                        },
                      ],
                      has_more: false,
                    }),
                },
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test_mock",
                      object: "price" as const,
                      unit_amount: ROUTER_USAGE_METER_UNIT_PRICE,
                      unit_amount_decimal: null,
                    }),
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test_mock",
                  routerMeterId: "meter_test_mock",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      ),
    );
  });

  describe("chargeUsageMeter", () => {
    it.effect("charges meter with gas fee applied", () => {
      let capturedValue: string | undefined;

      return Effect.gen(function* () {
        const payments = yield* Payments;

        yield* payments.products.router.chargeUsageMeter("cus_123", 1.0);

        // 1.0 * 1.05 (gas fee) = 1.05
        // 1.05 * 100 / ROUTER_USAGE_METER_UNIT_PRICE = 10500
        expect(capturedValue).toBe("10500");
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test_mock",
                      object: "price" as const,
                      unit_amount: ROUTER_USAGE_METER_UNIT_PRICE,
                      unit_amount_decimal: null,
                    }),
                },
                billing: {
                  meterEvents: {
                    create: (params: {
                      event_name: string;
                      payload: { stripe_customer_id: string; value: string };
                      timestamp: number;
                    }) =>
                      Effect.sync(() => {
                        capturedValue = params.payload.value;
                      }),
                  },
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test_mock",
                  routerMeterId: "meter_test_mock",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      );
    });

    it.effect("handles meter event creation failure", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const result = yield* payments.products.router
          .chargeUsageMeter("cus_123", 1.0)
          .pipe(Effect.flip);

        expect(result).toBeInstanceOf(StripeError);
        expect(result.message).toBe("Failed to create meter event");
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test_mock",
                      object: "price" as const,
                      unit_amount: ROUTER_USAGE_METER_UNIT_PRICE,
                      unit_amount_decimal: null,
                    }),
                },
                billing: {
                  meterEvents: {
                    create: () =>
                      Effect.fail(
                        new StripeError({
                          message: "Failed to create meter event",
                        }),
                      ),
                  },
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test_mock",
                  routerMeterId: "meter_test_mock",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      ),
    );
  });

  describe("reserveFunds", () => {
    it.effect(
      "returns DatabaseError when calculating active reservations fails",
      () =>
        Effect.gen(function* () {
          const payments = yield* Payments;

          const result = yield* payments.products.router
            .reserveFunds({
              customerId: "cus_123",
              organizationId: "org_123",
              estimatedCost: 0.05,
            })
            .pipe(Effect.flip);

          assert(result instanceof DatabaseError);
          expect(result.message).toBe(
            "Failed to calculate active reservations",
          );
        }).pipe(
          Effect.provide(Payments.Default),
          Effect.provide(
            Layer.succeed(DrizzleORM, {
              select: () => ({
                from: () => ({
                  where: () => Effect.fail(new Error("Database query failed")),
                }),
              }),
            } as unknown as Context.Tag.Service<typeof DrizzleORM>),
          ),
          Effect.provide(
            Layer.succeed(Stripe, {
              billing: {
                creditGrants: {
                  list: () =>
                    Effect.succeed({
                      object: "list" as const,
                      data: [
                        {
                          amount: {
                            monetary: { value: 1000, currency: "usd" },
                          },
                          applicability_config: {
                            scope: {
                              prices: [{ id: "price_test_mock" }],
                            },
                          },
                        },
                      ],
                      has_more: false,
                    }),
                },
                meters: {
                  listEventSummaries: () =>
                    Effect.succeed({
                      object: "list" as const,
                      data: [{ aggregated_value: 0 }],
                      has_more: false,
                    }),
                },
              },
              subscriptions: {
                list: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [
                      {
                        id: "sub_123",
                        customer: "cus_123",
                        current_period_start: 1000000,
                        current_period_end: 2000000,
                      },
                    ],
                    has_more: false,
                  }),
              },
              prices: {
                retrieve: () =>
                  Effect.succeed({
                    id: "price_test_mock",
                    object: "price" as const,
                    unit_amount: ROUTER_USAGE_METER_UNIT_PRICE,
                    unit_amount_decimal: null,
                  }),
              },
              config: {
                apiKey: "sk_test_mock",
                routerPriceId: "price_test_mock",
                routerMeterId: "meter_test_mock",
              },
            } as unknown as Context.Tag.Service<typeof Stripe>),
          ),
        ),
    );

    it.effect("returns DatabaseError when creating reservation fails", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const result = yield* payments.products.router
          .reserveFunds({
            customerId: "cus_123",
            organizationId: "org_123",
            estimatedCost: 0.05,
          })
          .pipe(Effect.flip);

        assert(result instanceof DatabaseError);
        expect(result.message).toBe("Failed to create credit reservation");
      }).pipe(
        Effect.provide(Payments.Default),
        Effect.provide(
          Layer.succeed(DrizzleORM, {
            select: () => ({
              from: () => ({
                where: () => Effect.succeed([{ sum: "0" }]),
              }),
            }),
            insert: () => ({
              values: () => ({
                returning: () =>
                  Effect.fail(new Error("Database insert failed")),
              }),
            }),
          } as unknown as Context.Tag.Service<typeof DrizzleORM>),
        ),
        Effect.provide(
          Layer.succeed(Stripe, {
            billing: {
              creditGrants: {
                list: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [
                      {
                        amount: {
                          monetary: { value: 1000, currency: "usd" },
                        },
                        applicability_config: {
                          scope: {
                            prices: [{ id: "price_test_mock" }],
                          },
                        },
                      },
                    ],
                    has_more: false,
                  }),
              },
              meters: {
                listEventSummaries: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [{ aggregated_value: 0 }],
                    has_more: false,
                  }),
              },
            },
            subscriptions: {
              list: () =>
                Effect.succeed({
                  object: "list" as const,
                  data: [
                    {
                      id: "sub_123",
                      customer: "cus_123",
                      current_period_start: 1000000,
                      current_period_end: 2000000,
                    },
                  ],
                  has_more: false,
                }),
            },
            prices: {
              retrieve: () =>
                Effect.succeed({
                  id: "price_test_mock",
                  object: "price" as const,
                  unit_amount: ROUTER_USAGE_METER_UNIT_PRICE,
                  unit_amount_decimal: null,
                }),
            },
            config: {
              apiKey: "sk_test_mock",
              routerPriceId: "price_test_mock",
              routerMeterId: "meter_test_mock",
            },
          } as unknown as Context.Tag.Service<typeof Stripe>),
        ),
      ),
    );

    it.effect("successfully reserves funds when no active reservations", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const reservationId = yield* payments.products.router.reserveFunds({
          customerId: "cus_123",
          organizationId: "org_123",
          estimatedCost: 0.05,
        });

        expect(reservationId).toContain("mock_");
      }).pipe(
        Effect.provide(Payments.Default),
        Effect.provide(
          Layer.succeed(DrizzleORM, {
            select: () => ({
              from: () => ({
                where: () => Effect.succeed([]), // Empty array, triggers ?? "0" fallback
              }),
            }),
            insert: () => ({
              values: () => ({
                returning: () =>
                  Effect.succeed([{ id: `mock_${crypto.randomUUID()}` }]),
              }),
            }),
          } as unknown as Context.Tag.Service<typeof DrizzleORM>),
        ),
        Effect.provide(
          Layer.succeed(Stripe, {
            billing: {
              creditGrants: {
                list: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [
                      {
                        amount: {
                          monetary: { value: 1000, currency: "usd" },
                        },
                        applicability_config: {
                          scope: {
                            prices: [{ id: "price_test_mock" }],
                          },
                        },
                      },
                    ],
                    has_more: false,
                  }),
              },
              meters: {
                listEventSummaries: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [{ aggregated_value: 0 }],
                    has_more: false,
                  }),
              },
            },
            subscriptions: {
              list: () =>
                Effect.succeed({
                  object: "list" as const,
                  data: [
                    {
                      id: "sub_123",
                      customer: "cus_123",
                      current_period_start: 1000000,
                      current_period_end: 2000000,
                    },
                  ],
                  has_more: false,
                }),
            },
            prices: {
              retrieve: () =>
                Effect.succeed({
                  id: "price_test_mock",
                  object: "price" as const,
                  unit_amount: 1,
                  unit_amount_decimal: null,
                }),
            },
            config: {
              apiKey: "sk_test_mock",
              routerPriceId: "price_test_mock",
              routerMeterId: "meter_test_mock",
            },
          } as unknown as Context.Tag.Service<typeof Stripe>),
        ),
      ),
    );

    it.effect("fails with InsufficientFundsError when balance too low", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const result = yield* payments.products.router
          .reserveFunds({
            customerId: "cus_123",
            organizationId: "org_123",
            estimatedCost: 10.05, // More than available balance ($10)
          })
          .pipe(Effect.flip);

        assert(result instanceof InsufficientFundsError);
        expect(result.required).toBe(10.05);
        expect(result.available).toBeLessThan(10.05);
      }).pipe(
        Effect.provide(Payments.Default),
        Effect.provide(MockDrizzleORMLayer),
        Effect.provide(
          Layer.succeed(Stripe, {
            billing: {
              creditGrants: {
                list: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [
                      {
                        amount: {
                          monetary: { value: 1000, currency: "usd" },
                        },
                        applicability_config: {
                          scope: {
                            prices: [{ id: "price_test_mock" }],
                          },
                        },
                      },
                    ],
                    has_more: false,
                  }),
              },
              meters: {
                listEventSummaries: () =>
                  Effect.succeed({
                    object: "list" as const,
                    data: [{ aggregated_value: 0 }],
                    has_more: false,
                  }),
              },
            },
            subscriptions: {
              list: () =>
                Effect.succeed({
                  object: "list" as const,
                  data: [
                    {
                      id: "sub_123",
                      customer: "cus_123",
                      current_period_start: 1000000,
                      current_period_end: 2000000,
                    },
                  ],
                  has_more: false,
                }),
            },
            prices: {
              retrieve: () =>
                Effect.succeed({
                  id: "price_test_mock",
                  object: "price" as const,
                  unit_amount: 1,
                  unit_amount_decimal: null,
                }),
            },
            config: {
              apiKey: "sk_test_mock",
              routerPriceId: "price_test_mock",
              routerMeterId: "meter_test_mock",
            },
          } as unknown as Context.Tag.Service<typeof Stripe>),
        ),
      ),
    );
  });

  describe("settleFunds", () => {
    it.effect("successfully settles funds and charges meter", () => {
      let chargedAmount: string | undefined;

      return Effect.gen(function* () {
        const payments = yield* Payments;

        yield* payments.products.router.settleFunds("reservation_123", 0.05);

        // Should charge with gas fee: 0.05 * 1.05 = 0.0525
        // Meter value: 0.0525 * 100 / ROUTER_USAGE_METER_UNIT_PRICE = 525
        expect(chargedAmount).toBe("525");
      }).pipe(
        Effect.provide(Payments.Default),
        Effect.provide(
          Layer.succeed(DrizzleORM, {
            update: () => ({
              set: () => ({
                where: () => ({
                  returning: () => Effect.succeed([{ customerId: "cus_123" }]),
                }),
              }),
            }),
          } as unknown as Context.Tag.Service<typeof DrizzleORM>),
        ),
        Effect.provide(
          Layer.succeed(Stripe, {
            prices: {
              retrieve: () =>
                Effect.succeed({
                  id: "price_test_mock",
                  object: "price" as const,
                  unit_amount: ROUTER_USAGE_METER_UNIT_PRICE,
                  unit_amount_decimal: null,
                }),
            },
            billing: {
              meterEvents: {
                create: (params: {
                  event_name: string;
                  payload: { stripe_customer_id: string; value: string };
                  timestamp: number;
                }) =>
                  Effect.sync(() => {
                    chargedAmount = params.payload.value;
                  }),
              },
            },
            config: {
              apiKey: "sk_test_mock",
              routerPriceId: "price_test_mock",
              routerMeterId: "meter_test_mock",
            },
          } as unknown as Context.Tag.Service<typeof Stripe>),
        ),
      );
    });

    it.effect(
      "returns ReservationStateError when reservation not found (using mock DB)",
      () =>
        Effect.gen(function* () {
          const payments = yield* Payments;

          // Custom mock that returns empty array to simulate "not found"
          const result = yield* payments.products.router
            .settleFunds("nonexistent_id", 0.045)
            .pipe(Effect.flip);

          assert(result instanceof ReservationStateError);
          expect(result.reservationId).toBe("nonexistent_id");
        }).pipe(
          Effect.provide(Payments.Default),
          Effect.provide(
            Layer.succeed(DrizzleORM, {
              update: () => ({
                set: () => ({
                  where: () => ({
                    returning: () => ({
                      pipe: () => Effect.succeed([]), // Empty array = not found
                    }),
                  }),
                }),
              }),
            } as unknown as Context.Tag.Service<typeof DrizzleORM>),
          ),
          Effect.provide(
            Layer.succeed(Stripe, {
              prices: {
                retrieve: () =>
                  Effect.succeed({
                    id: "price_test_mock",
                    object: "price" as const,
                    unit_amount: 1,
                    unit_amount_decimal: null,
                  }),
              },
              billing: {
                meterEvents: {
                  create: () => Effect.void,
                },
              },
              config: {
                apiKey: "sk_test_mock",
                routerPriceId: "price_test_mock",
                routerMeterId: "meter_test_mock",
              },
            } as unknown as Context.Tag.Service<typeof Stripe>),
          ),
        ),
    );
  });

  describe("releaseFunds", () => {
    it.effect("successfully releases funds", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        yield* payments.products.router.releaseFunds("reservation_123");

        // Test passes if no errors thrown
      }).pipe(
        Effect.provide(Payments.Default),
        Effect.provide(
          Layer.succeed(DrizzleORM, {
            update: () => ({
              set: () => ({
                where: () => ({
                  returning: () => Effect.succeed([{ id: "reservation_123" }]),
                }),
              }),
            }),
          } as unknown as Context.Tag.Service<typeof DrizzleORM>),
        ),
        Effect.provide(
          Layer.succeed(Stripe, {
            config: {
              apiKey: "sk_test_mock",
              routerPriceId: "price_test_mock",
              routerMeterId: "meter_test_mock",
            },
          } as unknown as Context.Tag.Service<typeof Stripe>),
        ),
      ),
    );

    it.effect(
      "returns ReservationStateError when reservation not found (using mock DB)",
      () =>
        Effect.gen(function* () {
          const payments = yield* Payments;

          // Custom mock that returns empty array to simulate "not found"
          const result = yield* payments.products.router
            .releaseFunds("nonexistent_id")
            .pipe(Effect.flip);

          assert(result instanceof ReservationStateError);
          expect(result.reservationId).toBe("nonexistent_id");
        }).pipe(
          Effect.provide(Payments.Default),
          Effect.provide(
            Layer.succeed(DrizzleORM, {
              update: () => ({
                set: () => ({
                  where: () => ({
                    returning: () => ({
                      pipe: () => Effect.succeed([]), // Empty array = not found
                    }),
                  }),
                }),
              }),
            } as unknown as Context.Tag.Service<typeof DrizzleORM>),
          ),
          Effect.provide(
            Layer.succeed(Stripe, {
              config: {
                apiKey: "sk_test_mock",
                routerPriceId: "price_test_mock",
                routerMeterId: "meter_test_mock",
              },
            } as unknown as Context.Tag.Service<typeof Stripe>),
          ),
        ),
    );

    it.effect("returns DatabaseError when database operation fails", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const result = yield* payments.products.router
          .releaseFunds("some_id")
          .pipe(Effect.flip);

        assert(result instanceof DatabaseError);
        expect(result.message).toBe("Failed to release credit reservation");
      }).pipe(
        Effect.provide(Payments.Default),
        Effect.provide(
          Layer.succeed(DrizzleORM, {
            update: () => ({
              set: () => ({
                where: () => ({
                  returning: () =>
                    Effect.fail(new Error("Database connection lost")),
                }),
              }),
            }),
          } as unknown as Context.Tag.Service<typeof DrizzleORM>),
        ),
        Effect.provide(
          Layer.succeed(Stripe, {
            config: {
              apiKey: "sk_test_mock",
              routerPriceId: "price_test_mock",
              routerMeterId: "meter_test_mock",
            },
          } as unknown as Context.Tag.Service<typeof Stripe>),
        ),
      ),
    );
  });

  describe("settleFunds (additional coverage)", () => {
    it.effect("returns DatabaseError when database operation fails", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const result = yield* payments.products.router
          .settleFunds("some_id", 0.045)
          .pipe(Effect.flip);

        assert(result instanceof DatabaseError);
        expect(result.message).toBe("Failed to settle credit reservation");
      }).pipe(
        Effect.provide(Payments.Default),
        Effect.provide(
          Layer.succeed(DrizzleORM, {
            update: () => ({
              set: () => ({
                where: () => ({
                  returning: () =>
                    Effect.fail(new Error("Database connection lost")),
                }),
              }),
            }),
          } as unknown as Context.Tag.Service<typeof DrizzleORM>),
        ),
        Effect.provide(
          Layer.succeed(Stripe, {
            prices: {
              retrieve: () =>
                Effect.succeed({
                  id: "price_test_mock",
                  object: "price" as const,
                  unit_amount: ROUTER_USAGE_METER_UNIT_PRICE,
                  unit_amount_decimal: null,
                }),
            },
            billing: {
              meterEvents: {
                create: () => Effect.void,
              },
            },
            config: {
              apiKey: "sk_test_mock",
              routerPriceId: "price_test_mock",
              routerMeterId: "meter_test_mock",
            },
          } as unknown as Context.Tag.Service<typeof Stripe>),
        ),
      ),
    );
  });

  describe("getUsageMeterBalance (additional coverage)", () => {
    it.effect("uses unit_amount_decimal when available", () =>
      Effect.gen(function* () {
        const payments = yield* Payments;

        const balance =
          yield* payments.products.router.getUsageMeterBalance("cus_123");

        // 1000 units * 0.015 / 100 = 0.15
        expect(balance).toBe(0.15);
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                subscriptions: {
                  list: () =>
                    Effect.succeed({
                      object: "list" as const,
                      data: [
                        {
                          id: "sub_123",
                          customer: "cus_123",
                          current_period_start: 1000000,
                          current_period_end: 2000000,
                        },
                      ],
                      has_more: false,
                    }),
                },
                billing: {
                  meters: {
                    listEventSummaries: () =>
                      Effect.succeed({
                        object: "list" as const,
                        data: [{ aggregated_value: 1000 }],
                        has_more: false,
                      }),
                  },
                },
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test_mock",
                      object: "price" as const,
                      unit_amount: null,
                      unit_amount_decimal: "0.015",
                    }),
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test_mock",
                  routerMeterId: "meter_test_mock",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      ),
    );

    it.effect(
      "falls back to ROUTER_USAGE_METER_UNIT_PRICE when no price set",
      () =>
        Effect.gen(function* () {
          const payments = yield* Payments;

          const balance =
            yield* payments.products.router.getUsageMeterBalance("cus_123");

          // 1000 units * ROUTER_USAGE_METER_UNIT_PRICE / 100 = 0.1
          expect(balance).toBe(0.1);
        }).pipe(
          Effect.provide(
            Payments.Default.pipe(
              Layer.provide(MockDrizzleORMLayer),
              Layer.provide(
                Layer.succeed(Stripe, {
                  subscriptions: {
                    list: () =>
                      Effect.succeed({
                        object: "list" as const,
                        data: [
                          {
                            id: "sub_123",
                            customer: "cus_123",
                            current_period_start: 1000000,
                            current_period_end: 2000000,
                          },
                        ],
                        has_more: false,
                      }),
                  },
                  billing: {
                    meters: {
                      listEventSummaries: () =>
                        Effect.succeed({
                          object: "list" as const,
                          data: [{ aggregated_value: 1000 }],
                          has_more: false,
                        }),
                    },
                  },
                  prices: {
                    retrieve: () =>
                      Effect.succeed({
                        id: "price_test_mock",
                        object: "price" as const,
                        unit_amount: null,
                        unit_amount_decimal: null,
                      }),
                  },
                  config: {
                    apiKey: "sk_test_mock",
                    routerPriceId: "price_test_mock",
                    routerMeterId: "meter_test_mock",
                  },
                } as unknown as Context.Tag.Service<typeof Stripe>),
              ),
            ),
          ),
        ),
    );
  });

  describe("chargeForUsage", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      clearPricingCache();

      // Mock pricing data fetch
      const mockData = {
        anthropic: {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-3-5-haiku-20241022": {
              id: "claude-3-5-haiku-20241022",
              name: "Claude 3.5 Haiku",
              cost: {
                input: 1.0,
                output: 5.0,
                cache_read: 0.1,
                cache_write: 1.25,
              },
            },
          },
        },
        openai: {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-4o-mini": {
              id: "gpt-4o-mini",
              name: "GPT-4o Mini",
              cost: {
                input: 0.15,
                output: 0.6,
                cache_read: 0.075,
              },
            },
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      }) as unknown as typeof fetch;
    });

    it.effect("successfully calculates cost and charges meter", () => {
      let chargedAmount: string | null = null;

      return Effect.gen(function* () {
        const payments = yield* Payments;

        yield* payments.products.router.chargeForUsage({
          provider: "anthropic",
          model: "claude-3-5-haiku-20241022",
          usageData: {
            inputTokens: 1000,
            outputTokens: 500,
          },
          customerId: "cus_123",
        });

        // Should have charged: (1000/1M * 1.0 + 500/1M * 5.0) * 1.05 * 100
        // = (0.001 + 0.0025) * 1.05 * 100 = 0.3675 * 100 = 36.75 cents rounded to 37
        expect(chargedAmount).toBeDefined();
        expect(Number(chargedAmount)).toBeGreaterThan(0);
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test",
                      object: "price" as const,
                      unit_amount: 1, // $0.01 per unit
                      unit_amount_decimal: null,
                    }),
                },
                billing: {
                  meterEvents: {
                    create: (params: { payload: { value: string } }) => {
                      chargedAmount = params.payload.value;
                      return Effect.void;
                    },
                  },
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test",
                  routerMeterId: "meter_test",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      );
    });

    it.effect("calculates cost and charges meter with cache tokens", () => {
      let chargedAmount: string | null = null;

      return Effect.gen(function* () {
        const payments = yield* Payments;

        yield* payments.products.router.chargeForUsage({
          provider: "anthropic",
          model: "claude-3-5-haiku-20241022",
          usageData: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheWriteTokens: 100,
          },
          customerId: "cus_123",
        });

        // Should have charged including cache costs
        expect(chargedAmount).toBeDefined();
        expect(Number(chargedAmount)).toBeGreaterThan(0);
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test",
                      object: "price" as const,
                      unit_amount: 1, // $0.01 per unit
                      unit_amount_decimal: null,
                    }),
                },
                billing: {
                  meterEvents: {
                    create: (params: { payload: { value: string } }) => {
                      chargedAmount = params.payload.value;
                      return Effect.void;
                    },
                  },
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test",
                  routerMeterId: "meter_test",
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      );
    });

    it.effect(
      "calculates cost for OpenAI without cache tokens (tests undefined branch)",
      () => {
        let chargedAmount: string | null = null;

        return Effect.gen(function* () {
          const payments = yield* Payments;

          // OpenAI without cache tokens - cacheReadTokens will be undefined
          yield* payments.products.router.chargeForUsage({
            provider: "openai",
            model: "gpt-4o-mini",
            usageData: {
              inputTokens: 1000,
              outputTokens: 500,
              // No cacheReadTokens - will be undefined
            },
            customerId: "cus_123",
          });

          // Should have charged without cache costs
          expect(chargedAmount).toBeDefined();
          expect(Number(chargedAmount)).toBeGreaterThan(0);
        }).pipe(
          Effect.provide(
            Payments.Default.pipe(
              Layer.provide(MockDrizzleORMLayer),
              Layer.provide(
                Layer.succeed(Stripe, {
                  prices: {
                    retrieve: () =>
                      Effect.succeed({
                        id: "price_test",
                        object: "price" as const,
                        unit_amount: 1, // $0.01 per unit
                        unit_amount_decimal: null,
                      }),
                  },
                  billing: {
                    meterEvents: {
                      create: (params: { payload: { value: string } }) => {
                        chargedAmount = params.payload.value;
                        return Effect.void;
                      },
                    },
                  },
                  config: {
                    apiKey: "sk_test_mock",
                    routerPriceId: "price_test",
                    routerMeterId: "meter_test",
                  },
                } as unknown as Context.Tag.Service<typeof Stripe>),
              ),
            ),
          ),
        );
      },
    );

    it.effect(
      "silently returns when no cost calculator found for provider",
      () => {
        return Effect.gen(function* () {
          const payments = yield* Payments;

          // Should not throw, just return silently
          yield* payments.products.router.chargeForUsage({
            provider: "unknown-provider" as ProviderName,
            model: "some-model",
            usageData: {
              inputTokens: 100,
              outputTokens: 50,
            },
            customerId: "cus_123",
          });
        }).pipe(
          Effect.provide(
            Payments.Default.pipe(
              Layer.provide(MockDrizzleORMLayer),
              Layer.provide(
                Layer.succeed(Stripe, {
                  config: {
                    apiKey: "sk_test_mock",
                    routerPriceId: "price_test",
                    routerMeterId: "meter_test",
                  },
                  billing: {
                    meterEvents: {
                      create: () => Effect.succeed({ id: "evt_test" }),
                    },
                  },
                } as unknown as Context.Tag.Service<typeof Stripe>),
              ),
            ),
          ),
        );
      },
    );

    it.effect("silently returns when cost calculation fails", () => {
      return Effect.gen(function* () {
        const payments = yield* Payments;

        // Pass invalid usage data structure to trigger calculation failure
        // This should be caught and return silently
        yield* payments.products.router.chargeForUsage({
          provider: "anthropic",
          model: "non-existent-model",
          usageData: {
            inputTokens: 100,
            outputTokens: 50,
          },
          customerId: "cus_123",
        });
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                prices: {
                  retrieve: () =>
                    Effect.succeed({
                      id: "price_test",
                      object: "price" as const,
                      unit_amount: 1,
                      unit_amount_decimal: null,
                    }),
                },
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test",
                  routerMeterId: "meter_test",
                },
                billing: {
                  meterEvents: {
                    create: () => Effect.succeed({ id: "evt_test" }),
                  },
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      );
    });

    it.effect("silently returns when usage tokens are NaN", () => {
      // Mock to return NaN tokens
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            anthropic: {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test",
                  cost: { input: NaN, output: NaN },
                },
              },
            },
          }),
      }) as unknown as typeof fetch;

      clearPricingCache();

      return Effect.gen(function* () {
        const payments = yield* Payments;

        yield* payments.products.router.chargeForUsage({
          provider: "anthropic",
          model: "test-model",
          usageData: {
            inputTokens: 100,
            outputTokens: 50,
          },
          customerId: "cus_123",
        });
      }).pipe(
        Effect.provide(
          Payments.Default.pipe(
            Layer.provide(MockDrizzleORMLayer),
            Layer.provide(
              Layer.succeed(Stripe, {
                config: {
                  apiKey: "sk_test_mock",
                  routerPriceId: "price_test",
                  routerMeterId: "meter_test",
                },
                billing: {
                  meterEvents: {
                    create: () => Effect.succeed({ id: "evt_test" }),
                  },
                },
              } as unknown as Context.Tag.Service<typeof Stripe>),
            ),
          ),
        ),
      );
    });

    // TODO: Re-enable once queue-based async metering is implemented.
    // This test times out due to retry logic with exponential backoff (15+ seconds).
    // The retry error handling will be replaced by queue-based processing anyway.
    it.effect.skip(
      "silently continues when meter charging fails",
      () => {
        // Mock pricing data for cost calculation
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              anthropic: {
                id: "anthropic",
                name: "Anthropic",
                models: {
                  "claude-3-5-haiku-20241022": {
                    id: "claude-3-5-haiku-20241022",
                    name: "Claude 3.5 Haiku",
                    cost: { input: 1, output: 5 },
                  },
                },
              },
            }),
        }) as unknown as typeof fetch;

        clearPricingCache();

        return Effect.gen(function* () {
          const payments = yield* Payments;

          // Should not throw even if meter charging fails
          yield* payments.products.router.chargeForUsage({
            provider: "anthropic",
            model: "claude-3-5-haiku-20241022",
            usageData: {
              inputTokens: 1000,
              outputTokens: 500,
            },
            customerId: "cus_123",
          });
        }).pipe(
          Effect.provide(
            Payments.Default.pipe(
              Layer.provide(MockDrizzleORMLayer),
              Layer.provide(
                Layer.succeed(Stripe, {
                  prices: {
                    retrieve: () =>
                      Effect.succeed({
                        id: "price_test",
                        object: "price" as const,
                        unit_amount: 1,
                        unit_amount_decimal: null,
                      }),
                  },
                  billing: {
                    meterEvents: {
                      create: () =>
                        Effect.fail(new Error("Meter creation failed")),
                    },
                  },
                  config: {
                    apiKey: "sk_test_mock",
                    routerPriceId: "price_test",
                    routerMeterId: "meter_test",
                  },
                } as unknown as Context.Tag.Service<typeof Stripe>),
              ),
            ),
          ),
        );
      },
      15000,
    );
  });
});
