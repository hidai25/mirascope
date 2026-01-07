CREATE TYPE "public"."reservation_status" AS ENUM('active', 'settled', 'released', 'expired');--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimated_cost" numeric(10, 6) NOT NULL,
	"actual_cost" numeric(10, 6),
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"request_id" text,
	"model" text,
	"provider" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp,
	"released_at" timestamp,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_reservations_customer_status_index" ON "credit_reservations" USING btree ("stripe_customer_id","status");--> statement-breakpoint
CREATE INDEX "credit_reservations_expires_at_index" ON "credit_reservations" USING btree ("expires_at") WHERE "credit_reservations"."status" = 'active';