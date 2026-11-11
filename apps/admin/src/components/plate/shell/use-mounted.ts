// Source: https://platejs.org/r/use-mounted.json — Plate UI (MIT), platejs v53.5.2 registry.
// Adapted: scoped ../ui primitives, cn from @/lib/utils; no AI/suggestion/comment.
import * as React from 'react';

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

export function useMounted() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
