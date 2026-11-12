import type { PoolClient } from "pg";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { lockFixedFeePolicyChange, validateFixedFeeTimeline, type FixedFeeTimelineInput } from "../auth/fixed-fee-policy-timeline";
import { sealedEnabledRentalModes, type GrowthBenefitPolicy, type RentalMode } from "../auth/membership-growth";
import { computeContentHash, normalizeQuote, normalizeTime, type ContentPayloadInput } from "./content-hash";
import { fixedFeeRateForMode, parseFixedFeeRates } from "./fixed-fee";
import { effectivePublicationStateSql } from "./listing-query";
import { assertPriceVersionResources } from "./rules";
import { conflict, invalid, newSupplyId, notFound } from "./supply-util";

type PriceVersion = { id: string; mode: string; status: string; haffRule: unknown; rates: unknown };
type FeeRow = { effectiveAt: string; generation: string; haffRule: unknown; rates: unknown };
type BenefitRow = { effectiveAt: string; version: string; policy: GrowthBenefitPolicy };
type EntitlementRow = { id?: string; startsAt: string; endsAt: string; pricing: unknown };
const modeNames: readonly RentalMode[] = ["ordinary", "custom", "fast"];
const instantSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
type PricingModel = "SPREAD" | "FIXED_FEE";

/** Resolve the default for a new listing at one server-supplied instant. */
export async function readEffectivePricingMode(client: PoolClient, gameId: string, asOf: string) {
  if (typeof gameId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId)) throw invalid("Pricing policy reference is invalid");
  let at: string;
  try { at=normalizeTime(asOf)??""; } catch { throw invalid("Pricing policy time is invalid"); }
  if(!at)throw invalid("Pricing policy time is invalid");
  const row=(await client.query<{id:string;generation:string;effectiveAt:string;pricingModel:PricingModel;priceScheduleId:string|null;priceVersionId:string|null;
    priceMode:string|null;priceStatus:string|null;rates:unknown;haffRule:unknown}>(`SELECT m.id,m.generation::text AS generation,${instantSql("m.effective_at")} AS "effectiveAt",
      m.pricing_model AS "pricingModel",s.id AS "priceScheduleId",s.price_version_id AS "priceVersionId",
      p.mode AS "priceMode",p.status AS "priceStatus",p.fixed_fee_rates AS rates,p.haff_rule AS "haffRule"
      FROM zzsh_supply.pricing_mode_schedule m
      LEFT JOIN LATERAL (SELECT id,price_version_id FROM zzsh_supply.pricing_policy_schedule
        WHERE game_id=m.game_id AND pricing_model=m.pricing_model AND effective_at<=$2::timestamptz
        ORDER BY effective_at DESC,generation DESC LIMIT 1) s ON true
      LEFT JOIN zzsh_supply.price_version p ON p.id=s.price_version_id AND p.game_id=m.game_id
      WHERE m.game_id=$1 AND m.effective_at<=$2::timestamptz ORDER BY m.effective_at DESC,m.generation DESC LIMIT 1`,[gameId,at])).rows[0];
  if(!row)return null;
  if(!["SPREAD","FIXED_FEE"].includes(row.pricingModel)||!row.priceScheduleId||!row.priceVersionId||row.priceStatus!=="SEALED"
    ||(row.pricingModel==="SPREAD"&&(row.priceMode!=="SPREAD"||row.rates!==null))
    ||(row.pricingModel==="FIXED_FEE"&&(row.priceMode!=="PERCENT"||(row.haffRule as {schema?:unknown}|null)?.schema!=="haff-ratio-v3"||!sealedEnabledRentalModes(row.haffRule))))
    throw conflict("生效中的抽成模式或价格政策无法核实");
  if(row.pricingModel==="FIXED_FEE")try{parseFixedFeeRates(row.rates);}catch{throw conflict("生效中的固定手续费率无法核实");}
  return {id:row.id,generation:row.generation,effectiveAt:row.effectiveAt,pricingModel:row.pricingModel,
    priceScheduleId:row.priceScheduleId,priceVersionId:row.priceVersionId};
}

