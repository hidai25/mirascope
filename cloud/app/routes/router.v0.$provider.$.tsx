import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { authenticate } from "@/auth";
import { Database } from "@/db";
import { handleErrors, handleDefects } from "@/api/utils";
import { proxyToProvider } from "@/api/router/proxy";
import type { StreamMeteringContext } from "@/api/router/streaming";
import {
  PROVIDER_CONFIGS,
  isValidProvider,
  getProviderApiKey,
  getCostCalculator,
  extractModelId,
} from "@/api/router/providers";
import { InternalError, UnauthorizedError } from "@/errors";
import { Payments } from "@/payments";
import { estimateCost, getFallbackEstimate } from "@/api/router/cost-estimator";

/**
 * Unified Provider Proxy Route
 *
 * Catches all requests to `/router/v0/{provider}/*` and proxies them to the respective
 * AI provider's API. Authenticates users via Mirascope API key, uses internal provider
 * API keys, extracts usage data, and calculates costs.
 *
 * Supported providers: openai, anthropic, google
 *
 * Base URL examples:
 * - OpenAI: `base_url="https://mirascope.com/router/v0/openai/v1"`
 * - Anthropic: `base_url="https://mirascope.com/router/v0/anthropic"`
 * - Google: `base_url="https://mirascope.com/router/v0/google/v1beta"`
 *
 * Request examples:
 * - `/router/v0/openai/v1/chat/completions` → `https://api.openai.com/v1/chat/completions`
 * - `/router/v0/anthropic/v1/messages` → `https://api.anthropic.com/v1/messages`
 * - `/router/v0/google/v1beta/models/{model}:generateContent` → Google API
 */
export const Route = createFileRoute("/router/v0/$provider/$")({
  server: {
    handlers: {
      ANY: async ({
        request,
        params,
      }: {
        request: Request;
        params: { provider: string; "*"?: string };
      }) => {
        const databaseUrl = process.env.DATABASE_URL;
        const provider = params.provider.toLowerCase();

        const handler = Effect.gen(function* () {
          if (!databaseUrl) {
            return yield* new InternalError({
              message: "Database not configured",
            });
          }

          // Validate provider
          if (!isValidProvider(provider)) {
            return yield* new InternalError({
              message: `Unsupported provider: ${provider}`,
            });
          }

          // Authenticate user via Mirascope API key
          const { user, apiKeyInfo } = yield* authenticate(request);

          if (!apiKeyInfo) {
            return yield* new UnauthorizedError({
              message: "API key required for router access",
            });
          }

          // Get database service
          const db = yield* Database;
          const payments = yield* Payments; // For balance check and metering

          // Get the organization for this API key
          const organization = yield* db.organizations.findById({
            organizationId: apiKeyInfo.organizationId,
            userId: user.id,
          });

          // Get provider-specific API key from environment
          const providerApiKey = getProviderApiKey(provider);

          if (!providerApiKey) {
            return yield* new InternalError({
              message: `${provider} API key not configured`,
            });
          }

          // Parse request body for all providers (needed for cost estimation)
          const requestBodyText = yield* Effect.tryPromise({
            try: () => request.clone().text(),
            catch: () => null as string | null,
          });

          let parsedRequestBody: unknown = null;
          if (requestBodyText) {
            try {
              parsedRequestBody = JSON.parse(requestBodyText);
            } catch {
              // Not JSON, that's ok for Google (uses URL for model)
            }
          }

          // Extract model ID based on provider (Google uses URL, others use body)
          const modelId = extractModelId(provider, request, parsedRequestBody);

          // Fail early if we can't extract model ID
          if (!modelId) {
            return yield* new InternalError({
              message: `Failed to extract model ID from ${provider} request`,
            });
          }

          // Fail early if we can't parse request body (needed for cost estimation)
          if (!parsedRequestBody) {
            return yield* new InternalError({
              message: "Failed to parse request body for cost estimation",
            });
          }

          // Reserve funds before making the request (prevents concurrent overdraft)
          const estimate = yield* estimateCost({
            provider,
            model: modelId,
            requestBody: parsedRequestBody,
          }).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
            Effect.map(
              (estimate) => estimate ?? getFallbackEstimate(parsedRequestBody),
            ),
          );

          const reservationId = yield* payments.products.router.reserveFunds({
            customerId: organization.stripeCustomerId,
            organizationId: organization.id,
            estimatedCost: estimate.cost,
            model: modelId,
            provider,
          });

          // Prepare metering context for streaming responses
          const meteringContext: StreamMeteringContext = {
            stripeCustomerId: organization.stripeCustomerId,
            stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
            routerPriceId: process.env.STRIPE_ROUTER_PRICE_ID || "",
            routerMeterId: process.env.STRIPE_ROUTER_METER_ID || "",
            provider,
            model: modelId,
            reservationId,
            databaseUrl,
          };

          // Make the request with error handling for fund release
          const proxyResult = yield* proxyToProvider(
            request,
            {
              ...PROVIDER_CONFIGS[provider],
              apiKey: providerApiKey,
            },
            provider,
            meteringContext,
          ).pipe(
            Effect.catchAll((error) => {
              // Release funds on proxy error
              return Effect.gen(function* () {
                yield* payments.products.router
                  .releaseFunds(reservationId)
                  .pipe(
                    Effect.catchAll((releaseError) => {
                      console.error(
                        `Failed to release reservation ${reservationId} after proxy error:`,
                        releaseError,
                      );
                      return Effect.succeed(undefined);
                    }),
                  );
                return yield* Effect.fail(error);
              });
            }),
          );

          // For streaming responses, settlement is handled automatically in streaming.ts
          // via the meteringContext which includes the reservationId and databaseUrl
          if (proxyResult.bodyPromise) {
            return proxyResult.response;
          }

          // For non-streaming responses, settle reservation with actual cost
          // Calculate actual cost without charging (settleFunds will charge)
          // provider is guaranteed to be valid due to validation on line 58
          const costCalculator = getCostCalculator(provider);

          // Extract usage from response body
          const usage = proxyResult.body
            ? costCalculator.extractUsage(proxyResult.body)
            : null;

          const costResult = usage
            ? yield* costCalculator
                .calculate(modelId, usage)
                .pipe(Effect.catchAll(() => Effect.succeed(null)))
            : null;

          if (costResult && costResult.cost.totalCost > 0) {
            // Settle reservation - this updates DB and charges the meter
            yield* payments.products.router
              .settleFunds(reservationId, costResult.cost.totalCost)
              .pipe(
                Effect.catchAll((error) => {
                  console.error(
                    `Failed to settle reservation ${reservationId} (cost: $${costResult.cost.totalCost.toFixed(6)}):`,
                    error,
                  );
                  return Effect.succeed(undefined);
                }),
              );
          } else {
            // No usage or cost calculation failed, release funds
            yield* payments.products.router.releaseFunds(reservationId).pipe(
              Effect.catchAll((error) => {
                console.error(
                  `Failed to release reservation ${reservationId} (no usage):`,
                  error,
                );
                return Effect.succeed(undefined);
              }),
            );
          }

          return proxyResult.response;
        }).pipe(
          Effect.provide(
            Database.Live({
              database: { connectionString: databaseUrl },
              payments: {
                apiKey: process.env.STRIPE_SECRET_KEY || "",
                routerPriceId: process.env.STRIPE_ROUTER_PRICE_ID || "",
                routerMeterId: process.env.STRIPE_ROUTER_METER_ID || "",
              },
            }),
          ),
          handleErrors,
          handleDefects,
        );

        return Effect.runPromise(handler);
      },
    },
  },
});
