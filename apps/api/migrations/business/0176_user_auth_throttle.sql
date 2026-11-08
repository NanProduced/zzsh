-- 用户认证的 PostgreSQL 限流存储。已有对象只能按完整结构核验后承接。
DO $guard$
DECLARE existing integer;
BEGIN
  SELECT count(*)::integer INTO existing FROM unnest(ARRAY[
    'zzsh_iam.user_auth_throttle_event','zzsh_iam.user_auth_captcha_used','zzsh_iam.user_auth_throttle_event_id_seq',
    'zzsh_iam.user_auth_throttle_event_pkey','zzsh_iam.user_auth_captcha_used_pkey',
    'zzsh_iam.user_auth_throttle_event_lookup_idx','zzsh_iam.user_auth_throttle_event_ticket_idx',
    'zzsh_iam.user_auth_throttle_event_expiry_idx','zzsh_iam.user_auth_captcha_used_expiry_idx'
  ]) AS name WHERE to_regclass(name) IS NOT NULL;
  IF existing NOT IN (0,9) THEN RAISE EXCEPTION 'User authentication throttle schema is partially present'; END IF;
  IF existing=9 AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='zzsh_iam' AND c.relname IN('user_auth_throttle_event','user_auth_captcha_used','user_auth_throttle_event_id_seq')
      AND pg_get_userbyid(c.relowner)=current_user)<>3 THEN
    RAISE EXCEPTION 'User authentication throttle owner differs';
  END IF;
END
$guard$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS zzsh_iam.user_auth_throttle_event (
  id bigserial PRIMARY KEY,
  realm text NOT NULL CHECK (realm = 'user'),
  purpose text NOT NULL CHECK (purpose IN ('sign-in', 'sms-phone', 'sms-ip', 'base')),
  subject text NOT NULL CHECK (subject ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('reserved', 'failure', 'sent', 'unknown')),
  ticket text NOT NULL CHECK (ticket ~ '^[0-9a-f]{32}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_auth_throttle_event_lookup_idx
  ON zzsh_iam.user_auth_throttle_event (realm, purpose, subject, occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_auth_throttle_event_ticket_idx ON zzsh_iam.user_auth_throttle_event (ticket);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_auth_throttle_event_expiry_idx ON zzsh_iam.user_auth_throttle_event (expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS zzsh_iam.user_auth_captcha_used (
  realm text NOT NULL CHECK (realm = 'user'),
  signature text NOT NULL CHECK (length(signature) BETWEEN 1 AND 128),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (realm, signature)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_auth_captcha_used_expiry_idx ON zzsh_iam.user_auth_captcha_used (expires_at);
--> statement-breakpoint
DO $guard$
DECLARE actual text;
BEGIN
  PERFORM set_config('search_path','pg_catalog, public',true);
  WITH target AS (
    SELECT c.oid,c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relispartition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='zzsh_iam' AND c.relname IN('user_auth_throttle_event','user_auth_captcha_used')
  ), manifest AS (
    SELECT jsonb_build_object(
      'tables',(SELECT jsonb_agg(jsonb_build_array(relname,relkind,relpersistence,relrowsecurity,relforcerowsecurity,relispartition) ORDER BY relname) FROM target),
      'columns',(SELECT jsonb_agg(jsonb_build_array(t.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
          coalesce(pg_get_expr(d.adbin,d.adrelid),'')) ORDER BY t.relname,a.attnum)
        FROM target t JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(t.relname,c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid)) ORDER BY t.relname,c.conname)
        FROM target t JOIN pg_constraint c ON c.conrelid=t.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(t.relname,i.relname,x.indisvalid,x.indisready,x.indisunique,pg_get_indexdef(i.oid)) ORDER BY t.relname,i.relname)
        FROM target t JOIN pg_index x ON x.indrelid=t.oid JOIN pg_class i ON i.oid=x.indexrelid),
      'sequence',(SELECT jsonb_build_array(format_type(s.seqtypid,NULL),s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle,
          (SELECT count(*) FROM pg_depend d JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
           WHERE d.classid='pg_class'::regclass AND d.objid=s.seqrelid AND d.refclassid='pg_class'::regclass
            AND d.refobjid=to_regclass('zzsh_iam.user_auth_throttle_event') AND a.attname='id' AND d.deptype='a'))
        FROM pg_sequence s WHERE s.seqrelid=to_regclass('zzsh_iam.user_auth_throttle_event_id_seq')),
      'userTriggers',(SELECT count(*) FROM pg_trigger g JOIN target t ON t.oid=g.tgrelid WHERE NOT g.tgisinternal)
    ) AS value
  )
  SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') INTO actual FROM manifest;
  IF actual IS DISTINCT FROM '6da533ee5148b8a68d6276ae921771ad3d3c33a4a8a5a765f7066ff980c04615' THEN
    RAISE EXCEPTION 'User authentication throttle structure differs';
  END IF;
END
$guard$;
--> statement-breakpoint
REVOKE ALL ON zzsh_iam.user_auth_throttle_event, zzsh_iam.user_auth_captcha_used FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE zzsh_iam.user_auth_throttle_event_id_seq FROM PUBLIC;
--> statement-breakpoint
COMMENT ON TABLE zzsh_iam.user_auth_throttle_event IS '用户认证限流事件，不保存原始手机号或 IP。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.id IS '限流事件编号。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.realm IS '认证域。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.purpose IS '限流用途。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.subject IS '按用途生成的主体 HMAC 摘要。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.kind IS '限流事件类型。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.ticket IS '请求占位标识。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.occurred_at IS '事件发生时间。';
COMMENT ON COLUMN zzsh_iam.user_auth_throttle_event.expires_at IS '事件过期时间。';
COMMENT ON TABLE zzsh_iam.user_auth_captcha_used IS '已使用的用户认证验证挑战，防止重复使用。';
COMMENT ON COLUMN zzsh_iam.user_auth_captcha_used.realm IS '认证域。';
COMMENT ON COLUMN zzsh_iam.user_auth_captcha_used.signature IS '已使用挑战的签名。';
COMMENT ON COLUMN zzsh_iam.user_auth_captcha_used.expires_at IS '挑战过期时间。';
