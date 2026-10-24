import type { PoolClient } from "pg";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES, ensureApiV1RequestId } from "../contracts/api-v1";
import { withPublicListingSnapshot, type PublishingAccount } from "../supply/publishing";
import { forbidden, invalid, notFound, sendJson, type SupplyNodeRequest, type SupplyNodeResponse } from "../supply/supply-util";
import { projectTenantMoney, type TenantPriceQuote } from "../supply/tenant-price-projection";
import { assertReadCreateAuthorization, type OrderUserContext } from "./order";
import { confirmationInput, readPersonalPriceProjection, type PersonalConfirmationOptions } from "./personal-confirmation";

export const RENTAL_PRICE_PREVIEW_PATHS = ["/api/v2/rental-price-preview", "/api/bff/user/rental-price-preview"] as const;
export type RentalPricePreviewInput = Pick<ReturnType<typeof confirmationInput>, "accountId" | "versionId" | "releaseId">;
const references = ["accountId", "versionId", "releaseId"] as const;
const cacheControl = "private, no-store";
const unavailable = (): never => { throw new SecurityApiError(503, "CONFIRMATION_DEPENDENCY_UNAVAILABLE", "Personal price is unavailable"); };

export function rentalPricePreviewInput(params: URLSearchParams): RentalPricePreviewInput {
  for (const key of params.keys()) if (!(references as readonly string[]).includes(key) || params.getAll(key).length !== 1) throw invalid("Unsupported price preview reference", key);
  const body = Object.fromEntries(references.map(key => [key, params.get(key)]));
  return confirmationInput(body);
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return unavailable();
  return value;
}

function termsProjection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const terms = value as Record<string, unknown>;
  const termsDigest = string(terms.termsDigest);
  if (!/^[a-f0-9]{64}$/.test(termsDigest)) return unavailable();
  return { termsVersionId: string(terms.termsVersionId), termsDigest, disclosureVersion: string(terms.disclosureVersion),
    policyRef: string(terms.policyRef), policyVersion: string(terms.policyVersion), title: string(terms.title), body: string(terms.body) };
}

function membershipProjection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const benefits = value as Record<string, unknown>;
  const effectiveTier = string(benefits.effectiveTier), policyTier = string(benefits.policyTier);
  if (benefits.schema !== "membership-benefits-v1" || !["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "BLACK_GOLD"].includes(effectiveTier)
    || policyTier !== (effectiveTier === "BLACK_GOLD" ? "DIAMOND" : effectiveTier)
    || !["GROWTH", "FRIEND", "PRESTIGE"].includes(String(benefits.priceSource)) || !["GROWTH", "FRIEND", "PRESTIGE"].includes(String(benefits.depositSource))) return unavailable();
  return { schema: "membership-benefits-v1" as const, effectiveTier, policyTier, priceSource: string(benefits.priceSource), depositSource: string(benefits.depositSource), policyVersion: string(benefits.policyVersion) };
}

