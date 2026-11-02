/** Legacy verification preserves trading access without inventing age or new-channel evidence. */
export function identityAllowsProtectedTrade(state: { identityStatus?: string | null; ageStatus?: string | null; provider?: string | null } | null | undefined): boolean {
  return state?.identityStatus === "VERIFIED" && (state.ageStatus === "ADULT"
    || state.ageStatus === "UNKNOWN" && state.provider === "legacy_mysql_restore");
}
