import type { SessionSnapshot } from "../api";
import type { WorkspaceTab } from "../workspace/tab-model";
import { MembershipBenefitsWorkspace } from "./membership-benefits-workspace";
import { MembershipGrowthPolicyHost } from "./membership-growth-policy-host";
import { membershipGrowthAccess } from "./membership-growth-policy-read";

export type { PolicyBootstrap } from "./membership-growth-policy-read";
export { membershipGrowthAccess, normalizePolicyChange, policyDraftApprovalPayload } from "./membership-growth-policy-read";

type HostProps = { tab: WorkspaceTab; snapshot: Extract<SessionSnapshot, { authenticated: true }>; onDirtyChange: (dirty: boolean) => void; refreshNonce: number; onOpenPath?: (path: string, title?: string) => void };

export function MembershipGrowthAdminHost(props: HostProps) {
  const access = membershipGrowthAccess(props.snapshot);
  return <MembershipBenefitsWorkspace snapshot={props.snapshot} initialUserId={props.tab.query.userId} initialGameId={props.tab.query.gameId} refreshNonce={props.refreshNonce} onOpenPath={props.onOpenPath}
    initialTab={access.canReadPolicy && (props.tab.query.tab === "policy" || !access.canRequestEntitlement) ? "policy" : "entitlements"}
    policy={access.canReadPolicy ? <MembershipGrowthPolicyHost {...props} /> : undefined} />;
}
