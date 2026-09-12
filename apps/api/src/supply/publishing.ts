import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../auth/security-core";
import { assertActiveInTransaction } from "../auth/user-identity";
import {
  computeContentHash,
  normalizeContentPayload,
  normalizeDeclaration,
  normalizeTime,
  humanText,
  type ContentDeclaration,
  type ContentPayloadInput,
} from "./content-hash";
import {
  computeQuote,
  projectQuote,
  type InternalQuote,
  type QuoteInput,
  type QuoteViewer,
} from "./pricing";
import {
  conflict,
  ensureOnlyFields,
  invalid,
  newSupplyId,
  notFound,
} from "./supply-util";
export type SupplyGate = {
  publisherBail: "SATISFIED" | "NOT_REQUIRED" | "PENDING" | "UNKNOWN";
  occupancy: "FREE" | "OCCUPIED" | "UNKNOWN";
  reference: string | null;
};
export type SupplyGateReader = (
  client: PoolClient,
  account: PublishingAccount,
) => Promise<SupplyGate>;
export const unknownSupplyGate: SupplyGateReader = async () => ({
  publisherBail: "UNKNOWN",
  occupancy: "UNKNOWN",
  reference: null,
});
export type PublishingAccount = {
  id: string;
  owner_user_id: string;
  game_id: string;
  current_version_id: string | null;
  owner_paused: boolean;
  staff_restricted: boolean;
  restriction_reason: string | null;
  legacy_hold: string;
  lifecycle: string;
  revision: string;
  display_no: string | null;
};
export type ListingVersion = {
  schema_version: number;
  id: string;
  account_id: string;
  sequence: string;
  origin: string;
  review_state: string;
  title: string;
  description: string | null;
  attributes: Record<string, unknown>;
  term_option_code: string;
  pricing_option_code: string;
  rule_release_id: string | null;
  content_hash: string | null;
  payload: ContentPayloadInput | null;
  presentation: Record<string, unknown>;
  revision: string;
  submitted_at: Date | null;
};
export async function lockPublishingAccount(
  client: PoolClient,
  id: string,
): Promise<PublishingAccount> {
  const found = (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!found) throw notFound();
  // Same user lock as M2 verification/deactivation/cancellation. Rule activation locks game.
  await client.query(
    `SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,
    [found.owner_user_id],
  );
  await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`, [
    found.game_id,
  ]);
  return (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,
      [id],
    )
  ).rows[0]!;
}
export async function withPublicListingSnapshot<T>(
  pool: Pool,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    // One MVCC snapshot for visibility, quote and media; no exclusive row locks.
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    return read(client);
  });
}

