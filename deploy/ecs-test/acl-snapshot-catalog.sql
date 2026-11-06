-- Execute only on the source reader's existing REPEATABLE READ READ ONLY transaction
-- that exported the snapshot supplied to pg_dump. This query never reads role passwords
-- or application rows; its output still belongs in a restricted, hash-bound receipt.
WITH RECURSIVE
schemas AS MATERIALIZED (
  SELECT n.* FROM pg_namespace n WHERE left(n.nspname,5)='zzsh_' OR n.nspname='public'
),
owners AS MATERIALIZED (
  SELECT datdba AS oid FROM pg_database WHERE datname=current_database()
  UNION SELECT nspowner AS oid FROM schemas
  UNION SELECT c.relowner FROM pg_class c JOIN schemas n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f')
  UNION SELECT p.proowner FROM pg_proc p JOIN schemas n ON n.oid=p.pronamespace
  UNION SELECT t.typowner FROM pg_type t JOIN schemas n ON n.oid=t.typnamespace
),
objects AS MATERIALIZED (
  SELECT 'database'::text AS kind,jsonb_build_object('database',d.datname) AS identity,d.datdba AS owner_id,
    COALESCE(d.datacl,acldefault('d',d.datdba)) AS acl,'{}'::jsonb AS properties
    FROM pg_database d WHERE d.datname=current_database()
  UNION ALL
  SELECT 'schema',jsonb_build_object('schema',n.nspname),n.nspowner,
    COALESCE(n.nspacl,acldefault('n',n.nspowner)) AS acl,'{}'::jsonb AS properties FROM schemas n
  UNION ALL
  SELECT 'relation',jsonb_build_object('schema',n.nspname,'name',c.relname,'relkind',c.relkind),c.relowner,
    COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner)),
    jsonb_build_object('rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity)
    FROM pg_class c JOIN schemas n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT 'column',jsonb_build_object('schema',n.nspname,'relation',c.relname,'column',a.attname),c.relowner,a.attacl,'{}'::jsonb
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN schemas n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'routine',jsonb_build_object('schema',n.nspname,'name',p.proname,'arguments',oidvectortypes(p.proargtypes),'kind',p.prokind),p.proowner,
    COALESCE(p.proacl,acldefault('f',p.proowner)),jsonb_build_object('securityDefiner',p.prosecdef,'config',to_jsonb(p.proconfig),
      'definitionSha256',CASE WHEN p.prokind='a' THEN NULL ELSE encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') END)
    FROM pg_proc p JOIN schemas n ON n.oid=p.pronamespace
  UNION ALL
  SELECT 'type',jsonb_build_object('schema',n.nspname,'name',t.typname,'kind',t.typtype),t.typowner,
    COALESCE(t.typacl,acldefault('T',t.typowner)),'{}'::jsonb FROM pg_type t JOIN schemas n ON n.oid=t.typnamespace
  UNION ALL
  SELECT 'defaultAcl',jsonb_build_object('schema',n.nspname,'objectType',d.defaclobjtype),d.defaclrole,d.defaclacl,'{}'::jsonb
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    WHERE (d.defaclnamespace=0 AND d.defaclrole IN (SELECT oid FROM owners)) OR n.oid IN (SELECT oid FROM schemas)
),
grants AS MATERIALIZED (
  SELECT o.kind,o.identity,o.owner_id,g.grantor,g.grantee,g.privilege_type,g.is_grantable
    FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) g
),
policies AS MATERIALIZED (
  SELECT n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles,
    pg_get_expr(p.polqual,p.polrelid) AS using_expr,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expr
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN schemas n ON n.oid=c.relnamespace
),
seeds AS MATERIALIZED (
  SELECT owner_id AS oid FROM objects
  UNION SELECT grantor FROM grants
  UNION SELECT grantee FROM grants WHERE grantee<>0
  UNION SELECT unnest(polroles) FROM policies
  UNION SELECT oid FROM pg_roles WHERE rolname=current_user
  UNION SELECT datdba FROM pg_database WHERE datname=current_database()
),
relevant_roles(oid) AS (
  SELECT oid FROM seeds WHERE oid<>0
  UNION
  SELECT x.oid FROM relevant_roles r JOIN pg_auth_members m ON m.member=r.oid OR m.roleid=r.oid
    CROSS JOIN LATERAL unnest(ARRAY[m.roleid,m.member,m.grantor]) AS x(oid)
)
SELECT jsonb_build_object(
  'schema','zzsh.acl-snapshot-catalog.v1',
  'database',current_database(),
  'transactionReadOnly',current_setting('transaction_read_only'),
  'transactionIsolation',current_setting('transaction_isolation'),
  'transactionSnapshot',pg_current_snapshot()::text,
  'objects',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',o.kind,'identity',o.identity,'owner',pg_get_userbyid(o.owner_id),
    'properties',o.properties,'acl',COALESCE((SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(g.grantor),
      'grantee',CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,'privilege',g.privilege_type,
      'grantable',g.is_grantable) ORDER BY pg_get_userbyid(g.grantor),
      CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,g.privilege_type,g.is_grantable)
      FROM grants g WHERE g.kind=o.kind AND g.identity=o.identity AND g.owner_id=o.owner_id),'[]'::jsonb))
    ORDER BY o.kind,o.identity::text,pg_get_userbyid(o.owner_id)) FROM objects o),'[]'::jsonb),
  'roles',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',r.rolname,'superuser',r.rolsuper,'inherit',r.rolinherit,
    'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,
    'connectionLimit',r.rolconnlimit,'validUntil',r.rolvaliduntil::text,
    'configSha256',CASE WHEN r.rolconfig IS NULL THEN NULL ELSE encode(sha256(convert_to(to_jsonb(r.rolconfig)::text,'UTF8')),'hex') END)
    ORDER BY r.rolname) FROM pg_roles r WHERE r.oid IN (SELECT oid FROM relevant_roles)),'[]'::jsonb),
  'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),
    'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
    ORDER BY pg_get_userbyid(m.roleid),pg_get_userbyid(m.member),pg_get_userbyid(m.grantor)) FROM pg_auth_members m
    WHERE m.roleid IN (SELECT oid FROM relevant_roles) AND m.member IN (SELECT oid FROM relevant_roles)),'[]'::jsonb),
  'roleSettings',COALESCE((SELECT jsonb_agg(jsonb_build_object('database',CASE WHEN s.setdatabase=0 THEN NULL ELSE current_database() END,
    'role',CASE WHEN s.setrole=0 THEN NULL ELSE pg_get_userbyid(s.setrole) END,
    'configSha256',encode(sha256(convert_to(to_jsonb(s.setconfig)::text,'UTF8')),'hex'))
    ORDER BY s.setdatabase,pg_get_userbyid(s.setrole)) FROM pg_db_role_setting s
    WHERE (s.setdatabase=0 OR s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()))
      AND (s.setrole=0 OR s.setrole IN (SELECT oid FROM relevant_roles))),'[]'::jsonb),
  'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',p.nspname,'relation',p.relname,'name',p.polname,
    'command',p.polcmd,'permissive',p.polpermissive,'roles',to_jsonb(ARRAY(SELECT CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END FROM unnest(p.polroles) x ORDER BY 1)),
    'using',p.using_expr,'check',p.check_expr) ORDER BY p.nspname,p.relname,p.polname) FROM policies p),'[]'::jsonb)
)::text AS acl_snapshot;
