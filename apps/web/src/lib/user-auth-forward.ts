import {
  parseUserClientIpConfig,
  resolveBffClientIp,
  USER_CLIENT_IP_FORWARD_HEADER,
} from "../../../../apps/api/src/auth/user-client-ip.ts";

export { USER_CLIENT_IP_FORWARD_HEADER };

const LOCAL_ONLY = process.env.NODE_ENV !== "production";

/** 与 API USER_ALLOWED_PATHS 对齐。原生发码和重置路径保持关闭。 */
export const USER_AUTH_PATHS = new Set([
  "/get-session",
  "/sign-in/identifier",
  "/sign-in/phone-number",
  "/sign-out",
  "/phone-registration/send-otp",
  "/phone-registration/complete",
  "/security/overview", "/profile/nickname", "/security/challenge/send", "/security/challenge/verify",
  "/security/password", "/security/email", "/security/phone", "/security/recovery/complete", "/security/operation",
  "/security/sessions", "/security/sessions/revoke", "/security/sessions/revoke-others", "/security/sessions/revoke-all",
  "/security/captcha/challenge",
  "/identity/status",
  "/identity/verify",
  "/trade-eligibility/check",
  "/account/deactivate",
  "/account/cancel",
]);

export const USER_AUTH_READ_PATHS = ["/get-session", "/identity/status", "/security/overview", "/security/sessions", "/security/captcha/challenge"];

export function buildUserAuthUpstreamHeaders(request: Request, input: { requestId: string; webOrigin: string; apiOrigin?: string; env?: NodeJS.ProcessEnv }): Headers {
  const env = input.env ?? process.env;
  const headers = new Headers({ Origin: input.webOrigin, "X-Request-Id": input.requestId });
  const userAgent = request.headers.get("user-agent");
  if (userAgent) {
    const sanitized = userAgent.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512);
    if (sanitized) headers.set("User-Agent", sanitized);
  }
  const config = parseUserClientIpConfig(env);
  const peer = (request as Request & { socket?: { remoteAddress?: string } }).socket?.remoteAddress;
  const clientIp = resolveBffClientIp(request.headers, config, peer, env.USER_EDGE_ASSURED === "true");
  if (clientIp) headers.set(USER_CLIENT_IP_FORWARD_HEADER, clientIp);
  return headers;
}

export function userAuthApiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZZSH_API_ORIGIN ?? (env.NODE_ENV !== "production" || LOCAL_ONLY ? "http://127.0.0.1:3102" : "");
}
