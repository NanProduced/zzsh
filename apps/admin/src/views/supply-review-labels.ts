export type ReviewItemRef = { id: string; name?: string; unit?: string };

const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件", DAY: "天" };

function unitText(unit: string | undefined): string {
  return unit ? UNIT_LABELS[unit] ?? "未确认" : "未确认";
}

export function reviewItemLabel(input: {
  itemId: string;
  inCurrent: boolean;
  presentation?: ReviewItemRef[];
  catalog?: ReviewItemRef[];
  previousPresentation?: ReviewItemRef[];
}): { name: string; unit: string } {
  const find = (items: ReviewItemRef[] | undefined) => items?.find((item) => item.id === input.itemId);
  if (input.inCurrent) {
    const snapshot = find(input.presentation);
    if (snapshot?.name) return { name: snapshot.name, unit: unitText(snapshot.unit) };
    const catalog = find(input.catalog);
    if (catalog?.name) return { name: catalog.name, unit: unitText(catalog.unit) };
    return { name: `未确认（${input.itemId}）`, unit: "未确认" };
  }
  const previous = find(input.previousPresentation);
  if (previous?.name) return { name: previous.name, unit: unitText(previous.unit) };
  return { name: `未确认（${input.itemId}）`, unit: "未确认" };
}
