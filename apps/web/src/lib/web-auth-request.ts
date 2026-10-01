export class WebAuthError extends Error {
  constructor(readonly status: number, readonly code: string, readonly accepted = false, readonly retryAt?: number) { super(code); }
}
export async function webAuthRequest<T>(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch("/api/auth/user" + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal }); }
  catch { throw new WebAuthError(0, "NETWORK_ERROR"); }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new WebAuthError(response.status, "RESPONSE_UNCONFIRMED", response.ok); }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? (payload as { error?: { code?: string; accepted?: boolean } }).error : undefined;
    const retry = Number(response.headers.get("retry-after"));
    throw new WebAuthError(response.status, error?.code ?? "INTERNAL_ERROR", error?.accepted === true, response.status === 429 && retry > 0 ? Date.now() + retry * 1000 : undefined);
  }
  if (payload === null && path === "/get-session" && body === undefined) return payload as T;
  if (!payload || typeof payload !== "object") throw new WebAuthError(response.status, "RESPONSE_UNCONFIRMED", true);
  return payload as T;
}
export function authErrorMessage(error: unknown, context: "read" | "verify" | "login" = "verify"): string {
  if (!(error instanceof WebAuthError)) return "暂时无法确认，请稍后重新读取。";
  if (error.status === 429) return "操作太频繁，请稍候再试。";
  if (context === "login" && (error.status === 400 || error.status === 401)) return "手机号或密码不正确，请检查后再试。";
  if (error.status === 401) return "登录已失效或验证不正确，请重新确认。";
  if (context === "read" && error.status >= 400 && error.status < 500) return "当前资料无法读取，请重新确认登录身份后刷新。";
  if (error.status === 409) return "联系方式已被使用或归属待核，请核对目标或联系客服；验证状态变化时重新验证。";
  if (error.status === 501) return "验证服务暂时不可用，请稍后再试。";
  if (error.status >= 400 && error.status < 500) return "请检查输入；验证码可能不正确或已过期。";
  return "结果暂时无法确认，请先重新读取状态。";
}
