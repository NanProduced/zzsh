CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_workspace_layout" (
  "admin_user_id" text PRIMARY KEY REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE,
  "layout_kind" text NOT NULL DEFAULT 'admin.workspace.layout' CHECK ("layout_kind" = 'admin.workspace.layout'),
  "version" integer NOT NULL CHECK ("version" > 0),
  "widgets" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "admin_workspace_layout_widgets_object" CHECK (jsonb_typeof("widgets") = 'array'),
  CONSTRAINT "admin_workspace_layout_widgets_size" CHECK (pg_column_size("widgets") <= 8192)
);