export async function readPublishingAccount(
  client: PoolClient,
  id: string,
): Promise<PublishingAccount> {
  const account = (
    await client.query<PublishingAccount>(
      `SELECT * FROM zzsh_supply.rental_account WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!account) throw notFound();
  return account;
}

export async function readCurrentVersion(
  client: PoolClient,
  account: PublishingAccount,
): Promise<ListingVersion> {
  const version = (
    await client.query<ListingVersion>(
      `SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2`,
      [account.current_version_id, account.id],
    )
  ).rows[0];
  if (!version) throw notFound();
  return version;
}
export function checkAccountRevision(
  account: PublishingAccount,
  revision: unknown,
): void {
  if (typeof revision !== "string" || revision !== account.revision)
    throw conflict("供给资料已变化，请刷新后重试");
}
export async function currentVersion(
  client: PoolClient,
  account: PublishingAccount,
): Promise<ListingVersion> {
  const v = (
    await client.query<ListingVersion>(
      `SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [account.current_version_id, account.id],
    )
  ).rows[0];
  if (!v) throw conflict("请先保存一份草稿");
  return v;
}
async function bumpAccount(
  client: PoolClient,
  account: PublishingAccount,
): Promise<void> {
  const row = (
    await client.query<{
      revision: string;
    }>(
      `UPDATE zzsh_supply.rental_account SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING revision::text`,
      [account.id],
    )
  ).rows[0]!;
  account.revision = row.revision;
}
export async function publicationBlockers(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
  gate: SupplyGateReader,
): Promise<string[]> {
  const reasons: string[] = [];
  const user = (
    await client.query(
      `SELECT u.suspended, COALESCE(s.account_status,'ACTIVE') AS account_status,s.identity_status,s.age_status FROM zzsh_auth_user."user" u LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id WHERE u.id=$1`,
      [a.owner_user_id],
    )
  ).rows[0];
  if (!user || user.suspended || user.account_status !== "ACTIVE")
    reasons.push("OWNER_UNAVAILABLE");
  if (user?.identity_status !== "VERIFIED") reasons.push("IDENTITY_REQUIRED");
  if (user?.age_status !== "ADULT") reasons.push("ADULT_REQUIRED");
  const game = (
    await client.query(
      `SELECT enabled,current_release_id FROM zzsh_supply.game WHERE id=$1`,
      [a.game_id],
    )
  ).rows[0];
  if (!game?.enabled) reasons.push("GAME_UNAVAILABLE");
  if (!v.rule_release_id || game?.current_release_id !== v.rule_release_id)
    reasons.push("RULE_CHANGED");
  if (
    a.lifecycle !== "ACTIVE" ||
    a.legacy_hold !== "NONE" ||
    v.origin !== "NATIVE"
  )
    reasons.push("ACCOUNT_NOT_PUBLISHABLE");
  let external: SupplyGate;
  try {
    external = await gate(client, a);
  } catch {
    external = await unknownSupplyGate(client, a);
  }
  if (
    !external.reference ||
    !["SATISFIED", "NOT_REQUIRED"].includes(external.publisherBail)
  )
    reasons.push("PUBLISHER_BAIL_UNCONFIRMED");
  if (external.occupancy !== "FREE")
    reasons.push(
      external.occupancy === "OCCUPIED" ? "OCCUPIED" : "OCCUPANCY_UNKNOWN",
    );
  return reasons;
}
async function assertEditable(
  client: PoolClient,
  a: PublishingAccount,
  gate: SupplyGateReader,
): Promise<void> {
  await assertActiveInTransaction(client, a.owner_user_id);
  if (a.lifecycle !== "ACTIVE" || a.legacy_hold !== "NONE")
    throw conflict("历史异常或归档账号不能发布");
  const external = await gate(client, a);
  if (external.occupancy !== "FREE")
    throw conflict("暂不能确认账号空闲，请先处理占用状态");
}
export async function readDeclaration(
  client: PoolClient,
  v: ListingVersion,
): Promise<
  ContentDeclaration & {
    inventory: Array<{
      itemId: string;
      quantity: string | null;
    }>;
  }
