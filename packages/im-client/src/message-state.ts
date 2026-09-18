export type ImMessageStateItem = {
  id: string;
  createTime?: number;
};

/** Merge history and live delivery without letting an older response erase newer messages. */
export function mergeImMessages<T extends ImMessageStateItem>(current: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    const time = (left.createTime ?? 0) - (right.createTime ?? 0);
    return time || left.id.localeCompare(right.id);
  });
}