/** Existing owner-published accounts keep their accepted model when the default changes. */
export async function readListingPricingModel(client:PoolClient,input:{accountId:string;ownerUserId:string;gameId:string;asOf?:string}):Promise<{model:PricingModel|"LEGACY_SPREAD"|"LEGACY_PERCENT";asOf:string}|null> {
  if(!input||![input.accountId,input.ownerUserId,input.gameId].every(value=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)))throw invalid("Listing pricing reference is invalid");
  const tables=(await client.query<{modes:boolean;prices:boolean;asOf:string}>(`SELECT to_regclass('zzsh_supply.pricing_mode_schedule') IS NOT NULL AS modes,
    to_regclass('zzsh_supply.pricing_policy_schedule') IS NOT NULL AS prices,${instantSql("clock_timestamp()")} AS "asOf"`)).rows[0];
  if(!tables||typeof tables.modes!=="boolean"||typeof tables.prices!=="boolean")throw conflict("抽成模式配置暂不可用");
  if(!tables.modes&&!tables.prices)return null;
  if(!tables.modes||!tables.prices)throw conflict("抽成模式配置不完整");
  let asOf:string;
  try{asOf=normalizeTime(input.asOf??tables.asOf)??"";}catch{throw conflict("抽成模式生效时间无法核实");}
  if(!asOf)throw conflict("抽成模式生效时间无法核实");
  const previous=(await client.query<{schemaVersion:number;contentHash:string;payload:ContentPayloadInput|null}>(`SELECT v.schema_version AS "schemaVersion",v.content_hash AS "contentHash",v.payload
    FROM zzsh_supply.listing_publication p JOIN zzsh_supply.listing_version v ON v.id=p.version_id AND v.account_id=p.account_id
      AND v.content_hash=p.content_hash AND v.origin='NATIVE'
    WHERE p.account_id=$1 AND p.owner_user_id=$2 AND p.game_id=$3 AND p.source='OWNER_DIRECT'
    ORDER BY p.published_at DESC,p.id DESC LIMIT 1`,[input.accountId,input.ownerUserId,input.gameId])).rows[0];
  if(previous){
    try{
      const payload=previous.payload;
      if(!payload||payload.accountId!==input.accountId||payload.gameId!==input.gameId||payload.schemaVersion!==previous.schemaVersion
        ||computeContentHash(payload)!==previous.contentHash)throw new Error("listing proof mismatch");
      const quote=normalizeQuote(payload.quoteValues);
      if(previous.schemaVersion===4&&quote.schemaVersion===4&&quote.mode==="PERCENT"&&payload.pricingPolicy?.pricingModel==="FIXED_FEE")return {model:"FIXED_FEE",asOf};
      if(previous.schemaVersion===2&&quote.mode==="SPREAD")return {model:"SPREAD",asOf};
      if(previous.schemaVersion===1&&quote.schemaVersion===1&&quote.mode==="SPREAD")return {model:"LEGACY_SPREAD",asOf};
      if(previous.schemaVersion===1&&quote.schemaVersion===1&&quote.mode==="PERCENT")return {model:"LEGACY_PERCENT",asOf};
    }catch{throw conflict("已上架账号的抽成模式无法核实");}
    throw conflict("已上架账号的抽成模式无法核实");
  }
  const current=await readEffectivePricingMode(client,input.gameId,asOf);
  if(!current)throw conflict("当前尚未配置新账号抽成模式");
  return {model:current.pricingModel,asOf};
}

export async function readEffectiveSpreadPrice(client:PoolClient,gameId:string,asOf:string) {
  let at:string;
  try{at=normalizeTime(asOf)??"";}catch{throw invalid("Pricing policy time is invalid");}
  if(!at||typeof gameId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId))throw invalid("Pricing policy reference is invalid");
  const row=(await client.query<{id:string;generation:string;effectiveAt:string;priceVersionId:string;mode:string|null;status:string|null;rates:unknown}>(
    `SELECT s.id,s.generation::text AS generation,${instantSql("s.effective_at")} AS "effectiveAt",s.price_version_id AS "priceVersionId",
      p.mode,p.status,p.fixed_fee_rates AS rates FROM zzsh_supply.pricing_policy_schedule s
      LEFT JOIN zzsh_supply.price_version p ON p.id=s.price_version_id AND p.game_id=s.game_id
      WHERE s.game_id=$1 AND s.pricing_model='SPREAD' AND s.effective_at<=$2::timestamptz
      ORDER BY s.effective_at DESC,s.generation DESC LIMIT 1`,[gameId,at])).rows[0];
  if(!row)return null;
  if(row.mode!=="SPREAD"||row.status!=="SEALED"||row.rates!==null)throw conflict("生效中的价差政策无法核实");
  return {scheduleId:row.id,generation:row.generation,effectiveAt:row.effectiveAt,priceVersionId:row.priceVersionId};
}