/** Same business snapshot, but no party/game/account locks, consent, snapshot credential or final WRITE recheck. */
export async function readRentalPricePreview(client: PoolClient, context: OrderUserContext, input: RentalPricePreviewInput, options: PersonalConfirmationOptions) {
  // Reuse the existing read-transaction timeout policy; these are local settings, not business writes or row locks.
  await client.query("SELECT set_config('statement_timeout','3000',true),set_config('lock_timeout','500',true)");
  const clock = (await client.query<{ asOfUtc: string; refreshAfterUtc: string }>(
    `SELECT to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOfUtc",
      to_char((t.at+interval '30 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "refreshAfterUtc" FROM (SELECT clock_timestamp() AS at) t`,
  )).rows[0];
  const instant = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
  if (!clock || !instant.test(clock.asOfUtc) || !instant.test(clock.refreshAfterUtc) || !Number.isFinite(Date.parse(clock.asOfUtc))) return unavailable();
  const parties = await assertReadCreateAuthorization(client, context, input.accountId);
  const game = (await client.query<{ current_release_id: string | null; enabled: boolean }>("SELECT current_release_id,enabled FROM zzsh_supply.game WHERE id=$1", [parties.gameId])).rows[0];
  const account = (await client.query<PublishingAccount>("SELECT * FROM zzsh_supply.rental_account WHERE id=$1", [input.accountId])).rows[0];
  if (!account || !game?.enabled || account.owner_user_id !== parties.ownerUserId || account.game_id !== parties.gameId) throw notFound();
  const result = await readPersonalPriceProjection(client, context, input, options, { account, game, asOfUtc: clock.asOfUtc });
  const projection = result.projection;
  const quote: TenantPriceQuote = projection.quote;
  if (quote.tenantDeposit === null || quote.tenantPayableTotal === null || !/^[a-f0-9]{64}$/.test(result.listingHash)) return unavailable();
  const baseTenantDeposit = projectTenantMoney(projection.baseTenantDeposit);
  const membershipBenefits = "membershipBenefits" in projection ? membershipProjection(projection.membershipBenefits) : undefined;
  const customerTier = "customerTier" in projection ? projection.customerTier : undefined;
  if (membershipBenefits === undefined && !["STANDARD", "VIP", "SVIP", "DISCOUNT_USER"].includes(String(customerTier))) {
    throw new SecurityApiError(503, "MEMBERSHIP_UNKNOWN", "Personal membership is unavailable");
  }
  const disclosure = projection.compensationDisclosure;
  if (disclosure && typeof disclosure.selected !== "boolean") return unavailable();
  if (disclosure?.selected && !disclosure.terms) return unavailable();
  return {
    schema: "rental-price-preview.v1" as const,
    binding: { accountId: input.accountId, versionId: input.versionId, releaseId: input.releaseId, listingHash: result.listingHash },
    asOfUtc: clock.asOfUtc, refreshAfterUtc: clock.refreshAfterUtc, quote, baseTenantDeposit,
    ...(membershipBenefits === undefined ? { customerTier } : { membershipBenefits }),
    ...(disclosure === undefined ? {} : { compensationDisclosure: { selected: disclosure.selected, disclosureVersion: string(disclosure.disclosureVersion), ...(disclosure.terms ? { terms: termsProjection(disclosure.terms) } : {}) } }),
  };
}

/** Mounted only by the existing confirmation parent. SDK expiry cleanup remains the existing auth lifecycle. */
export async function handleRentalPricePreview(request: SupplyNodeRequest, response: SupplyNodeResponse, security: AuthSecurityOptions, options: PersonalConfirmationOptions, path: typeof RENTAL_PRICE_PREVIEW_PATHS[number]): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  try {
    const url = new URL(request.originalUrl ?? request.url ?? "", "http://price-preview.invalid");
    if (request.method !== "GET" || url.pathname !== path) throw notFound();
    if (request.headers.authorization || request.headers.origin !== security.userOrigin) throw forbidden();
    const context = await readUserContext(request, security);
    if (request.headers["transfer-encoding"] !== undefined || request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0"
      || request.body !== undefined && request.body !== null && (typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length > 0)) throw invalid("Price preview does not accept a body");
    const input = rentalPricePreviewInput(url.searchParams);
    const result = await withPublicListingSnapshot(security.pool, client => readRentalPricePreview(client, context, input, options));
    sendJson(response, 200, result, requestId, cacheControl);
  } catch (error) {
    const known = error instanceof SecurityApiError ? error : null;
    const status = known?.status ?? 500;
    const message = status >= 500 ? "Personal price is unavailable" : status === 400 ? "Invalid price preview request" : status === 401 ? "Authentication required"
      : status === 403 ? "Price preview is not permitted" : status === 404 ? "Price preview not found" : status === 409 ? "Price preview changed; refresh and try again" : "Personal price read failed";
    sendJson(response, status, { error: { code: known?.code ?? API_V1_ERROR_CODES.INTERNAL_ERROR, message, requestId } }, requestId, cacheControl);
  }
}
