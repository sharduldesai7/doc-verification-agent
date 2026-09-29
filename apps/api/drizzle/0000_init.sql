CREATE TABLE "applications" (
	"application_id" text PRIMARY KEY NOT NULL,
	"applicant_name" text,
	"employer_name" text,
	"stated_income_amount" numeric(14, 2),
	"stated_income_basis" text,
	"stated_monthly_income" numeric(14, 2),
	"currency" text,
	"source_file_name" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"object_path" text NOT NULL,
	"is_payslip" boolean,
	"document_type" text,
	"employer_name" text,
	"applicant_name" text,
	"gross_pay" double precision,
	"net_pay" double precision,
	"pay_date" text,
	"pay_period_start" text,
	"pay_period_end" text,
	"pay_month" text,
	"pay_frequency" text,
	"currency" text,
	"pay_evidence" jsonb,
	"pay_validation" jsonb,
	"extraction_metadata" jsonb,
	"employer_group" text,
	"in_window" boolean DEFAULT false NOT NULL,
	"included_in_aggregate" boolean DEFAULT false NOT NULL,
	"exclusion_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"stage" text DEFAULT 'processing' NOT NULL,
	"result_state" text,
	"result_description" text DEFAULT '' NOT NULL,
	"stated_applicant_name" text,
	"stated_employer_name" text,
	"stated_income_amount" numeric(14, 2),
	"stated_income_basis" text,
	"stated_monthly_income" numeric(14, 2),
	"stated_currency" text,
	"document_count" integer NOT NULL,
	"expected_window_income" double precision,
	"calculated_aggregate_income" double precision,
	"income_ratio" double precision,
	"expected_months" text[] DEFAULT '{}' NOT NULL,
	"employer_aggregates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_report" boolean DEFAULT false NOT NULL,
	"report_object_path" text,
	"error_message" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_submission_id_idx" ON "documents" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submissions_application_id_idx" ON "submissions" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "submissions_submitted_at_idx" ON "submissions" USING btree ("submitted_at");