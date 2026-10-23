import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, type EffectiveAdminAccess } from "./admin-authorization";
import { assertSealedRuleRelease } from "./membership-growth-approval";
import { centsOfAmount, payableCentsFor } from "./membership-total-discount";
import { parseDepositAllowanceCents } from "./membership-growth";
import { SecurityApiError } from "./security-core";
import { quotePreview } from "../supply/rules";
import { assertGameScope, ensureOnlyFields } from "../supply/supply-util";
import type { ProjectedQuote } from "../supply/pricing";

type Viewer = { adminId: string; access: EffectiveAdminAccess };
const invalid = (message: string) => new SecurityApiError(400, "INVALID_ARGUMENT", message);
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Profit simulation basis is unavailable");

export function canSimulateMembershipProfit(access: EffectiveAdminAccess | null): boolean {
  return access?.status === "ACTIVE" && (access.isBoss || hasPermission(access, ADMIN_PERMISSION.supplyQuoteInternalRead)
    && (hasPermission(access, ADMIN_PERMISSION.membershipPolicyDraft) || hasPermission(access, ADMIN_PERMISSION.membershipPolicyPublish)));
}

function ratiosOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw invalid("Provide between 1 and 32 discount ratios");
  for (const ratio of value) if (typeof ratio !== "string" || ratio.length > 16 || payableCentsFor(100n, ratio) === null) throw invalid("Discount ratios must be exact decimal strings in (0,1]");
  return value;
}

/** Economic spread, not a new order quote: fees/commissions and deposit movements are deliberately separate. */
export function simulateMembershipProfit(quote: ProjectedQuote, payableRatios: unknown) {
  const ratios = ratiosOf(payableRatios);
  if (!quote.ownerTotal || !quote.pricingInputs || !Array.isArray(quote.pricingInputs.exactRatios)) throw unavailable();
  const rental = centsOfAmount(quote.resourceTotal.amount), owner = centsOfAmount(quote.ownerTotal.amount);
  const haffIds = new Set(quote.pricingInputs.exactRatios.map(ratio => ratio.itemId));
  let haff = 0n, material = 0n, lineOwner = 0n;
  for (const line of quote.lines) {
    if (!line.ownerAmount) throw unavailable();
    const amount = centsOfAmount(line.buyerAmount.amount);
    if (haffIds.has(line.itemId)) haff += amount; else material += amount;
    lineOwner += centsOfAmount(line.ownerAmount.amount);
  }
  if (haff + material !== rental || lineOwner !== owner) throw unavailable();
  return {
    schema: "membership-profit-simulation.v1", calculation: "RENTAL_SPREAD_BEFORE_FEES", estimateOnly: true,
    excluded: ["DEPOSIT", "PUBLISHER_BAIL", "PAYMENT_FEES", "DISTRIBUTION_COMMISSION", "OPERATING_EXPENSES"],
    baseline: { rentalCents: rental.toString(), haffRentalCents: haff.toString(), materialFeesCents: material.toString(), ownerIncomeCents: owner.toString(), platformSpreadCents: (rental - owner).toString(), depositCents: quote.tenantDeposit == null ? null : centsOfAmount(quote.tenantDeposit.amount).toString(), termSeconds: quote.termSeconds },
    breakEven: rental === 0n ? null : { numerator: owner.toString(), denominator: rental.toString() },
    points: ratios.map(payableRatio => {
      const payable = payableCentsFor(rental, payableRatio)!;
      return { payableRatio, payableRentalCents: payable.toString(), discountCents: (rental - payable).toString(), ownerIncomeCents: owner.toString(), platformSpreadCents: (payable - owner).toString(), ownerFloorSatisfied: payable >= owner, spreadRate: payable === 0n ? null : { numerator: (payable - owner).toString(), denominator: payable.toString() } };
    }),
  };
}

