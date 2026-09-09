CREATE SCHEMA IF NOT EXISTS "zzsh_meta";
--> statement-breakpoint
CREATE TABLE "zzsh_meta"."database_marker" (
	"marker_key" text PRIMARY KEY NOT NULL,
	"database_name" text NOT NULL,
	"target" text NOT NULL,
	"role_name" text NOT NULL,
	"marker_version" integer NOT NULL
);
--> statement-breakpoint
INSERT INTO "zzsh_meta"."database_marker" (
	"marker_key",
	"database_name",
	"target",
	"role_name",
	"marker_version"
)
VALUES ('fnd004-test-database', 'zzsh_test_fnd004', 'zzsh-rebuild-local', 'zzsh', 1);
