-- The two filtered counts ignore every other type, so this predicate preserves their result
-- while allowing the existing (type, child_user_id) index to serve each deferred check.
DO $distribution_relation_guard_preflight$
BEGIN
  IF current_setting('session_replication_role') NOT IN ('origin','local')
     OR to_regprocedure('zzsh_order.check_distribution_relation_knowledge()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='zzsh_order' AND c.relname='distribution_participant'
         AND t.tgname='distribution_participant_knowledge_guard' AND t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal
         AND t.tgenabled IN ('O','A') AND t.tgtype=21 AND t.tgfoid=to_regprocedure('zzsh_order.check_distribution_relation_knowledge()')
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='zzsh_order' AND c.relname='invitation_relation'
         AND t.tgname='invitation_relation_knowledge_guard' AND t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal
         AND t.tgenabled IN ('O','A') AND t.tgtype=5 AND t.tgfoid=to_regprocedure('zzsh_order.check_distribution_relation_knowledge()')
     ) THEN
    RAISE EXCEPTION 'DISTRIBUTION_RELATION_KNOWLEDGE_GUARD_INCOMPLETE' USING ERRCODE='23514';
  END IF;
END
$distribution_relation_guard_preflight$;

CREATE OR REPLACE FUNCTION zzsh_order.check_distribution_relation_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject text;p zzsh_order.distribution_participant;inviter_count integer;leader_count integer;
BEGIN
 IF TG_TABLE_NAME='distribution_participant' THEN subject:=NEW.user_id;
 ELSIF TG_TABLE_NAME='invitation_relation' THEN subject:=NEW.child_user_id;
 ELSE RAISE EXCEPTION 'unadmitted relation knowledge trigger table' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM zzsh_order.distribution_participant WHERE user_id=subject;
 SELECT count(*) FILTER(WHERE type='INVITER'),count(*) FILTER(WHERE type='DISTRIBUTION_LEADER')
  INTO inviter_count,leader_count FROM zzsh_order.invitation_relation WHERE child_user_id=subject
   AND type IN ('INVITER','DISTRIBUTION_LEADER');
 IF p.user_id IS NULL OR (p.inviter_knowledge='KNOWN_PARENT') IS DISTINCT FROM (inviter_count=1)
  OR (p.leader_knowledge='KNOWN_PARENT') IS DISTINCT FROM (leader_count=1)
 THEN RAISE EXCEPTION 'invitation relation and participant knowledge disagree' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
