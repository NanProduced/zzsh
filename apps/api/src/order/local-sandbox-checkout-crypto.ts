// Only explicit local sandbox assembly creates a signer; a checkout token grants no SDK identity.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "../supply/content-hash";
import { invalid, forbidden, conflict } from "../supply/supply-util";
import { localFinancialSandboxRegistration, type LocalFinancialSandbox } from "../finance/local-financial-sandbox-resource";

export type LocalSandboxCheckoutSigner = Readonly<{ kind: "LOCAL_SANDBOX_CHECKOUT_SIGNER" }>;
export type LocalSandboxCheckoutClaims = Readonly<{
  schema: "local-sandbox-checkout.v1"; sandboxDigest: string; checkoutId: string; userId: string; sessionHash: string;
  orderId: string; displayNo: string; amountCents: string; currency: "CNY"; orderCreatedAt: string;
  issuedAt: string; expiresAt: string;
}>;
const signers = new WeakMap<LocalSandboxCheckoutSigner, { sandbox: LocalFinancialSandbox; key: Buffer }>();
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, hash = /^[a-f0-9]{64}$/;
const keys = ["schema", "sandboxDigest", "checkoutId", "userId", "sessionHash", "orderId", "displayNo", "amountCents", "currency", "orderCreatedAt", "issuedAt", "expiresAt"].sort().join(",");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function createLocalSandboxCheckoutSigner(sandbox: LocalFinancialSandbox, key: Uint8Array): LocalSandboxCheckoutSigner {
  localFinancialSandboxRegistration(sandbox);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw invalid("Stable local checkout signing key required");
  const signer = Object.freeze({ kind: "LOCAL_SANDBOX_CHECKOUT_SIGNER" as const });
  signers.set(signer, { sandbox, key: Buffer.from(key) }); return signer;
}
function proof(signer: LocalSandboxCheckoutSigner) {
  const value = signers.get(signer); if (!value) throw forbidden("Local checkout signer is not verified");
  const registration = localFinancialSandboxRegistration(value.sandbox); return { ...value, registration };
}
export function assertLocalSandboxCheckoutSigner(signer: LocalSandboxCheckoutSigner, sandbox: LocalFinancialSandbox): void {
  if (proof(signer).sandbox !== sandbox) throw invalid("Local checkout signer resource is cross-wired");
}
function claims(value: unknown, digest: string): LocalSandboxCheckoutClaims {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) throw invalid("Exact local checkout binding required");
  const c = value as Record<string, unknown>;
  if (c.schema !== "local-sandbox-checkout.v1" || c.sandboxDigest !== digest || typeof c.sessionHash !== "string" || !hash.test(c.sessionHash)
    || ![c.checkoutId, c.userId, c.orderId, c.displayNo].every(v => typeof v === "string" && id.test(v))
    || c.currency !== "CNY" || typeof c.amountCents !== "string" || !/^(0|[1-9]\d{0,23})$/.test(c.amountCents)
    || !iso(c.orderCreatedAt) || !iso(c.issuedAt) || !iso(c.expiresAt) || c.orderCreatedAt > c.issuedAt
    || Date.parse(c.expiresAt) <= Date.parse(c.issuedAt) || Date.parse(c.expiresAt) - Date.parse(c.issuedAt) > 120000) throw invalid("Invalid local checkout binding");
  return Object.freeze({ ...c }) as LocalSandboxCheckoutClaims;
}
export function signLocalSandboxCheckout(signer: LocalSandboxCheckoutSigner, value: LocalSandboxCheckoutClaims): string {
  const p = proof(signer), body = Buffer.from(canonicalize(claims(value, p.registration.digest))).toString("base64url");
  return body + "." + createHmac("sha256", p.key).update(body).digest("base64url");
}
export function verifyLocalSandboxCheckout(signer: LocalSandboxCheckoutSigner, token: unknown, actor: { userId: string; sessionId: string }, orderId: string, databaseNow: string): LocalSandboxCheckoutClaims {
  const p = proof(signer); if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token) || !iso(databaseNow)) throw invalid("Invalid local checkout token");
  const [body, signature] = token.split(".") as [string, string], actual = Buffer.from(signature, "base64url"), expected = createHmac("sha256", p.key).update(body).digest();
  if (actual.length !== expected.length || actual.toString("base64url") !== signature || !timingSafeEqual(actual, expected)) throw invalid("Local checkout signature differs");
  let parsed: unknown;
  try { const bytes = Buffer.from(body, "base64url"); if (bytes.toString("base64url") !== body) throw Error(); parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid("Local checkout payload is invalid"); }
  const c = claims(parsed, p.registration.digest);
  if (Buffer.from(canonicalize(c)).toString("base64url") !== body) throw invalid("Local checkout is not canonical");
  if (c.userId !== actor.userId || c.sessionHash !== sha(actor.sessionId) || c.orderId !== orderId) throw forbidden("Local checkout belongs to another intent");
  if (databaseNow < c.issuedAt || databaseNow >= c.expiresAt) throw conflict("Local checkout expired; read original payment status");
  return c;
}

export function localSandboxPaymentAnchor(sandbox: LocalFinancialSandbox, orderId: string) {
  if (typeof orderId !== "string" || !id.test(orderId)) throw invalid("Original order identifier required");
  const digest = localFinancialSandboxRegistration(sandbox).digest, anchor = sha(digest + ":" + orderId).slice(0, 40);
  return Object.freeze({ declarationId: "sandbox_decl_" + anchor, providerTransactionId: "sandbox_pay_" + anchor, requestId: "sandbox_payment_" + anchor,
    merchantScopeId: "local_sandbox_" + digest.slice(0, 32) });
}