/** asOf comes from the server transaction; absence or an invalid price version is never a zero-fee fallback. */
export async function readEffectiveFixedFeePrice(client: PoolClient, gameId: string, rentalMode: RentalMode, asOf: string) {
  if (typeof gameId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(gameId) || !modeNames.includes(rentalMode)) throw invalid("Pricing policy reference is invalid");
  let at: string;
  try { at = normalizeTime(asOf) ?? ""; } catch { throw invalid("Pricing policy time is invalid"); }
  if (!at) throw invalid("Pricing policy time is invalid");
  const row = (await client.query<{ id: string; generation: string; effectiveAt: string; priceVersionId: string;
    mode: string | null; status: string | null; roundingPolicy: string | null; haffRule: unknown; rates: unknown }>(
    `SELECT s.id,s.generation::text AS generation,${instantSql("s.effective_at")} AS "effectiveAt",s.price_version_id AS "priceVersionId",
      p.mode,p.status,p.rounding_policy AS "roundingPolicy",p.haff_rule AS "haffRule",p.fixed_fee_rates AS rates
      FROM zzsh_supply.pricing_policy_schedule s LEFT JOIN zzsh_supply.price_version p ON p.id=s.price_version_id AND p.game_id=s.game_id
      WHERE s.game_id=$1 AND s.pricing_model='FIXED_FEE' AND s.effective_at<=$2::timestamptz
      ORDER BY s.effective_at DESC,s.generation DESC LIMIT 1`, [gameId, at],
  )).rows[0];
  if (!row) return null;
  const modes = sealedEnabledRentalModes(row.haffRule);
  if (row.mode !== "PERCENT" || row.status !== "SEALED" || row.roundingPolicy !== "HALF_UP_CENT_V1"
    || !modes || (row.haffRule as { schema?: unknown })?.schema !== "haff-ratio-v3") throw conflict("生效中的固定手续费政策无法核实");
  let rates: ReturnType<typeof parseFixedFeeRates>;
  try { rates = parseFixedFeeRates(row.rates); } catch { throw conflict("生效中的固定手续费率无法核实"); }
  return { scheduleId: row.id, generation: row.generation, effectiveAt: row.effectiveAt, priceVersionId: row.priceVersionId,
    commissionRate: fixedFeeRateForMode(rates, rentalMode), haffRule: row.haffRule, roundingPolicy: row.roundingPolicy };
}

