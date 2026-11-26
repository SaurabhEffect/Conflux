CREATE TABLE "sandbox_docs" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"cursor_color" text NOT NULL,
	"is_host" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_participants_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandboxes_ticket_hash_unique" UNIQUE("ticket_hash")
);
--> statement-breakpoint
ALTER TABLE "sandbox_docs" ADD CONSTRAINT "sandbox_docs_page_id_sandbox_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."sandbox_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_pages" ADD CONSTRAINT "sandbox_pages_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_participants" ADD CONSTRAINT "sandbox_participants_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_pages_sandbox_idx" ON "sandbox_pages" USING btree ("sandbox_id");--> statement-breakpoint
CREATE INDEX "sandbox_participants_sandbox_idx" ON "sandbox_participants" USING btree ("sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_one_host_idx" ON "sandbox_participants" USING btree ("sandbox_id") WHERE "sandbox_participants"."is_host";--> statement-breakpoint
CREATE INDEX "sandboxes_expires_idx" ON "sandboxes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sandboxes_active_idx" ON "sandboxes" USING btree ("last_active_at");