async function simulationBasis(client: PoolClient, viewer: Viewer, ruleReleaseId: string, priceVersionId: string) {
  if (!canSimulateMembershipProfit(viewer.access)) throw new SecurityApiError(403, "FORBIDDEN", "Membership policy and internal quote read permissions are required");
  if (![ruleReleaseId, priceVersionId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))) throw invalid("Invalid simulation price binding");
  const sealed = await assertSealedRuleRelease(client, ruleReleaseId, priceVersionId);
  if (!sealed.gameId || !sealed.termVersionId || !sealed.catalog.resources) throw unavailable();
  await assertGameScope(client, viewer.adminId, viewer.access.isBoss, sealed.gameId);
  return sealed;
}

export async function readMembershipProfitSimulationContext(client: PoolClient, viewer: Viewer, ruleReleaseId: string, priceVersionId: string) {
  const sealed = await simulationBasis(client, viewer, ruleReleaseId, priceVersionId);
  const termOptions = (await client.query<{ code: string; dailyConsumption: string }>(`SELECT code,daily_consumption::text AS "dailyConsumption" FROM zzsh_supply.term_option WHERE version_id=$1 ORDER BY code`, [sealed.termVersionId])).rows;
  return { schema: "membership-profit-simulation-context.v1", gameId: sealed.gameId, ruleReleaseId, priceVersionId, termVersionId: sealed.termVersionId, enabledModes: sealed.enabledModes, safeBoxes: sealed.catalog.safeBoxes, resources: sealed.catalog.resources, termOptions };
}

export async function readMembershipProfitSimulation(client: PoolClient, viewer: Viewer, body: Record<string, unknown>) {
  ensureOnlyFields(body, ["ruleReleaseId", "quoteInput", "payableRatios"]);
  const ratios = ratiosOf(body.payableRatios);
  if (!body.quoteInput || typeof body.quoteInput !== "object" || Array.isArray(body.quoteInput)) throw invalid("A simulation scenario is required");
  const quoteInput = body.quoteInput as Record<string, unknown>;
  ensureOnlyFields(quoteInput, ["priceVersionId", "termVersionId", "conditions", "inventory", "deposits"]);
  const ruleReleaseId = typeof body.ruleReleaseId === "string" ? body.ruleReleaseId : "";
  const priceVersionId = typeof quoteInput.priceVersionId === "string" ? quoteInput.priceVersionId : "";
  const sealed = await simulationBasis(client, viewer, ruleReleaseId, priceVersionId);
  if (quoteInput.termVersionId !== sealed.termVersionId) throw invalid("Scenario terms must belong to the bound sealed release");
  if (!Array.isArray(quoteInput.inventory) || quoteInput.inventory.length < 1 || quoteInput.inventory.length > 50) throw invalid("Scenario inventory must contain 1 to 50 resources");
  const resourceIds = new Set(sealed.catalog.resources!.map(item => item.itemId));
  if (quoteInput.inventory.some(item => !item || typeof item !== "object" || !resourceIds.has((item as Record<string, unknown>).itemId as string))) throw invalid("Scenario resource is outside the sealed price catalog");
  if (quoteInput.deposits !== undefined) {
    if (!quoteInput.deposits || typeof quoteInput.deposits !== "object" || Array.isArray(quoteInput.deposits)) throw invalid("Scenario deposit is invalid");
    const deposits = quoteInput.deposits as Record<string, unknown>;
    ensureOnlyFields(deposits, ["tenantDepositCents"]);
    try { parseDepositAllowanceCents(deposits.tenantDepositCents); } catch { throw invalid("Scenario deposit must be integer cents"); }
  }
  // One existing quote read per scenario; every chart point below is pure integer arithmetic, not another SQL call.
  const preview = await quotePreview(client, viewer.adminId, viewer.access.isBoss, quoteInput);
  if (!preview.quotable) return { schema: "membership-profit-simulation.v1", baseQuotable: false, reasonCodes: preview.reasonCodes, points: [] };
  return { ...simulateMembershipProfit(preview.quote as ProjectedQuote, ratios), baseQuotable: true, basis: { gameId: sealed.gameId, ruleReleaseId, priceVersionId, termVersionId: sealed.termVersionId } };
}
