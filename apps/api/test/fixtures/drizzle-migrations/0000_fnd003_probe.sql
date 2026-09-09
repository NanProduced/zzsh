CREATE TABLE "fnd003"."probe" (
	"id" integer PRIMARY KEY NOT NULL,
	"unique_key" text NOT NULL,
	"amount" numeric(30, 9) NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "probe_unique_key_unique" UNIQUE("unique_key")
);