/** The caller holds the shared policy lock throughout this read and its eventual write. */
export async function readFixedFeeTimeline(client: PoolClient, gameId: string, options: {
  from: string; fee?: FeeRow; benefit?: BenefitRow; entitlement?: EntitlementRow; excludeEntitlementId?: string;
}): Promise<FixedFeeTimelineInput | null> {
  const feeRows = (await client.query<FeeRow>(`SELECT ${instantSql("s.effective_at")} AS "effectiveAt",s.generation::text AS generation,
    p.haff_rule AS "haffRule",p.fixed_fee_rates AS rates FROM zzsh_supply.pricing_policy_schedule s
    LEFT JOIN zzsh_supply.price_version p ON p.id=s.price_version_id AND p.game_id=s.game_id AND p.status='SEALED'
    WHERE s.game_id=$1 AND s.pricing_model='FIXED_FEE'`, [gameId])).rows;
  if (options.fee) feeRows.push(options.fee);
  if (feeRows.length === 0) return null;
  const existingModes = (await client.query<{ mode: string | null }>(`SELECT DISTINCT v.payload#>>'{quoteValues,pricingInputs,compatibility,rentalMode}' AS mode
    FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id
    JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id AND pub.content_hash=v.content_hash
    WHERE a.game_id=$1 AND a.lifecycle='ACTIVE' AND v.schema_version=4 AND ${effectivePublicationStateSql("v", "pub")}`, [gameId])).rows;
  if (existingModes.some(row => !modeNames.includes(row.mode as RentalMode))) throw conflict("已上架账号的出租方式无法核实");
  const fees: FixedFeeTimelineInput["fees"][number][] = feeRows.map(row => {
    const modes = sealedEnabledRentalModes(row.haffRule);
    if (!modes || (row.haffRule as { schema?: unknown })?.schema !== "haff-ratio-v3") throw conflict("固定手续费出租规则无法核实");
    let rates: ReturnType<typeof parseFixedFeeRates>;
    try { rates = parseFixedFeeRates(row.rates); } catch { throw conflict("固定手续费率无法核实"); }
    return { effectiveAt: row.effectiveAt, generation: row.generation, rates, protectedModes: [...new Set([...modes, ...existingModes.map(entry => entry.mode as RentalMode)])] };
  });
  let from: string;
  try {
    const requested = normalizeTime(options.from);
    const earliest = fees.map(row => normalizeTime(row.effectiveAt)).sort()[0];
    if (!requested || !earliest) throw new Error("missing effective time");
    from = requested > earliest ? requested : earliest;
  } catch { throw conflict("固定手续费政策生效时间无法核实"); }
  // The current growth reader selects the latest approved effective version globally.
  const benefits = (await client.query<BenefitRow>(`SELECT ${instantSql("effective_at")} AS "effectiveAt",version::text AS version,policy_payload AS policy
    FROM zzsh_iam.membership_growth_policy WHERE status='APPROVED' AND effective_at IS NOT NULL`)).rows;
  if (options.benefit) benefits.push(options.benefit);
  const entitlements = (await client.query<EntitlementRow>(`SELECT id,${instantSql("starts_at")} AS "startsAt",${instantSql("ends_at")} AS "endsAt",pricing_payload AS pricing
    FROM zzsh_iam.membership_entitlement WHERE game_id=$1 AND status IN ('ACTIVE','EXECUTED_PENDING_START') AND ends_at>$2::timestamptz
      AND ($3::text IS NULL OR id<>$3)`, [gameId, from, options.excludeEntitlementId ?? null])).rows;
  if (options.entitlement) entitlements.push(options.entitlement);
  return { from, fees, benefits, entitlements };
}

/** Call with the shared policy lock held; membership policies currently apply across games. */
export async function assertFixedFeeMembershipChange(client: PoolClient, input: {
  from: string; gameId?: string; benefit?: BenefitRow; entitlement?: EntitlementRow; excludeEntitlementId?: string;
}): Promise<void> {
  const now = (await client.query<{ at: string }>(`SELECT ${instantSql("clock_timestamp()")} AS at`)).rows[0]?.at;
  let requested: string;
  try { requested = normalizeTime(input.from) ?? ""; } catch { throw conflict("会员政策生效时间无法核实"); }
  if (!now || !requested) throw conflict("会员政策生效时间无法核实");
  const from = requested > now ? requested : now;
  const games = input.gameId ? [{ gameId: input.gameId }] : (await client.query<{ gameId: string }>(
    `SELECT DISTINCT game_id AS "gameId" FROM zzsh_supply.pricing_policy_schedule WHERE pricing_model='FIXED_FEE' ORDER BY game_id`,
  )).rows;
  for (const { gameId } of games) {
    const timeline = await readFixedFeeTimeline(client, gameId, { from, benefit: input.benefit, entitlement: input.entitlement, excludeEntitlementId: input.excludeEntitlementId });
    if (!timeline) continue;
    const validation = validateFixedFeeTimeline(timeline);
    if (!validation.valid) throw conflict(`会员或礼遇与固定手续费政策不兼容：${validation.reason}`);
  }
}

