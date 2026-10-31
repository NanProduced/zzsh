import { webAuthRequest, WebAuthError, type AuthChallenge } from "./web-auth-request.ts";

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** 本地 PBKDF2 证明，不依赖 DOM 组件。多端提交同一个 captcha 字符串。 */
export async function solveLocalPow(challenge: AuthChallenge, signal?: AbortSignal, stillCurrent?: () => boolean): Promise<string> {
  const { nonce, salt, cost, keyPrefix } = challenge.parameters;
  const keyLength = challenge.parameters.keyLength ?? 32;
  const prefix = keyPrefix.toLowerCase();
  const nonceBytes = hexToBytes(nonce);
  const saltBytes = hexToBytes(salt);
  for (let counter = 0; counter < 1_048_576; counter += 1) {
    if (signal?.aborted || stillCurrent?.() === false) throw new DOMException("Proof calculation cancelled", "AbortError");
    const password = new Uint8Array(nonceBytes.length + 4);
    password.set(nonceBytes, 0);
    new DataView(password.buffer).setUint32(nonceBytes.length, counter, false);
    const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: cost }, key, keyLength * 8));
    const hex = bytesToHex(bits);
    if (hex.startsWith(prefix)) {
      const json = JSON.stringify({ challenge, solution: { counter, derivedKey: hex } });
      return btoa(json);
    }
  }
  throw new WebAuthError(403, "FORBIDDEN", false, undefined, "CAPTCHA_REQUIRED", challenge);
}

export async function webAuthWithCaptcha<T>(path: string, body: Record<string, unknown>, signal: AbortSignal | undefined, stillCurrent: () => boolean): Promise<T> {
  try {
    return await webAuthRequest<T>(path, body, signal);
  } catch (error) {
    if (!(error instanceof WebAuthError) || error.status !== 403 || error.reason !== "CAPTCHA_REQUIRED" || !error.challenge || !stillCurrent()) throw error;
    const captcha = await solveLocalPow(error.challenge, signal, stillCurrent);
    if (!stillCurrent()) throw error;
    return webAuthRequest<T>(path, { ...body, captcha }, signal);
  }
}
