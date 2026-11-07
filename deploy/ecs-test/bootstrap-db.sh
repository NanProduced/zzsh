#!/bin/sh
set -eu

case "${1:-}" in
  '') ZZSH_BOOTSTRAP_ROLES_ONLY=false ;;
  --roles-only) ZZSH_BOOTSTRAP_ROLES_ONLY=true ;;
  *) echo 'Expected no argument or --roles-only.' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo 'Expected no argument or --roles-only.' >&2; exit 2; }
export ZZSH_BOOTSTRAP_ROLES_ONLY

export PGHOST=postgres PGPORT=5432 PGUSER=zzsh_bootstrap PGDATABASE=postgres
export PGSSLMODE=verify-full PGSSLROOTCERT=/run/tls/internal-ca.crt
export PGPASSWORD="$(cat /run/secrets/bootstrap_password)"
export ZZSH_MIGRATION_PASSWORD="$(cat /run/secrets/migration_db_password)"
export ZZSH_RUNTIME_PASSWORD="$(cat /run/secrets/runtime_db_password)"
for value in "$PGPASSWORD" "$ZZSH_MIGRATION_PASSWORD" "$ZZSH_RUNTIME_PASSWORD"; do
  case "$value" in ''|*[!a-f0-9]*) echo 'Expected generated hexadecimal password files.' >&2; exit 2;; esac
  [ "${#value}" -ge 64 ] || { echo 'Generated password is too short.' >&2; exit 2; }
done

psql -X -w -v ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password ZZSH_MIGRATION_PASSWORD
\getenv runtime_password ZZSH_RUNTIME_PASSWORD
\getenv roles_only ZZSH_BOOTSTRAP_ROLES_ONLY
SELECT pg_advisory_lock(hashtext('zzsh-ecs-test-bootstrap'));
DO $$ BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'zzsh_bootstrap' THEN
    RAISE EXCEPTION 'Unexpected bootstrap identity';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_database WHERE datname='zzsh_ecs_test') OR EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname IN ('zzsh_ecs_owner','zzsh_ecs_migration','zzsh_ecs_runtime')) THEN
    RAISE EXCEPTION 'Target database or roles already exist; no automatic replacement';
  END IF;
END $$;
CREATE ROLE zzsh_ecs_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('CREATE ROLE zzsh_ecs_migration LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migration_password') \gexec
SELECT format('CREATE ROLE zzsh_ecs_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_password') \gexec
\if :roles_only
\echo 'Roles created; target database intentionally absent.'
\else
CREATE DATABASE zzsh_ecs_test OWNER zzsh_ecs_owner TEMPLATE template0 ENCODING 'UTF8';
COMMENT ON DATABASE zzsh_ecs_test IS 'zzsh:ecs-test:v1';
REVOKE ALL ON DATABASE zzsh_ecs_test FROM PUBLIC;
GRANT CONNECT,CREATE,TEMPORARY ON DATABASE zzsh_ecs_test TO zzsh_ecs_migration;
GRANT CONNECT,TEMPORARY ON DATABASE zzsh_ecs_test TO zzsh_ecs_runtime;
\endif
SELECT pg_advisory_unlock(hashtext('zzsh-ecs-test-bootstrap'));
SQL
echo 'Database bootstrap completed; no data was imported.'
