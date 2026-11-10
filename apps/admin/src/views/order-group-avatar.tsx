/**
 * A stable visual identity for order groups: the last four characters of the
 * order number plus a tone derived from the full number. The row and the chat
 * header render this same mark, so adjacent order numbers stay distinguishable
 * without inventing a group name or avatar.
 */
function orderGroupTail(displayNo: string): string {
  const text = (displayNo || "").trim();
  const digits = /(\d{2,})$/.exec(text)?.[1] ?? (text.replace(/\D/g, "") || text);
  const tail = (digits || text).slice(-4);
  return tail ? tail.padStart(4, "0").toUpperCase() : "?";
}

function orderGroupTone(displayNo: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < displayNo.length; index += 1) hash = Math.imul(hash ^ displayNo.charCodeAt(index), 0x01000193);
  return (hash >>> 0) % 8;
}

export function OrderGroupAvatar({ displayNo, className }: { displayNo: string; className?: string }) {
  return <span className={`im-wb-order-av${className ? ` ${className}` : ""}`} data-kind="order" data-tone={orderGroupTone(displayNo)} aria-hidden="true">{orderGroupTail(displayNo)}</span>;
}
