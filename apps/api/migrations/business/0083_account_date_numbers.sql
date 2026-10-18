-- Candidate only: root assigns the append-only migration number and runtime ACL hunk.
-- No existing canonical, old sequence, source snapshot or public admission is rewritten.
DO $$
DECLARE n text; day date;
BEGIN
  FOR n IN SELECT display_no FROM zzsh_supply.rental_account WHERE display_no IS NOT NULL LOOP
    IF length(n)<=128 AND n ~ '^AC[0-9]{10,}$' THEN CONTINUE; END IF;
    IF n !~ '^ZZ[0-9]{14}$' OR substring(n FROM 11 FOR 6)='000000' THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_FORMAT_REVIEW_REQUIRED';
    END IF;
    BEGIN
      day := make_date(substring(n FROM 3 FOR 4)::integer,substring(n FROM 7 FOR 2)::integer,substring(n FROM 9 FOR 2)::integer);
    EXCEPTION WHEN datetime_field_overflow THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_FORMAT_REVIEW_REQUIRED';
    END;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE zzsh_supply.account_display_no_counter (
  business_date date PRIMARY KEY CHECK (business_date>=DATE '0001-01-01' AND business_date<DATE '10000-01-01'),
  last_value integer NOT NULL CHECK (last_value BETWEEN 1 AND 999999)
);
--> statement-breakpoint
-- Other resources may already contain assigned ZZ values; seed their high-water marks, never renumber them.
INSERT INTO zzsh_supply.account_display_no_counter(business_date,last_value)
SELECT make_date(substring(display_no FROM 3 FOR 4)::integer,substring(display_no FROM 7 FOR 2)::integer,substring(display_no FROM 9 FOR 2)::integer),
       max(substring(display_no FROM 11 FOR 6)::integer)
FROM zzsh_supply.rental_account WHERE display_no ~ '^ZZ[0-9]{14}$' GROUP BY 1;
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.next_dated_account_display_no() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE business_day date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date; n integer;
BEGIN
  INSERT INTO zzsh_supply.account_display_no_counter AS counter(business_date,last_value)
  VALUES(business_day,1)
  ON CONFLICT(business_date) DO UPDATE SET last_value=counter.last_value+1
    WHERE counter.last_value<999999
  RETURNING last_value INTO n;
  IF n IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='ACCOUNT_NUMBER_DAY_EXHAUSTED';
  END IF;
  RETURN 'ZZ'||to_char(business_day,'YYYYMMDD')||lpad(n::text,6,'0');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_supply.guard_account_public_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocating boolean := TG_OP='INSERT'; day date;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.display_no IS NOT NULL AND NEW.display_no IS DISTINCT FROM OLD.display_no THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_IMMUTABLE';
    END IF;
    allocating := OLD.display_no IS NULL;
  END IF;
  IF NEW.display_no IS NOT NULL AND (btrim(NEW.display_no)='' OR btrim(NEW.display_no)<>NEW.display_no OR length(NEW.display_no)>128 OR NEW.display_no ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'ACCOUNT_NUMBER_INVALID';
  END IF;
  IF allocating AND NEW.display_no IS NOT NULL THEN
    IF NEW.display_no !~ '^ZZ[0-9]{14}$' OR substring(NEW.display_no FROM 11 FOR 6)='000000' THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_INVALID';
    END IF;
    BEGIN
      day := make_date(substring(NEW.display_no FROM 3 FOR 4)::integer,substring(NEW.display_no FROM 7 FOR 2)::integer,substring(NEW.display_no FROM 9 FOR 2)::integer);
    EXCEPTION WHEN datetime_field_overflow THEN
      RAISE EXCEPTION 'ACCOUNT_NUMBER_INVALID';
    END;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Narrow inherited defaults before migration COMMIT, including explicit column grants.
DO $account_date_initial_acl$
DECLARE relation_oid oid; owner_oid oid; function_oid oid; function_owner_oid oid;
  column_list text; grant_row record; grantee_sql text;
BEGIN
  SELECT oid,relowner INTO STRICT relation_oid,owner_oid FROM pg_class
    WHERE oid='zzsh_supply.account_display_no_counter'::regclass;
  SELECT string_agg(format('%I',attname),',' ORDER BY attnum) INTO STRICT column_list
    FROM pg_attribute WHERE attrelid=relation_oid AND attnum>0 AND NOT attisdropped;
  FOR grant_row IN
    SELECT DISTINCT grantee FROM (
      SELECT 0::oid AS grantee
      UNION ALL SELECT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=relation_oid
      UNION ALL SELECT a.grantee FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
        WHERE c.attrelid=relation_oid AND c.attnum>0 AND NOT c.attisdropped
    ) grants WHERE grantee<>owner_oid
  LOOP
    IF grant_row.grantee=0 THEN grantee_sql:='PUBLIC';
    ELSE SELECT format('%I',rolname) INTO STRICT grantee_sql FROM pg_roles WHERE oid=grant_row.grantee; END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE zzsh_supply.account_display_no_counter FROM %s',grantee_sql);
    EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE zzsh_supply.account_display_no_counter FROM %s',column_list,grantee_sql);
  END LOOP;
  SELECT oid,proowner INTO STRICT function_oid,function_owner_oid FROM pg_proc
    WHERE oid='zzsh_supply.next_dated_account_display_no()'::regprocedure;
  FOR grant_row IN
    SELECT DISTINCT grantee FROM (
      SELECT 0::oid AS grantee
      UNION ALL SELECT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=function_oid
    ) grants WHERE grantee<>function_owner_oid
  LOOP
    IF grant_row.grantee=0 THEN grantee_sql:='PUBLIC';
    ELSE SELECT format('%I',rolname) INTO STRICT grantee_sql FROM pg_roles WHERE oid=grant_row.grantee; END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION zzsh_supply.next_dated_account_display_no() FROM %s',grantee_sql);
  END LOOP;
END $account_date_initial_acl$;
