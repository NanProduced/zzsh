export type TimelineSource = "HISTORICAL" | "LOCAL_CONTROLLED" | "JOINPAY";
export type TimelineItem = { id: string; at: string; source: TimelineSource };
export type TimelineSlice<T extends TimelineItem> = {
  items: T[]; cursor: string | null; snapshot: string | null; asOf: string | null;
  available: boolean; coverageKnown: boolean;
};
type Stream<T extends TimelineItem> = {
  source: TimelineSource; started: boolean; buffer: T[]; cursor: string | null;
  snapshot: string | null; asOf: string | null; partial: boolean; last: T | null;
};
export type TimelineState<T extends TimelineItem> = { streams: Stream<T>[]; items: T[]; partial: boolean; scanIncomplete: boolean; temporalTies: boolean };
export class WithdrawalTimelineSourceError extends Error {
  readonly source: TimelineSource;
  constructor(source: TimelineSource, code: string) { super(code); this.source = source; }
}

export function emptyWithdrawalTimeline<T extends TimelineItem>(): TimelineState<T> {
  return { streams: (["HISTORICAL", "LOCAL_CONTROLLED", "JOINPAY"] as const).map(source => ({ source, started: false, buffer: [], cursor: null, snapshot: null, asOf: null, partial: false, last: null })), items: [], partial: false, scanIncomplete: false, temporalTies: false };
}

/** Preserve microseconds and timezone offsets rather than rounding different records to one millisecond. */
export function withdrawalTimeMicros(value: string): bigint {
  const match = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(value);
  if (!match) throw new Error("WITHDRAWAL_TIME_INVALID");
  const local = match[1]!.replace(" ", "T"), calendar = Date.parse(local + "Z");
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== local) throw new Error("WITHDRAWAL_TIME_INVALID");
  const zone = /^[+-]\d\d$/.test(match[3]!) ? `${match[3]}:00` : match[3]!;
  const seconds = Date.parse(local + zone);
  if (!Number.isFinite(seconds)) throw new Error("WITHDRAWAL_TIME_INVALID");
  return BigInt(seconds) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
}

function compare<T extends TimelineItem>(a: T, b: T): number {
  // The controlled source exposes milliseconds even when its database cursor has microseconds.
  const at = withdrawalTimeMicros(a.at) / 1000n, bt = withdrawalTimeMicros(b.at) / 1000n;
  return at === bt ? a.id === b.id ? 0 : a.id > b.id ? -1 : 1 : at > bt ? -1 : 1;
}

export function hasMoreWithdrawalTimeline<T extends TimelineItem>(state: TimelineState<T>): boolean {
  return state.streams.some(stream => !stream.started || stream.buffer.length > 0 || stream.cursor !== null);
}

export function removeWithdrawalTimelineSource<T extends TimelineItem>(state: TimelineState<T>, source: TimelineSource): TimelineState<T> {
  return { ...state, items: state.items.filter(item => item.source !== source), partial: true,
    streams: state.streams.map(stream => stream.source === source ? { ...stream, started: true, buffer: [], cursor: null, snapshot: null, asOf: null, partial: true, last: null } : stream) };
}

/** Merge only source pages whose original cursors and snapshots remain valid. */
export async function advanceWithdrawalTimeline<T extends TimelineItem>(
  previous: TimelineState<T>, read: (source: TimelineSource, cursor: string | null) => Promise<TimelineSlice<T>>, limit = 20,
): Promise<TimelineState<T>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("WITHDRAWAL_LIMIT_INVALID");
  const next: TimelineState<T> = { streams: previous.streams.map(stream => ({ ...stream, buffer: [...stream.buffer] })), items: [...previous.items], partial: previous.partial, scanIncomplete: false, temporalTies: previous.temporalTies };
  const seen = new Set(next.items.map(item => item.id));
  for (const stream of next.streams) for (const item of stream.buffer) seen.add(item.id);
  let requests = 0, emitted = 0;
  const fill = async (stream: Stream<T>) => {
    const requestedCursor = stream.started ? stream.cursor : null;
    const page = await read(stream.source, requestedCursor);
    requests++;
    if (!page.available) {
      if (stream.started) throw new WithdrawalTimelineSourceError(stream.source, "WITHDRAWAL_SOURCE_CHANGED");
      stream.started = true; stream.partial = true; stream.cursor = null; return;
    }
    if (stream.started && (page.snapshot !== stream.snapshot || page.asOf !== stream.asOf)) throw new Error("WITHDRAWAL_SNAPSHOT_CHANGED");
    if (page.cursor && (!page.items.length || !page.snapshot || !page.asOf)) throw new Error("WITHDRAWAL_CURSOR_INVALID");
    if (page.items.length > 100) throw new Error("WITHDRAWAL_PAGE_INVALID");
    let last = stream.last;
    for (const item of page.items) {
      if (item.source !== stream.source || seen.has(item.id) || last && withdrawalTimeMicros(last.at) / 1000n < withdrawalTimeMicros(item.at) / 1000n) throw new Error("WITHDRAWAL_PAGE_INVALID");
      withdrawalTimeMicros(item.at); seen.add(item.id); last = item;
    }
    stream.started = true; stream.buffer.push(...page.items); stream.cursor = page.cursor; stream.snapshot = page.snapshot; stream.asOf = page.asOf;
    stream.last = last; stream.partial ||= !page.coverageKnown;
  };
  for (const stream of next.streams) if (!stream.started) await fill(stream);
  while (emitted < limit) {
    for (const stream of next.streams) {
      if (!stream.buffer.length && stream.cursor) {
        if (requests >= 12) { next.scanIncomplete = true; break; }
        await fill(stream);
      }
    }
    if (next.scanIncomplete) break;
    const candidates = next.streams.filter(stream => stream.buffer.length).sort((a, b) => compare(a.buffer[0]!, b.buffer[0]!));
    if (!candidates.length) break;
    const item = candidates[0]!.buffer.shift()!, prior = next.items.at(-1);
    if (prior && withdrawalTimeMicros(prior.at) / 1000n === withdrawalTimeMicros(item.at) / 1000n) next.temporalTies = true;
    next.items.push(item); emitted++;
  }
  next.partial = next.streams.some(stream => stream.partial);
  return next;
}
