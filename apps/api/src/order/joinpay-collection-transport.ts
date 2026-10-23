import { readCollectionOutboundRequest, type CollectionOutboundRequest } from "./joinpay-collection-profile";

export const JOINPAY_COLLECTION_TRANSPORT_LIMITS = Object.freeze({ timeoutMilliseconds: 8000, maximumBodyBytes: 65536 });
export type CollectionExchangeResult = Readonly<{ kind: "RESPONSE"; status: 200; body: Uint8Array; responseComplete: true; receivedBytes: number; requestSha256: string } |
  { kind: "UNKNOWN"; reason: "HTTP_STATUS"; status: number; body: Uint8Array; responseComplete: true; receivedBytes: number; requestSha256: string } |
  { kind: "UNKNOWN"; reason: "TIMEOUT" | "ABORTED" | "BODY_TOO_LARGE" | "NETWORK_ERROR"; responseComplete: false; receivedBytes: number; status?: number; body?: Uint8Array; requestSha256: string }>;
export type CollectionTransportDependencies = { fetch?: typeof globalThis.fetch; signal?: AbortSignal };
/** 只执行一次fetch；所有错误只输出固定类别，响应原件仅交持久层，不在这里解释资金结果。 */
export async function exchangeJoinpayCollection(request: CollectionOutboundRequest, dependencies: CollectionTransportDependencies = {}): Promise<CollectionExchangeResult> {
  const bound = readCollectionOutboundRequest(request);
  // 注入fetch也不能把合成profile变为出站能力；测试正例须在测试层显式构造虚构后端正式配置。
  if (bound.evidenceMode === "SYNTHETIC") {
    throw Object.assign(new Error("COLLECTION_SYNTHETIC_TRANSPORT_FORBIDDEN"), { code: "COLLECTION_SYNTHETIC_TRANSPORT_FORBIDDEN" });
  }
  const controller = new AbortController(), deadline = performance.now() + JOINPAY_COLLECTION_TRANSPORT_LIMITS.timeoutMilliseconds;
  const chunks: Uint8Array[] = []; let receivedBytes = 0, retainedBytes = 0, status: number | undefined, combined: Uint8Array | undefined;
  const collected = () => {
    if (!combined) { combined = new Uint8Array(retainedBytes); let offset = 0; for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; } }
    return combined;
  };
  let timeout = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stopReader = () => { if (reader) void reader.cancel().catch(() => {}); };
  controller.signal.addEventListener("abort", stopReader, { once: true });
  const externalAbort = () => controller.abort();
  if (dependencies.signal?.aborted) controller.abort();
  else dependencies.signal?.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, JOINPAY_COLLECTION_TRANSPORT_LIMITS.timeoutMilliseconds);
  const unknown = (reason: "TIMEOUT" | "ABORTED" | "BODY_TOO_LARGE" | "NETWORK_ERROR"): CollectionExchangeResult =>
    Object.freeze({ kind: "UNKNOWN", reason, responseComplete: false, receivedBytes, ...(status === undefined ? {} : { status }),
      ...(retainedBytes ? { body: collected() } : {}), requestSha256: request.requestSha256 });
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<CollectionExchangeResult>(resolve => {
    abortListener = () => resolve(unknown(timeout ? "TIMEOUT" : "ABORTED"));
    if (controller.signal.aborted) abortListener(); else controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  async function once(): Promise<CollectionExchangeResult> {
    if (controller.signal.aborted) return unknown(timeout ? "TIMEOUT" : "ABORTED");
    try {
      const response = await (dependencies.fetch ?? globalThis.fetch)(bound.endpoint, { method: "POST", body: bound.encodedBody,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json" },
        redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
      status = response.status;
      if (performance.now() >= deadline) { timeout = true; controller.abort(); }
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return unknown(timeout ? "TIMEOUT" : "ABORTED"); }
      const declared = response.headers.get("content-length");
      if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(JOINPAY_COLLECTION_TRANSPORT_LIMITS.maximumBodyBytes)) {
        void response.body?.cancel().catch(() => {}); return unknown("BODY_TOO_LARGE");
      }
      const complete = (body: Uint8Array): CollectionExchangeResult => response.status === 200
        ? Object.freeze({ kind: "RESPONSE", status: 200, body, responseComplete: true, receivedBytes, requestSha256: request.requestSha256 })
        : Object.freeze({ kind: "UNKNOWN", reason: "HTTP_STATUS", status: response.status, body, responseComplete: true, receivedBytes, requestSha256: request.requestSha256 });
      if (!response.body) return complete(new Uint8Array());
      reader = response.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (performance.now() >= deadline) { timeout = true; controller.abort(); }
        if (controller.signal.aborted) return unknown(timeout ? "TIMEOUT" : "ABORTED");
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) { stopReader(); return unknown("NETWORK_ERROR"); }
        receivedBytes += next.value.byteLength;
        const remaining = JOINPAY_COLLECTION_TRANSPORT_LIMITS.maximumBodyBytes - retainedBytes;
        // 逐块只保留预算内前缀；超长块不继续读，也不复制预算外字节。
        const retained = new Uint8Array(next.value.subarray(0, remaining)); if (retained.byteLength) { chunks.push(retained); retainedBytes += retained.byteLength; combined = undefined; }
        if (next.value.byteLength > remaining) { stopReader(); return unknown("BODY_TOO_LARGE"); }
      }
      const body = collected();
      return complete(body);
    } catch { return unknown(controller.signal.aborted ? timeout ? "TIMEOUT" : "ABORTED" : "NETWORK_ERROR"); }
  }
  try { return await Promise.race([once(), aborted]); }
  finally {
    clearTimeout(timer); dependencies.signal?.removeEventListener("abort", externalAbort);
    controller.signal.removeEventListener("abort", stopReader); if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