/** The first-deployment owner supplies a sealed price; this never replaces an existing policy. */
export async function initializeFixedFeePricing(client:PoolClient,input:{gameId:string;priceVersionId:string;effectiveAt:string;requestId:string}) {
  const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if(!input||Object.keys(input).some(key=>!["gameId","priceVersionId","effectiveAt","requestId"].includes(key))
    ||![input.gameId,input.priceVersionId,input.requestId].every(value=>typeof value==="string"&&id.test(value)))throw invalid("Initial pricing reference is invalid");
  let effectiveAt:string;
  try{effectiveAt=normalizeTime(input.effectiveAt)??"";}catch{throw invalid("Initial pricing effective time is invalid");}
  if(!effectiveAt)throw invalid("Initial pricing effective time is invalid");
  const owner=(await client.query<{owner:boolean}>(`SELECT count(*)=2 AND COALESCE(bool_and(c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)),false) AS owner
    FROM pg_class c WHERE c.oid IN (to_regclass('zzsh_supply.pricing_policy_schedule'),to_regclass('zzsh_supply.pricing_mode_schedule'))`)).rows[0];
  if(owner?.owner!==true)throw new SecurityApiError(403,"FORBIDDEN","Initial pricing requires the schedule owner");
  await lockFixedFeePolicyChange(client);
  const game=(await client.query<{code:string;enabled:boolean;releaseId:string|null;now:string}>(`SELECT code,enabled,current_release_id AS "releaseId",
    ${instantSql("clock_timestamp()")} AS now FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`,[input.gameId])).rows[0];
  if(!game||game.code!=="delta")throw notFound();
  if(!game.enabled||!game.releaseId)throw conflict("首次价格初始化需要已准备的游戏规则");
  if(effectiveAt>game.now)throw invalid("首次价格生效时间不能晚于当前时间");
  const prices=(await client.query<{id:string;pricingModel:string;priceVersionId:string;generation:string;effectiveAt:string;source:string}>(
    `SELECT id,pricing_model AS "pricingModel",price_version_id AS "priceVersionId",generation::text AS generation,${instantSql("effective_at")} AS "effectiveAt",source
     FROM zzsh_supply.pricing_policy_schedule WHERE game_id=$1 ORDER BY generation`,[input.gameId])).rows;
  const modes=(await client.query<{id:string;pricingModel:string;generation:string;effectiveAt:string;source:string}>(
    `SELECT id,pricing_model AS "pricingModel",generation::text AS generation,${instantSql("effective_at")} AS "effectiveAt",source
     FROM zzsh_supply.pricing_mode_schedule WHERE game_id=$1 ORDER BY generation`,[input.gameId])).rows;
  if(prices.length||modes.length){
    const price=prices.find(row=>row.pricingModel==="FIXED_FEE"&&row.generation==="1"),mode=modes.find(row=>row.generation==="1");
    if(price?.source==="SYSTEM_INITIAL"&&price.priceVersionId===input.priceVersionId&&price.effectiveAt===effectiveAt
      &&mode?.source==="SYSTEM_INITIAL"&&mode.pricingModel==="FIXED_FEE"&&mode.effectiveAt===effectiveAt)
      return {status:"ALREADY_INITIALIZED" as const,priceScheduleId:price.id,modeScheduleId:mode.id};
    throw conflict("已有价格配置或初始化不完整，未覆盖现有配置");
  }
  const existing=(await client.query<{native:boolean}>(`SELECT EXISTS(SELECT 1 FROM zzsh_supply.listing_publication
    WHERE game_id=$1 AND source='OWNER_DIRECT') OR EXISTS(SELECT 1 FROM zzsh_order.rental_order WHERE game_id=$1) AS native`,[input.gameId])).rows[0];
  if(existing?.native!==false)throw conflict("游戏已有新平台交易或发布记录，不能执行首次初始化");
  const price=(await client.query<PriceVersion&{roundingPolicy:string}>(`SELECT id,mode,status,haff_rule AS "haffRule",fixed_fee_rates AS rates,rounding_policy AS "roundingPolicy"
    FROM zzsh_supply.price_version WHERE id=$1 AND game_id=$2`,[input.priceVersionId,input.gameId])).rows[0];
  if(!price||price.status!=="SEALED"||price.mode!=="PERCENT"||price.roundingPolicy!=="HALF_UP_CENT_V1"
    ||(price.haffRule as {schema?:unknown}|null)?.schema!=="haff-ratio-v3"||!sealedEnabledRentalModes(price.haffRule))throw conflict("首次固定手续费价格版本尚未准备完整");
  let rates:ReturnType<typeof parseFixedFeeRates>;
  try{rates=parseFixedFeeRates(price.rates);}catch{throw conflict("首次固定手续费率无法核实");}
  await assertPriceVersionResources(client,input.gameId,price.id,price.mode);
  const timeline=await readFixedFeeTimeline(client,input.gameId,{from:effectiveAt,fee:{effectiveAt,generation:"1",rates,haffRule:price.haffRule}});
  if(!timeline)throw conflict("首次固定手续费政策无法核实");
  const validation=validateFixedFeeTimeline(timeline);
  if(!validation.valid)throw conflict(`固定手续费与会员或礼遇配置不兼容：${validation.reason}`);
  const priceScheduleId=newSupplyId("price_policy"),modeScheduleId=newSupplyId("pricing_mode");
  await client.query(`INSERT INTO zzsh_supply.pricing_policy_schedule(id,game_id,pricing_model,price_version_id,generation,effective_at,source)
    VALUES($1,$2,'FIXED_FEE',$3,1,$4::timestamptz,'SYSTEM_INITIAL')`,[priceScheduleId,input.gameId,price.id,effectiveAt]);
  await client.query(`INSERT INTO zzsh_supply.pricing_mode_schedule(id,game_id,pricing_model,generation,effective_at,source)
    VALUES($1,$2,'FIXED_FEE',1,$3::timestamptz,'SYSTEM_INITIAL')`,[modeScheduleId,input.gameId,effectiveAt]);
  await recordAudit(client,{actorType:"system",action:"supply.rules.initial_pricing.created",objectType:"pricing_policy_schedule",objectId:priceScheduleId,
    requestId:input.requestId,outcome:"SUCCESS",details:{gameId:input.gameId,priceVersionId:price.id,modeScheduleId,effectiveAt,pricingModel:"FIXED_FEE"}});
  return {status:"INITIALIZED" as const,priceScheduleId,modeScheduleId};
}

