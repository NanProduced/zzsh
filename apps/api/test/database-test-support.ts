export const DATABASE_CLEANUP_TIMEOUT_MS = 2_000;

export type ReleasableClient = {
  release: (destroy?: boolean) => void;
};

export async function closeResource(
  authorized: boolean,
  client: ReleasableClient,
  cleanup: () => Promise<void>,
): Promise<void> {
  if (!authorized) {
    client.release(true);
    return;
  }
  try {
    await cleanup();
  } finally {
    client.release();
  }
}

export async function settlesWithin(
  pending: Promise<unknown> | undefined,
  timeoutMs = DATABASE_CLEANUP_TIMEOUT_MS,
): Promise<boolean> {
  if (!pending) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function finishDatabaseTest(
  primaryError: unknown,
  cleanup: () => Promise<void>,
  closeTestPool: () => Promise<void>,
  closeAdminPool: () => Promise<void>,
): Promise<void> {
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await closeTestPool();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await closeAdminPool();
  } catch (error) {
    cleanupError ??= error;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

// Explicit tables owned by the isolated business test target; never use CASCADE.
export const ISOLATED_BUSINESS_DATA_TRUNCATE = `TRUNCATE
      "zzsh_order"."rental_order",
      "zzsh_content"."content_version",
      "zzsh_content"."content_item",
      "zzsh_content"."carousel_item",
      "zzsh_supply"."favorite",
      "zzsh_supply"."legacy_supply_map",
      "zzsh_supply"."duplicate_hint",
      "zzsh_supply"."review_decision",
      "zzsh_supply"."listing_media",
      "zzsh_supply"."listing_entitlement",
      "zzsh_supply"."listing_skin",
      "zzsh_supply"."inventory_line",
      "zzsh_supply"."listing_version",
      "zzsh_supply"."gunsmith_code",
      "zzsh_supply"."firearm_alias",
      "zzsh_supply"."firearm",
      "zzsh_supply"."firearm_classification",
      "zzsh_supply"."game_service_operation",
      "zzsh_supply"."game",
      "zzsh_supply"."billable_item",
      "zzsh_supply"."skin_rarity",
      "zzsh_supply"."skin_category",
      "zzsh_supply"."skin",
      "zzsh_supply"."entitlement",
      "zzsh_supply"."rental_account",
      "zzsh_supply"."price_version",
      "zzsh_supply"."price_line",
      "zzsh_supply"."term_version",
      "zzsh_supply"."term_option",
      "zzsh_supply"."agreement_version",
      "zzsh_supply"."rule_release",
      "zzsh_supply"."rule_acceptance",
      "zzsh_supply"."media_upload_intent",
      "zzsh_supply"."media_asset",
      "zzsh_supply"."idempotency_record",
      "zzsh_supply"."admin_supply_scope",
      "zzsh_iam"."admin_workspace_layout",
      "zzsh_iam"."approval_execution",
      "zzsh_iam"."approval_decision",
      "zzsh_iam"."approval_request_candidate",
      "zzsh_iam"."approval_request",
      "zzsh_iam"."approval_template_candidate",
      "zzsh_iam"."approval_template",
      "zzsh_iam"."admin_user_permission",
      "zzsh_iam"."admin_user_role",
      "zzsh_iam"."admin_role_permission",
      "zzsh_iam"."admin_recovery_request",
      "zzsh_iam"."admin_recovery_notification_target",
      "zzsh_iam"."admin_security_notification_outbox",
      "zzsh_auth_admin"."twoFactor",
      "zzsh_auth_admin"."verification",
      "zzsh_auth_admin"."session",
      "zzsh_auth_admin"."account",
      "zzsh_auth_admin"."user",
      "zzsh_auth_user"."twoFactor",
      "zzsh_auth_user"."verification",
      "zzsh_auth_user"."session",
      "zzsh_auth_user"."account",
      "zzsh_auth_user"."user",
      "zzsh_iam"."user_identity_state",
      "zzsh_iam"."admin_security",
      "zzsh_iam"."audit_event"`;
