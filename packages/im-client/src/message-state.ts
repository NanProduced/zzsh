export type ImMessageStateItem = {
  id: string;
  createTime?: number;
};

/** Object fields where a later record must not erase values it does not carry
 *  (a sender echo may omit the uploaded URL while history carries it). */
const MERGED_OBJECT_FIELDS = ["attachment", "image"] as const;

function mergeRecord<T extends ImMessageStateItem>(existing: T, message: T): T {
  let merged: T | undefined;
  for (const key of MERGED_OBJECT_FIELDS) {
    const existingValue = (existing as Record<string, unknown>)[key];
    const incomingValue = (message as Record<string, unknown>)[key];
    const existingObject = existingValue && typeof existingValue === "object" && !Array.isArray(existingValue) ? existingValue as Record<string, unknown> : undefined;
    if (!existingObject) continue;
    if (!incomingValue || typeof incomingValue !== "object" || Array.isArray(incomingValue)) {
      merged ??= { ...message };
      (merged as Record<string, unknown>)[key] = existingObject;
      continue;
    }
    const incomingObject = incomingValue as Record<string, unknown>;
    const union: Record<string, unknown> = { ...existingObject };
    for (const [field, value] of Object.entries(incomingObject)) {
      if (value !== undefined) union[field] = value;
    }
    merged ??= { ...message };
    (merged as Record<string, unknown>)[key] = union;
  }
  return merged ?? message;
}

/** Merge history and live delivery without letting an older response erase newer messages. */
export function mergeImMessages<T extends ImMessageStateItem>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing ? mergeRecord(existing, message) : message);
  }
  return [...byId.values()].sort((left, right) => {
    const time = (left.createTime ?? 0) - (right.createTime ?? 0);
    return time || left.id.localeCompare(right.id);
  });
}
