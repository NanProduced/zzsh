const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// Reuse the isolated refund contract and pin the source before adapting its admission.
module.exports = function controlledFixedFeeRefundSql() {
  const source = readFileSync(join(__dirname, "../ecs-test-demo-finance/demo-refund.sql"), "utf8").replace(/\r\n/g, "\n");
  if (createHash("sha256").update(source).digest("hex") !== "cedc9d3231e138c2bd00c42b4883bbc48502a2124c840c2c722a1024e94077ca")
    throw new Error("Isolated refund SQL changed; review the fixed-fee admission");
  const contract = source.slice(source.indexOf("ALTER TABLE zzsh_order.channel_refund_intent"))
    .replaceAll("ecs_test_demo_finance_registration", "fixed_fee_refund_registration")
    .replaceAll("zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)", "zzsh_order.fixed_fee_refund_resource_matches()")
    .replaceAll("(CASE WHEN s.canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1' THEN 'ecs_demo_' ELSE 'local_demo_' END)||substr(s.registration_digest,1,32)", "'fixed-fee-isolated'")
    .replaceAll("((s.canonical_registration::jsonb #>> '{resource,databaseOid}')::oid)", "3513966")
    .replace("JOIN zzsh_order.controlled_payment_declaration d\n   ON d.admission_id=a0.id AND d.order_id=a0.order_id AND d.merchant_scope_id=NEW.merchant_identity_id AND d.provider_transaction_id=NEW.original_payment_trx_no",
      "JOIN zzsh_order.payment_distribution_basis b\n   ON b.admission_id=a0.id AND b.order_id=a0.order_id AND b.admission_revision=a0.revision AND b.payment_confirmation_id=NEW.payment_confirmation_id")
    .replace("AND d.approval_digest=s.registration_digest", "AND a0.mode='LOCAL_CONTROLLED' AND a0.resource_marker='zzsh:synthetic:fixed-fee:v1'")
    .replace("CHECK (source_kind<>'LOCAL_CONTROLLED_WITHDRAWAL')",
      "CHECK (source_kind<>'LOCAL_CONTROLLED_WITHDRAWAL' AND (source_kind<>'LOCAL_CONTROLLED_RENTAL_REFUND' OR source_system='zzsh-local-controlled'))")
    .replace("evidence_level='CONTROLLED_TEST' AND sandbox_registration_ref IS NOT NULL));",
      "evidence_level='CONTROLLED_TEST' AND merchant_identity_id='fixed-fee-isolated' AND sandbox_registration_ref IS NOT NULL));");
  return readFileSync(join(__dirname, "controlled-test-refund-resource.sql"), "utf8") + "\n" + contract + "\n" +
    "GRANT INSERT(sandbox_registration_ref),UPDATE(demo_terminal_evidence_id) ON zzsh_order.channel_refund_intent TO zzsh_m3b_fixed_fee_r;\n" +
    "GRANT SELECT ON zzsh_order.local_controlled_refund_operation,zzsh_order.local_controlled_refund_evidence TO zzsh_m3b_fixed_fee_r;\n" +
    "GRANT INSERT(id,intent_id,sandbox_registration_ref,scenario,refund_order_no,original_payment_trx_no,amount_cents,currency,final_canonical,final_digest,original_lease_version,original_lease_owner) ON zzsh_order.local_controlled_refund_operation TO zzsh_m3b_fixed_fee_r;\n" +
    "GRANT INSERT(id,intent_id,operation_id,sandbox_registration_ref,terminal,refund_transaction_no,completed_at,facts_canonical,facts_digest,lease_version,lease_owner) ON zzsh_order.local_controlled_refund_evidence TO zzsh_m3b_fixed_fee_r;\n" +
    "GRANT EXECUTE ON FUNCTION zzsh_order.local_controlled_refund_liability_complete(text),zzsh_order.local_controlled_refund_terminal_complete(text) TO zzsh_m3b_fixed_fee_r;\n";
};
