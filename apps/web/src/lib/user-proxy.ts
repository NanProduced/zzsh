const USER_COOKIE =
  /^(?:__Secure-|__Host-)?zzsh_user\.(?:session_token(?:\.\d+)?|dont_remember)$/;

export class BodyTooLargeError extends Error {}
export class BodyReadError extends Error {}

export async function readBoundedBody(
  request: Pick<Request, "body">,
  maxBytes = 64 * 1024,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new BodyReadError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new BodyReadError();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof BodyTooLargeError) throw error;
    throw new BodyReadError();
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function userCookies(value: string | null): string | undefined {
  const cookies = (value ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => USER_COOKIE.test(part.split("=", 1)[0] ?? ""));
  return cookies.length > 0 ? cookies.join("; ") : undefined;
}

export function sanitizeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponse);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(?:token|sessionToken|accessToken|refreshToken)$/i.test(key),
      )
      .map(([key, nested]) => [key, sanitizeResponse(nested)]),
  );
}

export function copySetCookies(source: Headers): string[] {
  const headers = source as Headers & { getSetCookie?: () => string[] };
  const cookie = source.get("set-cookie");
  const values = headers.getSetCookie?.() ?? (cookie ? [cookie] : []);
  return values.filter((value) =>
    USER_COOKIE.test(value.split("=", 1)[0]?.trim() ?? ""),
  );
}

export function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