> {
  const inventory = (
    await client.query(
      `SELECT item_id AS "itemId",quantity::text FROM zzsh_supply.inventory_line WHERE version_id=$1 ORDER BY item_id`,
      [v.id],
    )
  ).rows;
  const skins = (
    await client.query(
      `SELECT skin_id FROM zzsh_supply.listing_skin WHERE version_id=$1 ORDER BY skin_id`,
      [v.id],
    )
  ).rows.map((r) => r.skin_id);
  const entitlements = (
    await client.query(
      `SELECT entitlement_id AS "entitlementId",value, CASE WHEN expires_at IS NULL THEN NULL ELSE to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "expiresAt",expiry_knowledge AS "expiryKnowledge" FROM zzsh_supply.listing_entitlement WHERE version_id=$1 ORDER BY entitlement_id`,
      [v.id],
    )
  ).rows;
  const mediaBindings = (
    await client.query(
      `SELECT m.asset_id AS "assetId",a.content_hash AS "byteHash",a.purpose,m.position FROM zzsh_supply.listing_media m JOIN zzsh_supply.media_asset a ON a.id=m.asset_id WHERE m.version_id=$1 ORDER BY m.position`,
      [v.id],
    )
  ).rows;
  return {
    title: v.title,
    description: v.description,
    attributes: v.attributes,
    inventory,
    skins,
    entitlements,
    termOptionCode: v.term_option_code,
    pricingOptionCode: v.pricing_option_code,
    mediaBindings,
  };
}
export async function createListingDraft(
  client: PoolClient,
  a: PublishingAccount,
  expected: unknown,
  gate: SupplyGateReader,
): Promise<void> {
  checkAccountRevision(a, expected);
  await assertEditable(client, a, gate);
  const old = a.current_version_id ? await currentVersion(client, a) : null;
  if (old?.review_state === "SUBMITTED")
    throw conflict("请先撤回正在审核的资料");
  if (old?.review_state === "DRAFT") throw conflict("已有可编辑草稿");
  const id = newSupplyId("listing");
  await client.query(
    `INSERT INTO zzsh_supply.listing_version(id,account_id,sequence,title,description,attributes,term_option_code,pricing_option_code) SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,$4,$5,$6,$7 FROM zzsh_supply.listing_version WHERE account_id=$2`,
    [
      id,
      a.id,
      old?.title ?? "",
      old?.description ?? null,
      old?.attributes ?? {},
      old?.term_option_code ?? "",
      old?.pricing_option_code ?? "",
    ],
  );
  if (old) {
    for (const [table, fields] of [
      ["inventory_line", "item_id,quantity"],
      ["listing_skin", "skin_id"],
      [
        "listing_entitlement",
        "entitlement_id,value,expires_at,expiry_knowledge",
      ],
      ["listing_media", "asset_id,position"],
    ])
      await client.query(
        `INSERT INTO zzsh_supply.${table}(version_id,${fields}) SELECT $1,${fields} FROM zzsh_supply.${table} WHERE version_id=$2`,
        [id, old.id],
      );
  }
  // Switching the current version to a draft blocks new rentals without changing owner intent.
  await client.query(
    `UPDATE zzsh_supply.rental_account SET current_version_id=$1 WHERE id=$2`,
    [id, a.id],
  );
  a.current_version_id = id;
  await bumpAccount(client, a);
}
const list = (
  v: unknown,
  label: string,
  path: string,
): Record<string, unknown>[] => {
  if (
    !Array.isArray(v) ||
    v.length > 100 ||
    v.some((x) => !x || typeof x !== "object" || Array.isArray(x))
  )
    throw invalid(label, path);
  return v;
};
const idText = (v: unknown, path: string): string => {
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))
    throw invalid("Invalid identifier", path);
  return v;
};
export async function saveListingDraft(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
): Promise<void> {
  ensureOnlyFields(body, [
    "expectedRevision",
    "title",
    "description",
    "attributes",
    "termOptionCode",
    "pricingOptionCode",
    "inventory",
    "skins",
    "entitlements",
    "mediaBindings",
  ]);
  checkAccountRevision(a, body.expectedRevision);
  await assertEditable(client, a, gate);
  const v = await currentVersion(client, a);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("这份资料不可修改，请创建新草稿");
  if (body.title !== undefined && typeof body.title !== "string")
    throw invalid("标题格式错误", "title");
  for (const field of ["termOptionCode", "pricingOptionCode"])
    if (
      body[field] !== undefined &&
      (typeof body[field] !== "string" ||
        !/^$|^[a-z][a-z0-9_:-]{1,63}$/.test(body[field] as string))
    )
      throw invalid("选项代码格式错误", field);
  const title = humanText(typeof body.title === "string" ? body.title : "");
  if (title.length > 120) throw invalid("标题过长", "title");
  if (body.description != null && typeof body.description !== "string")
    throw invalid("说明格式错误", "description");
  const description =
    body.description == null ? null : humanText(body.description as string);
  if (description && description.length > 4000)
    throw invalid("说明过长", "description");
  let normalized: ContentDeclaration;
  try {
    normalized = normalizeDeclaration({
      title,
      description,
      attributes: (body.attributes ?? {}) as Record<string, unknown>,
      inventory: [],
      skins: [],
      entitlements: [],
      mediaBindings: [],
      termOptionCode: String(body.termOptionCode ?? ""),
      pricingOptionCode: String(body.pricingOptionCode ?? ""),
    });
  } catch {
    throw invalid("属性格式或范围错误", "attributes");
  }
  const inventory = list(body.inventory ?? [], "库存格式错误", "inventory");
  const seen = new Set<string>();
  for (const item of inventory) {
    ensureOnlyFields(item, ["itemId", "quantity"]);
    idText(item.itemId, "inventory");
    if (seen.has(item.itemId as string)) throw invalid("库存重复", "inventory");
    seen.add(item.itemId as string);
    if (
      item.quantity !== null &&
      (typeof item.quantity !== "string" ||
        !/^(0|[1-9]\d{0,23})$/.test(item.quantity))
    )
      throw invalid("数量须为整数文本或未知null", "inventory");
  }
  if (
    !Array.isArray(body.skins ?? []) ||
    ((body.skins as unknown[]) ?? []).some((id) => typeof id !== "string")
  )
    throw invalid("皮肤格式错误", "skins");
  const skins = (body.skins ?? []) as string[];
  if (new Set(skins).size !== skins.length) throw invalid("皮肤重复", "skins");
  const entitlements = list(
      body.entitlements ?? [],
      "权益格式错误",
      "entitlements",
    ),
    media = list(body.mediaBindings ?? [], "图片格式错误", "mediaBindings");
  for (const t of [
    "inventory_line",
    "listing_skin",
    "listing_entitlement",
    "listing_media",
  ])
    await client.query(`DELETE FROM zzsh_supply.${t} WHERE version_id=$1`, [
      v.id,
    ]);
  for (const item of inventory)
    await client.query(
      `INSERT INTO zzsh_supply.inventory_line(version_id,item_id,quantity) VALUES($1,$2,$3)`,
      [v.id, item.itemId, item.quantity],
    );
  for (const id of skins)
    await client.query(
      `INSERT INTO zzsh_supply.listing_skin(version_id,skin_id) VALUES($1,$2)`,
      [v.id, idText(id, "skins")],
    );
  for (const ent of entitlements) {
    ensureOnlyFields(ent, [
      "entitlementId",
      "value",
      "expiresAt",
      "expiryKnowledge",
    ]);
    const expiry = normalizeTime(
      ent.expiresAt == null ? null : (ent.expiresAt as string),
    );
    if (!["KNOWN", "UNKNOWN"].includes(String(ent.expiryKnowledge)))
      throw invalid("权益有效期状态错误", "entitlements");
    await client.query(
      `INSERT INTO zzsh_supply.listing_entitlement(version_id,entitlement_id,value,expires_at,expiry_knowledge) VALUES($1,$2,$3,$4,$5)`,
      [
        v.id,
        idText(ent.entitlementId, "entitlements"),
        JSON.stringify(ent.value ?? null),
        expiry,
        ent.expiryKnowledge,
      ],
    );
  }
  for (const binding of media) {
    ensureOnlyFields(binding, ["assetId", "position"]);
    if (
      !Number.isInteger(binding.position) ||
      Number(binding.position) < 0 ||
      Number(binding.position) > 99
    )
      throw invalid("图片顺序错误", "mediaBindings");
    await client.query(
      `INSERT INTO zzsh_supply.listing_media(version_id,asset_id,position) VALUES($1,$2,$3)`,
      [v.id, idText(binding.assetId, "mediaBindings"), binding.position],
    );
  }
  await client.query(
    `UPDATE zzsh_supply.listing_version SET title=$2,description=$3,attributes=$4,term_option_code=$5,pricing_option_code=$6,payload=NULL,content_hash=NULL,rule_release_id=NULL,revision=revision+1 WHERE id=$1`,
    [
      v.id,
      title,
      description,
      normalized.attributes,
      normalized.termOptionCode,
      normalized.pricingOptionCode,
    ],
  );
  await bumpAccount(client, a);
}
export async function quoteListing(
  client: PoolClient,
  a: PublishingAccount,
  expected: unknown,
): Promise<void> {
  checkAccountRevision(a, expected);
  const v = await currentVersion(client, a);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可为新申报草稿报价");
  const d = await readDeclaration(client, v);
  if (!d.title.trim() || d.inventory.some((i) => i.quantity === null))
    throw invalid("请补齐标题及库存，未知数量不能当作零", "inventory");
  const missing = await client.query(
    `SELECT 1 FROM zzsh_supply.billable_item i WHERE game_id=$1 AND enabled AND required AND NOT EXISTS(SELECT 1 FROM zzsh_supply.inventory_line l WHERE l.version_id=$2 AND l.item_id=i.id AND l.quantity IS NOT NULL)`,
    [a.game_id, v.id],
  );
  if (missing.rowCount)
    throw invalid("必填物品须明确填写数量或零", "inventory");
  const release = (
    await client.query(
      `SELECT r.*,p.mode,p.commission_rate::text,p.haff_rule,p.rounding_policy,ag.digest FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id JOIN zzsh_supply.price_version p ON p.id=r.price_version_id JOIN zzsh_supply.agreement_version ag ON ag.id=r.agreement_version_id WHERE g.id=$1 AND g.enabled`,
      [a.game_id],
    )
  ).rows[0];
  if (!release) throw conflict("暂无可用规则");
  const term = (
    await client.query(
      `SELECT code,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 AND code=$2`,
      [release.term_version_id, d.termOptionCode],
    )
  ).rows[0];
  if (!term) throw invalid("请选择当前租期选项", "termOptionCode");
  const rows = (
    await client.query(
      `SELECT l.item_id AS "itemId", l.quantity::text,i.unit,i.name,i.enabled,p.pricing_kind AS "pricingKind",p.unit_quantity::text AS "unitQuantity",p.buyer_unit_amount::text AS "buyerUnitAmount",p.owner_unit_amount::text AS "ownerUnitAmount" FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id LEFT JOIN zzsh_supply.price_line p ON p.item_id=i.id AND p.price_version_id=$2 AND p.customer_tier='STANDARD' WHERE l.version_id=$1 ORDER BY l.item_id`,
      [v.id, release.price_version_id],
    )
  ).rows;
  if (!rows.length || rows.some((r) => !r.enabled || !r.pricingKind))
    throw invalid("申报物品不在当前可用价目中", "inventory");
  const ents = (
    await client.query(
      `SELECT e.id AS "entitlementId",e.expiry_kind AS "expiryKind",e.value_kind,e.name,e.enabled,l.value,l.expiry_knowledge,CASE WHEN l.expires_at IS NULL THEN NULL ELSE to_char(l.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "expiresAt" FROM zzsh_supply.listing_entitlement l JOIN zzsh_supply.entitlement e ON e.id=l.entitlement_id WHERE version_id=$1`,
      [v.id],
    )
  ).rows;
  if (
    ents.some(
      (e) =>
        !e.enabled ||
        (e.value_kind === "FLAG"
          ? typeof e.value !== "boolean"
          : !Number.isSafeInteger(e.value) || e.value < 0),
    )
  )
    throw invalid("权益值与目录类型不符", "entitlements");
  const skins = (
    await client.query(
      `WITH RECURSIVE visible AS (SELECT id FROM zzsh_supply.skin_category WHERE parent_id IS NULL AND enabled AND form_visible UNION ALL SELECT c.id FROM zzsh_supply.skin_category c JOIN visible p ON c.parent_id=p.id WHERE c.enabled AND c.form_visible) SELECT s.id,s.name,s.enabled,s.form_visible,(s.category_id IN (SELECT id FROM visible)) AS category_visible FROM zzsh_supply.listing_skin l JOIN zzsh_supply.skin s ON s.id=l.skin_id WHERE version_id=$1`,
      [v.id],
    )
  ).rows;
  if (skins.some((s) => !s.enabled || !s.form_visible || !s.category_visible))
    throw invalid("皮肤已停止申报", "skins");
  if (
    ents.some((e) => e.expiryKind === "TIMED" && e.expiry_knowledge !== "KNOWN")
  )
    throw invalid("请先确认限时权益的到期时间", "entitlements");
  const attrs = d.attributes;
  const vitality = attrs.vit_level ?? attrs.vitLevel;
  const bear = attrs.bear_level ?? attrs.bearLevel;
  const result = computeQuote({
    priceVersionId: release.price_version_id,
    mode: release.mode,
    roundingPolicy: release.rounding_policy,
    ...(release.commission_rate === null
      ? {}
      : { commissionRate: release.commission_rate }),
    haffRule: release.haff_rule,
    lines: rows.map((r) => ({
      itemId: r.itemId,
      quantity: r.quantity,
      unit: r.unit,
      pricingKind: r.pricingKind,
      ...(r.unitQuantity === null ? {} : { unitQuantity: r.unitQuantity }),
      ...(r.buyerUnitAmount === null
        ? {}
        : { buyerUnitAmount: r.buyerUnitAmount }),
      ...(r.ownerUnitAmount === null
        ? {}
        : { ownerUnitAmount: r.ownerUnitAmount }),
    })),
    conditions: {
      safeBoxCode: String(attrs.safe_box_code ?? ""),
      vitLevel: typeof vitality === "number" ? vitality : undefined,
      bearLevel: typeof bear === "number" ? bear : undefined,
      termOptionCode: d.termOptionCode,
      pricingOptionCode: d.pricingOptionCode,
    },
    termOption: term,
    entitlements: ents.map((e) => ({
      entitlementId: e.entitlementId,
      expiryKind: e.expiryKind,
      ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
    })),
  } as QuoteInput);
  if (!result.quotable)
    throw invalid(
      `当前条件无法报价：${result.reasonCodes.join(",")}`,
      "attributes",
    );
  result.quote.ruleReleaseId = release.id;
  const payload = normalizeContentPayload({
    schemaVersion: 1,
    accountId: a.id,
    gameId: a.game_id,
    declaration: d,
    ruleRefs: {
      releaseId: release.id,
      priceVersionId: release.price_version_id,
      termVersionId: release.term_version_id,
      agreementVersionId: release.agreement_version_id,
      agreementDigest: release.digest,
    },
    quoteValues: result.quote as unknown as Record<string, unknown>,
  });
  await client.query(
    `UPDATE zzsh_supply.listing_version SET payload=$2,content_hash=$3,rule_release_id=$4,presentation=$5,revision=revision+1 WHERE id=$1`,
    [
      v.id,
      payload,
      computeContentHash(payload),
      release.id,
      {
        items: rows.map((r) => ({ id: r.itemId, name: r.name, unit: r.unit })),
        skins: skins.map((s) => ({ id: s.id, name: s.name })),
        entitlements: ents.map((e) => ({ id: e.entitlementId, name: e.name })),
      },
    ],
  );
  await bumpAccount(client, a);
}
function requireVersionToken(
  v: ListingVersion,
  body: Record<string, unknown>,
): void {
  if (
    v.id !== body.versionId ||
    !v.content_hash ||
    v.content_hash !== body.contentHash ||
    v.rule_release_id !== body.releaseId
  )
    throw conflict("资料或规则已变化，请重新预览确认");
}
async function assertCurrentRelease(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
): Promise<void> {
  if (
    (
      await client.query(
        `SELECT current_release_id FROM zzsh_supply.game WHERE id=$1`,
        [a.game_id],
      )
    ).rows[0]?.current_release_id !== v.rule_release_id
  )
    throw conflict("规则已更新，请创建新草稿并重新确认");
}
export async function acceptListingRules(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  await assertCurrentRelease(client, a, v);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可确认新申报草稿");
  await client.query(
    `INSERT INTO zzsh_supply.rule_acceptance(id,owner_user_id,account_id,listing_version_id,rule_release_id,accepted_content_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_user_id,listing_version_id,rule_release_id,accepted_content_hash) DO NOTHING`,
    [
      newSupplyId("accept"),
      a.owner_user_id,
      a.id,
      v.id,
      v.rule_release_id,
      v.content_hash,
    ],
  );
  await bumpAccount(client, a);
}
async function assertAccepted(
  client: PoolClient,
  a: PublishingAccount,
  v: ListingVersion,
): Promise<void> {
  if (
    !(
      await client.query(
        `SELECT 1 FROM zzsh_supply.rule_acceptance WHERE account_id=$1 AND listing_version_id=$2 AND rule_release_id=$3 AND accepted_content_hash=$4 AND owner_user_id=$5`,
        [a.id, v.id, v.rule_release_id, v.content_hash, a.owner_user_id],
      )
    ).rowCount
  )
    throw conflict("请先确认这份资料对应的规则和报价");
}
async function assertMediaReady(
  client: PoolClient,
  v: ListingVersion,
): Promise<void> {
  const media = (
    await client.query(
      `SELECT a.* FROM zzsh_supply.listing_media m JOIN zzsh_supply.media_asset a ON a.id=m.asset_id WHERE m.version_id=$1`,
      [v.id],
    )
  ).rows;
  if (!media.some((m) => m.purpose === "ACCOUNT_DISPLAY"))
    throw invalid("至少需要一张展示图", "mediaBindings");
  if (
    media.some(
      (m) =>
        m.review_state !== "APPROVED" ||
        (m.purpose === "ACCOUNT_DISPLAY" &&
          (!m.public_storage_key || m.access_class !== "PUBLIC_DISPLAY")),
    )
  )
    throw conflict("请先完成图片审核，私有凭证不能当展示图");
}
export async function submitListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  if (v.review_state !== "DRAFT") throw conflict("当前资料不能重复提交");
  const blockers = await publicationBlockers(client, a, v, gate);
  if (blockers.length) throw conflict(blockers.join(","));
  await assertAccepted(client, a, v);
  await assertMediaReady(client, v);
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state='SUBMITTED',submitted_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
    [v.id],
  );
  await bumpAccount(client, a);
}
export async function withdrawListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  if (v.id !== body.versionId || v.review_state !== "SUBMITTED")
    throw conflict("该版本已被处理");
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state='WITHDRAWN',revision=revision+1 WHERE id=$1`,
    [v.id],
  );
  await bumpAccount(client, a);
}
export async function reviewListing(
  client: PoolClient,
  a: PublishingAccount,
  actorId: string,
  body: Record<string, unknown>,
  gate: SupplyGateReader,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  const v = await currentVersion(client, a);
  requireVersionToken(v, body);
  await assertCurrentRelease(client, a, v);
  if (v.review_state !== "SUBMITTED") throw conflict("该版本已被处理");
  if (!["APPROVE", "REJECT"].includes(String(body.decision)))
    throw invalid("审核决定错误");
  const reason = humanText(String(body.reason ?? "")).trim();
  if (reason.length < 2 || reason.length > 500)
    throw invalid("请填写具体审核理由");
  if (body.decision === "APPROVE") {
    const blockers = await publicationBlockers(client, a, v, gate);
    if (blockers.length) throw conflict(blockers.join(","));
    await assertAccepted(client, a, v);
    await assertMediaReady(client, v);
  }
  await client.query(
    `INSERT INTO zzsh_supply.review_decision(id,version_id,release_id,content_hash,decision,reason,reviewer_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      newSupplyId("review"),
      v.id,
      v.rule_release_id,
      v.content_hash,
      body.decision,
      reason,
      actorId,
    ],
  );
  await client.query(
    `UPDATE zzsh_supply.listing_version SET review_state=$2,revision=revision+1 WHERE id=$1`,
    [v.id, body.decision === "APPROVE" ? "APPROVED" : "REJECTED"],
  );
  await bumpAccount(client, a);
}
export async function setOwnerPaused(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
  paused: boolean,
  gate: SupplyGateReader,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (!paused) {
    const v = await currentVersion(client, a);
    if (v.review_state !== "APPROVED" || a.staff_restricted)
      throw conflict("请先完成资料审核或处理客服限制");
    const blockers = await publicationBlockers(client, a, v, gate);
    if (blockers.length) throw conflict(blockers.join(","));
    await assertAccepted(client, a, v);
    await assertMediaReady(client, v);
  }
  await client.query(
    `UPDATE zzsh_supply.rental_account SET owner_paused=$2 WHERE id=$1`,
    [a.id, paused],
  );
  a.owner_paused = paused;
  await bumpAccount(client, a);
}
export async function restrictListing(
  client: PoolClient,
  a: PublishingAccount,
  body: Record<string, unknown>,
): Promise<void> {
  checkAccountRevision(a, body.expectedRevision);
  if (
    typeof body.restricted !== "boolean" ||
    typeof body.reason !== "string" ||
    body.reason.trim().length < 2 ||
    body.reason.length > 500
  )
    throw invalid("请填写限制或解除原因");
  await client.query(
    `UPDATE zzsh_supply.rental_account SET staff_restricted=$2,restriction_reason=$3 WHERE id=$1`,
    [a.id, body.restricted, humanText(body.reason)],
  );
  a.staff_restricted = body.restricted;
  a.restriction_reason = body.reason;
  await bumpAccount(client, a);
}
export async function listingDetail(
  client: PoolClient,
  a: PublishingAccount,
  viewer: QuoteViewer,
  gate: SupplyGateReader,
  quoteViewer: QuoteViewer = viewer,
): Promise<Record<string, unknown>> {
  const v = a.current_version_id
    ? await (viewer === "public"
        ? readCurrentVersion(client, a)
        : currentVersion(client, a))
    : null;
  if (!v) {
    if (viewer === "public") throw notFound();
    return { account: a, version: null };
  }
  const blockers = await publicationBlockers(client, a, v, gate);
  if (v.review_state !== "APPROVED") blockers.push("REVIEW_REQUIRED");
  if (a.owner_paused) blockers.push("OWNER_PAUSED");
  if (a.staff_restricted) blockers.push("STAFF_RESTRICTED");
  try {
    await assertAccepted(client, a, v);
    await assertMediaReady(client, v);
  } catch {
    blockers.push("CONFIRMATION_OR_MEDIA_REQUIRED");
  }
  const quote = v.payload
    ? projectQuote(
        {
          ...v.payload.quoteValues,
          contentHash: v.content_hash,
        } as unknown as InternalQuote,
        quoteViewer,
      )
    : null;
  if (viewer === "public") {
    if (blockers.length) throw notFound();
    const attrs = v.payload!.declaration.attributes;
    const publicAttrs = Object.fromEntries(
      [
        "vit_level",
        "bear_level",
        "dive_level",
        "character_level",
        "grading_code",
        "login_method_code",
        "region_province",
        "region_city",
      ].map((k) => [k, attrs[k] ?? null]),
    );
    return {
      id: a.id,
      versionId: v.id,
      title: v.title,
      description: v.description,
      attributes: publicAttrs,
      presentation: v.presentation,
      quote,
      media: v
        .payload!.declaration.mediaBindings.filter(
          (m) => m.purpose === "ACCOUNT_DISPLAY",
        )
        .map((m) => ({
          assetId: m.assetId,
          position: m.position,
          url: `/api/v1/supply/listings/${a.id}/media/${m.assetId}`,
        })),
    };
  }
  const decisions = (
    await client.query(
      `SELECT d.id,d.version_id,d.decision,d.reason,d.decided_at,u.name AS reviewer_name FROM zzsh_supply.review_decision d JOIN zzsh_auth_admin."user" u ON u.id=d.reviewer_admin_id JOIN zzsh_supply.listing_version v ON v.id=d.version_id WHERE v.account_id=$1 ORDER BY d.decided_at`,
      [a.id],
    )
  ).rows;
  const ownerName =
    (
      await client.query(`SELECT name FROM zzsh_auth_user."user" WHERE id=$1`, [
        a.owner_user_id,
      ])
    ).rows[0]?.name ?? "号主";
  const agreement = v.rule_release_id
    ? (
        await client.query(
          `SELECT ag.id,ag.title,ag.body,ag.digest FROM zzsh_supply.rule_release r JOIN zzsh_supply.agreement_version ag ON ag.id=r.agreement_version_id WHERE r.id=$1`,
          [v.rule_release_id],
        )
      ).rows[0]
    : null;
  return {
    ownerName,
    agreement,
    account: a,
    version: {
      schemaVersion: v.schema_version,
      id: v.id,
      sequence: v.sequence,
      origin: v.origin,
      reviewState: v.review_state,
      revision: v.revision,
      releaseId: v.rule_release_id,
      contentHash: v.content_hash,
      declaration: await readDeclaration(client, v),
      presentation: v.presentation,
      quote,
    },
    available: !blockers.length,
    blockers,
    decisions,
  };
}
