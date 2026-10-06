"use client";

import { useRef, useState } from "react";
import type { UserSessionApi } from "@/components/session/user-session-provider";

/**
 * Identity changes reset all local state during render (so another subject never sees the
 * previous one's private projection) and expose `isCurrent` so late responses from the old
 * identity are dropped instead of being rendered.
 */
export function useIdentityReset(session: UserSessionApi, reset: () => void): { userId: string | null; isCurrent: (candidate: string | null) => boolean } {
  const userId = session.status === "authenticated" && session.userId ? session.userId : null;
  const [previous, setPrevious] = useState<string | null | undefined>(undefined);
  const current = useRef<string | null>(userId);
  current.current = userId;
  if (previous !== userId) {
    setPrevious(userId);
    reset();
  }
  return { userId, isCurrent: (candidate: string | null) => current.current === candidate };
}
