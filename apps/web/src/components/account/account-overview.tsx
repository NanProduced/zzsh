"use client";

import { useEffect, useRef, useState } from "react";
import { webAuthRequest, WebAuthError } from "@/components/auth/auth-form";
import { useUserSession } from "@/components/session/user-session-provider";
import type { UserIdentitySnapshot } from "@/app/user-account-status";
import { MembershipGrowthRequestError, readMyMembershipGrowth, type MembershipGrowthViewState } from "@/lib/membership-growth-client";
import type { Order } from "@/lib/order-client";
import type { SecurityNicknameDraft, SecurityPendingWrite } from "./account-security-controls";
import { isAuthenticationFailure } from "./account-nav-constants";
import { AccountGrowthHeader } from "./account-growth-header";
import { AccountOverviewStrip } from "./account-overview-strip";
import { AccountPendingTasks } from "./account-pending-tasks";
import { AccountRecentOrdersPanel } from "./account-order-cards";

export function AccountOverview({
  scope,
  userId,
  nicknameDraft,
  pendingWrite,
}: {
  scope: string;
  userId?: string;
  nicknameDraft?: SecurityNicknameDraft;
  pendingWrite?: SecurityPendingWrite;
}) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const [reload, setReload] = useState(0);
  const [orderRefresh, setOrderRefresh] = useState({ renter: 0, owner: 0 });
  const [growthState, setGrowthState] = useState<{ scope: string; value: MembershipGrowthViewState }>({
    scope,
    value: { status: "loading" },
  });
  const [status, setStatus] = useState<{
    scope: string;
    phase: "loading" | "ready" | "error";
    phone: string | null;
    identity: UserIdentitySnapshot | null;
  }>({ scope, phase: "loading", phone: null, identity: null });

  const [renterOrderSummary, setRenterOrderSummary] = useState<{
    scope: string;
    status: "loading" | "ready" | "error";
    items: Order[];
    hasMore: boolean;
  }>({ scope, status: "loading", items: [], hasMore: false });

  const [ownerOrderSummary, setOwnerOrderSummary] = useState<{
    scope: string;
    status: "loading" | "ready" | "error";
    items: Order[];
    hasMore: boolean;
  }>({ scope, status: "loading", items: [], hasMore: false });

  const sequence = useRef(0);
  if (growthState.scope !== scope) {
    setGrowthState({ scope, value: { status: "loading" } });
  }
  if (status.scope !== scope) {
    setStatus({ scope, phase: "loading", phone: null, identity: null });
  }

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setGrowthState({ scope, value: { status: "loading" } });
    setStatus({ scope, phase: "loading", phone: null, identity: null });

    readMyMembershipGrowth(controller.signal).then(
      (value) => {
        if (current === sequence.current) setGrowthState({ scope, value });
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        const failure = error instanceof MembershipGrowthRequestError ? error : new MembershipGrowthRequestError(0, null);
        if (isAuthenticationFailure(failure)) revalidate();
        setGrowthState({
          scope,
          value: { status: "error", message: failure.message, retryable: failure.status === 0 || failure.status >= 500 },
        });
      }
    );

    (async () => {
      try {
        const profile = await webAuthRequest<{ user?: { id: string; phoneNumber?: string | null } } | null>(
          "/get-session",
          undefined,
          controller.signal
        );
        if (controller.signal.aborted || current !== sequence.current) return;
        if (profile?.user?.id !== session.userId) {
          revalidate();
          return;
        }
        const identity = await webAuthRequest<UserIdentitySnapshot>("/identity/status", undefined, controller.signal);
        if (controller.signal.aborted || current !== sequence.current) return;
        setStatus({ scope, phase: "ready", phone: profile.user.phoneNumber ?? null, identity });
      } catch (error) {
        if (controller.signal.aborted || current !== sequence.current) return;
        if (error instanceof WebAuthError && error.status === 401) revalidate();
        setStatus({ scope, phase: "error", phone: null, identity: null });
      }
    })();

    return () => controller.abort();
  }, [scope, reload, revalidate, session.userId]);

  const visibleGrowth = growthState.scope === scope ? growthState.value : { status: "loading" as const };
  const visibleStatus = status.scope === scope ? status : { scope, phase: "loading" as const, phone: null, identity: null };

  const currentRenterStatus = renterOrderSummary.scope === scope ? renterOrderSummary.status : "loading";
  const currentOwnerStatus = ownerOrderSummary.scope === scope ? ownerOrderSummary.status : "loading";
  const currentRenterOrders = renterOrderSummary.scope === scope ? renterOrderSummary.items : [];
  const currentOwnerOrders = ownerOrderSummary.scope === scope ? ownerOrderSummary.items : [];

  return (
    <div className="account-overview">
      <AccountGrowthHeader
        scope={scope}
        growthState={visibleGrowth}
        onRetry={() => setReload((v) => v + 1)}
        userId={userId}
        nicknameDraft={nicknameDraft}
        pendingWrite={pendingWrite}
      />

      <AccountOverviewStrip
        key={scope}
        scope={scope}
        phone={visibleStatus.phone}
        identity={visibleStatus.identity}
        identityPhase={visibleStatus.phase}
        onRetry={() => setReload((v) => v + 1)}
      />

      <AccountPendingTasks
        scope={scope}
        renterStatus={currentRenterStatus}
        ownerStatus={currentOwnerStatus}
        renterOrders={currentRenterOrders}
        ownerOrders={currentOwnerOrders}
        hasMore={(renterOrderSummary.scope === scope && renterOrderSummary.hasMore) || (ownerOrderSummary.scope === scope && ownerOrderSummary.hasMore)}
        onRetry={() => setOrderRefresh((v) => ({
          renter: v.renter + (currentRenterStatus === "error" ? 1 : 0),
          owner: v.owner + (currentOwnerStatus === "error" ? 1 : 0),
        }))}
      />

      <AccountRecentOrdersPanel
        scope={scope}
        renterRefreshVersion={orderRefresh.renter}
        ownerRefreshVersion={orderRefresh.owner}
        renterOrders={currentRenterOrders}
        ownerOrders={currentOwnerOrders}
        onRenterStatusChange={(status, items, hasMore) =>
          setRenterOrderSummary({ scope, status, items, hasMore })
        }
        onOwnerStatusChange={(status, items, hasMore) =>
          setOwnerOrderSummary({ scope, status, items, hasMore })
        }
      />
    </div>
  );
}
