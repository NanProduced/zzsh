CREATE TABLE "fnd004_probe"."rollback_probe" (
	"id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT INTO "fnd004_probe"."rollback_probe" ("id") VALUES (1);
--> statement-breakpoint
THIS IS NOT VALID SQL;
