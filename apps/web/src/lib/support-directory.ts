/** The order API owns membership; scan both paginated roles before declaring empty. */
export type SupportOrder = { id: string; displayNo: string; title: string; status: string; origin?: "NATIVE" | "LEGACY"; stage?: "PENDING_PAYMENT" | "WAITING_STAFF" | "TEAM_PENDING" | "OPENING_CONFIRM" | "RENTING" | "ENDING" | "SETTLED" | "CANCELLED" | null; party: "renter" | "owner"; createdAt?: string | null; lastMessageAt?: string | null; lastMessagePreview?: string | null; unreadCount?: number; fulfillmentAssignment?: { state: string; teamState: string | null; teamReady?: boolean } | null };
export async function* readSupportOrders(request: <T>(path: string) => Promise<T>, signal: AbortSignal): AsyncGenerator<{ items: SupportOrder[]; complete: boolean }> {
  const items = new Map<string, SupportOrder>();
  const scans = (["native", "legacy"] as const).flatMap(kind => (["renter", "owner"] as const).map(party => ({kind,party,cursor:null as string|null,seen:new Set<string>(),done:false})));
  while (scans.some(scan => !scan.done)) {
    for (const scan of scans) {
      if (scan.done) continue;
      signal.throwIfAborted();
      const page: {items: SupportOrder[]; nextCursor: string | null} = await request('/api/orders/' + (scan.kind === "legacy" ? 'legacy-im-groups' : '') + '?party=' + scan.party + '&limit=100' + (scan.cursor ? '&cursor=' + encodeURIComponent(scan.cursor) : ''));
      signal.throwIfAborted();
      if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('订单目录响应格式无效');
      for (const item of page.items) if (item.fulfillmentAssignment) items.set(item.id,{...item, party:scan.party, fulfillmentAssignment: {...item.fulfillmentAssignment,teamState:item.fulfillmentAssignment.teamState??(item.fulfillmentAssignment.teamReady?"READY":null)}});
      scan.cursor = page.nextCursor;
      if (scan.cursor && scan.seen.has(scan.cursor)) throw new Error('订单目录分页未完成，请重试');
      if (scan.cursor) scan.seen.add(scan.cursor); else scan.done=true;
      yield {items: [...items.values()], complete: scans.every(entry => entry.done)};
    }
  }
}
