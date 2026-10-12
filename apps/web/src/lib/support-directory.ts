/** The order API owns membership; scan both paginated roles before declaring empty. */
export type SupportOrder = { id: string; displayNo: string; title: string; status: string; party: "renter" | "owner"; fulfillmentAssignment?: { state: string; teamState: string | null; teamReady?: boolean } | null };
export async function* readSupportOrders(request: <T>(path: string) => Promise<T>, signal: AbortSignal): AsyncGenerator<{ items: SupportOrder[]; complete: boolean }> {
  const items = new Map<string, SupportOrder>();
  for (const party of ["renter", "owner"] as const) {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const page: {items: SupportOrder[]; nextCursor: string | null} = await request('/api/orders/?party=' + party + '&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      signal.throwIfAborted();
      if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('订单目录响应格式无效');
      for (const item of page.items) if (item.fulfillmentAssignment) items.set(item.id,{...item, party, fulfillmentAssignment: {...item.fulfillmentAssignment,teamState:item.fulfillmentAssignment.teamState??(item.fulfillmentAssignment.teamReady?"READY":null)}});
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('订单目录分页未完成，请重试');
      if (cursor) seen.add(cursor);
      yield {items: [...items.values()], complete: party === "owner" && cursor === null};
    } while (cursor);
  }
}
