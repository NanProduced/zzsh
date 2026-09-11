export function applyDirtyMap(
  current: Record<string, boolean>,
  tabId: string,
  dirty: boolean,
): Record<string, boolean> {
  const wasDirty = current[tabId] === true;
  if (dirty) {
    if (wasDirty) return current;
    return { ...current, [tabId]: true };
  }
  if (!wasDirty) return current;
  const next = { ...current };
  delete next[tabId];
  return next;
}

export function clearDirtyForTabs(
  current: Record<string, boolean>,
  tabIds: readonly string[],
): Record<string, boolean> {
  let changed = false;
  const next = { ...current };
  for (const tabId of tabIds) {
    if (next[tabId] === true) {
      delete next[tabId];
      changed = true;
    }
  }
  return changed ? next : current;
}

export function dirtyTitles(
  tabs: readonly { id: string; title: string }[],
  dirtyIds: Record<string, boolean>,
): string[] {
  return tabs.filter((tab) => dirtyIds[tab.id]).map((tab) => tab.title);
}

export function confirmDiscard(titles: string[]): boolean {
  if (titles.length === 0) return true;
  const names = titles.join("、");
  return window.confirm(`离开后将丢弃未保存的更改：${names}。确定丢弃并继续？`);
}