/** Called only inside the existing authenticated, idempotent and audited admin write transaction. */
export async function scheduleFixedFeePrice(client: PoolClient, actor: { userId: string; isBoss: boolean }, input: {
  gameId: string; priceVersionId: string; expectedGeneration: string; effectiveAt: string;
}): Promise<{ id: string; generation: string; effectiveAt: string }> {
  if (!actor || actor.isBoss !== true) throw new SecurityApiError(403, "FORBIDDEN", "Only a boss can schedule pricing policies");
  if (typeof actor.userId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actor.userId)) throw invalid("Administrator reference is invalid");
  if (!input || typeof input !== "object" || ![input.gameId, input.priceVersionId].every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    || typeof input.expectedGeneration !== "string" || !/^(0|[1-9]\d{0,18})$/.test(input.expectedGeneration)) throw invalid("Pricing policy reference is invalid");
  let effectiveAt: string;
  try { effectiveAt = normalizeTime(input.effectiveAt) ?? ""; } catch { throw invalid("Pricing policy effective time is invalid"); }
  if (!effectiveAt) throw invalid("Pricing policy effective time is invalid");
  await lockFixedFeePolicyChange(client);
  const now = (await client.query<{ at: string }>(`SELECT ${instantSql("clock_timestamp()")} AS at`)).rows[0]?.at;
  if (!now || effectiveAt <= now) throw invalid("价格政策生效时间必须晚于当前时间");
  if (!(await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`, [input.gameId])).rows.length) throw notFound();
  const price = (await client.query<PriceVersion>(`SELECT id,mode,status,haff_rule AS "haffRule",fixed_fee_rates AS rates
    FROM zzsh_supply.price_version WHERE id=$1 AND game_id=$2`, [input.priceVersionId, input.gameId])).rows[0];
  if (!price || price.status !== "SEALED" || price.mode !== "PERCENT") throw conflict("固定手续费价格版本尚未封存");
  let rates: ReturnType<typeof parseFixedFeeRates>;
  try { rates = parseFixedFeeRates(price.rates); } catch { throw conflict("固定手续费率无法核实"); }
  if (!sealedEnabledRentalModes(price.haffRule) || (price.haffRule as { schema?: unknown })?.schema !== "haff-ratio-v3") throw conflict("固定手续费出租规则无法核实");
  const current = (await client.query<{ generation: string }>(`SELECT COALESCE(MAX(generation),0)::text AS generation
    FROM zzsh_supply.pricing_policy_schedule WHERE game_id=$1 AND pricing_model='FIXED_FEE'`, [input.gameId])).rows[0];
  if (!current || current.generation !== input.expectedGeneration) throw conflict("价格政策版本已变化，请刷新后重试");
  const generation = (BigInt(current.generation) + 1n).toString();
  await assertPriceVersionResources(client,input.gameId,price.id,price.mode);
  const timeline = await readFixedFeeTimeline(client, input.gameId, { from: effectiveAt, fee: { effectiveAt, generation, rates, haffRule: price.haffRule } });
  if (!timeline) throw conflict("固定手续费政策无法核实");
  const validation = validateFixedFeeTimeline(timeline);
  if (!validation.valid) throw conflict(`固定手续费与会员或礼遇配置不兼容：${validation.reason}`);
  const id = newSupplyId("price_policy");
  await client.query(`INSERT INTO zzsh_supply.pricing_policy_schedule
    (id,game_id,pricing_model,price_version_id,generation,effective_at,source,created_by_admin_id)
    VALUES ($1,$2,'FIXED_FEE',$3,$4::bigint,$5::timestamptz,'ADMIN',$6)`, [id, input.gameId, price.id, generation, effectiveAt, actor.userId]);
  return { id, generation, effectiveAt };
}

/** Changes only future default modes; existing listings and orders retain their own snapshots. */
export async function schedulePricingMode(client: PoolClient, actor: {userId:string;isBoss:boolean}, input: {
  gameId:string;pricingModel:PricingModel;expectedGeneration:string;effectiveAt:string;
}): Promise<{id:string;generation:string;effectiveAt:string}> {
  if(!actor||actor.isBoss!==true)throw new SecurityApiError(403,"FORBIDDEN","Only a boss can schedule pricing modes");
  if(typeof actor.userId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actor.userId)
    ||!input||typeof input.gameId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.gameId)
    ||!["SPREAD","FIXED_FEE"].includes(input.pricingModel)||typeof input.expectedGeneration!=="string"
    ||!/^(0|[1-9]\d{0,18})$/.test(input.expectedGeneration))throw invalid("Pricing mode reference is invalid");
  let effectiveAt:string;
  try{effectiveAt=normalizeTime(input.effectiveAt)??"";}catch{throw invalid("Pricing mode effective time is invalid");}
  if(!effectiveAt)throw invalid("Pricing mode effective time is invalid");
  await lockFixedFeePolicyChange(client);
  const now=(await client.query<{at:string}>(`SELECT ${instantSql("clock_timestamp()")} AS at`)).rows[0]?.at;
  if(!now||effectiveAt<=now)throw invalid("抽成模式生效时间必须晚于当前时间");
  if(!(await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`,[input.gameId])).rows.length)throw notFound();
  const current=(await client.query<{generation:string}>(`SELECT COALESCE(MAX(generation),0)::text AS generation
    FROM zzsh_supply.pricing_mode_schedule WHERE game_id=$1`,[input.gameId])).rows[0];
  if(!current||current.generation!==input.expectedGeneration)throw conflict("抽成模式版本已变化，请刷新后重试");
  const price=(await client.query<{id:string}>(`SELECT s.id FROM zzsh_supply.pricing_policy_schedule s
    JOIN zzsh_supply.price_version p ON p.id=s.price_version_id AND p.game_id=s.game_id AND p.status='SEALED'
    WHERE s.game_id=$1 AND s.pricing_model=$2 AND s.effective_at<=$3::timestamptz
      AND (($2='SPREAD' AND p.mode='SPREAD' AND p.fixed_fee_rates IS NULL)
        OR ($2='FIXED_FEE' AND p.mode='PERCENT' AND p.fixed_fee_rates IS NOT NULL))
    ORDER BY s.effective_at DESC,s.generation DESC LIMIT 1`,[input.gameId,input.pricingModel,effectiveAt])).rows[0];
  if(!price)throw conflict("抽成模式尚无生效的价格政策");
  if(input.pricingModel==="FIXED_FEE") {
    const timeline=await readFixedFeeTimeline(client,input.gameId,{from:effectiveAt});
    if(!timeline)throw conflict("固定手续费政策无法核实");
    const validation=validateFixedFeeTimeline(timeline);
    if(!validation.valid)throw conflict(`固定手续费与会员或礼遇配置不兼容：${validation.reason}`);
  }
  const generation=(BigInt(current.generation)+1n).toString(),id=newSupplyId("pricing_mode");
  await client.query(`INSERT INTO zzsh_supply.pricing_mode_schedule
    (id,game_id,pricing_model,generation,effective_at,source,created_by_admin_id)
    VALUES ($1,$2,$3,$4::bigint,$5::timestamptz,'ADMIN',$6)`,[id,input.gameId,input.pricingModel,generation,effectiveAt,actor.userId]);
  return {id,generation,effectiveAt};
}
