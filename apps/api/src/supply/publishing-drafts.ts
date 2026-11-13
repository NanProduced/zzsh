/**
 * 上架草稿域：创建与保存草稿。写函数接收调用方的 PoolClient，不自行开启或提交事务。
 */
import { PoolClient } from "pg";
import { normalizeDeclaration, normalizeTime, humanText, type ContentDeclaration } from "./content-hash";
import { isAccountMediaBinding } from "./listing-query";
import { conflict, ensureOnlyFields, invalid, newSupplyId } from "./supply-util";
import { assertDeltaResourceUnit, isDeltaGradingDivision } from "./delta-rental";
import { type ListingMediaAssetRow, type PublishingAccount, type SupplyGateReader, assertEditable, bumpAccount, checkAccountRevision, currentVersion, readAccountMediaBindings, readDeclaration } from "./publishing-internals";

export async function createListingDraft(
  client: PoolClient,
  a: PublishingAccount,
  expected: unknown,
  gate: SupplyGateReader,
): Promise<void> {
  checkAccountRevision(a, expected);
  await assertEditable(client, a, gate);
  const old = a.current_version_id ? await currentVersion(client, a) : null;
  if (old && old.origin !== "NATIVE") throw conflict("历史账号不能重新上架，请重新填写资料");
  if (old?.review_state === "SUBMITTED")
    throw conflict("请先撤回正在审核的资料");
  if (old?.review_state === "DRAFT") throw conflict("已有可编辑草稿");
  if (old) await readAccountMediaBindings(client, old.id);
  const id = newSupplyId("listing");
  await client.query(
    `INSERT INTO zzsh_supply.listing_version(id,account_id,sequence,title,description,attributes,term_option_code,pricing_option_code,schema_version) SELECT $1,$2,COALESCE(MAX(sequence),0)+1,$3,$4,$5,$6,$7,$8 FROM zzsh_supply.listing_version WHERE account_id=$2`,
    [
      id,
      a.id,
      old?.title ?? "",
      old?.description ?? null,
      old?.attributes ?? {},
      old?.term_option_code ?? "",
      old?.pricing_option_code ?? "",
      old?.schema_version === 3 ? 2 : old?.schema_version ?? 1,
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
  verifiedLegacyReference?: string,
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
  if (isDeltaGradingDivision(v.attributes.grading_code, v.attributes.grading_division)
    && (!body.attributes || typeof body.attributes !== "object" || !Object.hasOwn(body.attributes, "grading_division")))
    throw conflict("客户端未保留已申报的小段位，请更新客户端后重试");
  for (const field of ["next_season_pass", "demulan_unlocked"] as const) {
    if (typeof v.attributes[field] === "boolean" && (!body.attributes || typeof body.attributes !== "object" || !Object.hasOwn(body.attributes, field)))
      throw conflict("客户端未保留已申报的通行证计划或德穆兰状态，请更新客户端后重试");
  }
  let normalized: ContentDeclaration;
  const attributes = (body.attributes ?? {}) as Record<string, unknown>;
  const legacyReference = verifiedLegacyReference ?? v.attributes.legacy_published_reference;
  if (Object.hasOwn(attributes, "legacy_published_reference") && attributes.legacy_published_reference !== legacyReference)
    throw invalid("旧刊登图片来源不可修改", "attributes.legacy_published_reference");
  try {
    normalized = normalizeDeclaration({
      title,
      description,
      attributes: legacyReference === undefined ? attributes : { ...attributes, legacy_published_reference: legacyReference },
      inventory: [],
      skins: [],
      entitlements: [],
      mediaBindings: [],
      termOptionCode: String(body.termOptionCode ?? ""),
      pricingOptionCode: String(body.pricingOptionCode ?? ""),
    }, (body.attributes as Record<string, unknown> | undefined)?.rentalPricing === undefined ? 1 : 2);
  } catch {
    throw invalid("属性格式或范围错误", "attributes");
  }
  const inventory = list(body.inventory ?? [], "库存格式错误", "inventory");
  const characterLevel=normalized.attributes.character_level;
  if(typeof characterLevel==="number"&&characterLevel>60){
    const previous=(await readDeclaration(client,v)).attributes.character_level;
    if(previous!==characterLevel)throw invalid("账号等级须为0–60的整数","attributes.character_level");
  }
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
  const mediaCategories: Record<string, "SHOWCASE" | "PENALTY"> = {};
  for (const binding of media) {
    ensureOnlyFields(binding, ["assetId", "position", "category"]);
    idText(binding.assetId, "mediaBindings");
    if (!Number.isInteger(binding.position) || Number(binding.position) < 0 || Number(binding.position) > 99) throw invalid("图片顺序错误", "mediaBindings");
    if (binding.category !== undefined && binding.category !== "SHOWCASE" && binding.category !== "PENALTY") throw invalid("图片分类错误", "mediaBindings");
    if (binding.category !== undefined) mediaCategories[binding.assetId as string] = binding.category;
  }
  if (media.length) {
    const assets = (await client.query<ListingMediaAssetRow>(
      `SELECT * FROM zzsh_supply.media_asset WHERE id=ANY($1::text[]) AND account_id=$2 AND owner_user_id=$3 AND game_id=$4 ORDER BY id FOR UPDATE`,
      [media.map(binding => binding.assetId), a.id, a.owner_user_id, a.game_id],
    )).rows;
    if (assets.length !== media.length || assets.some(asset => !isAccountMediaBinding(asset, a))) throw invalid("图片绑定无效", "mediaBindings");
  }
  if (inventory.length) {
    const items = (await client.query<{ id: string; code: string; unit: string; quantityScale: number }>(
      `SELECT id,code,unit,quantity_scale AS "quantityScale" FROM zzsh_supply.billable_item WHERE game_id=$1 AND id=ANY($2::text[])`,
      [a.game_id, inventory.map(item => item.itemId)],
    )).rows;
    if (items.length !== inventory.length) throw invalid("库存物品不属于当前游戏", "inventory");
    for (const item of items) assertDeltaResourceUnit(item.code, item.unit, item.quantityScale);
  }
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
  delete normalized.attributes.media_categories;
  for (const binding of media) {
    await client.query(
      `INSERT INTO zzsh_supply.listing_media(version_id,asset_id,position) VALUES($1,$2,$3)`,
      [v.id, idText(binding.assetId, "mediaBindings"), binding.position],
    );
  }
  // Version-owned classification participates in the existing declaration hash.
  // Never overwrite the asset's provenance or reclassify another published version.
  if (Object.keys(mediaCategories).length) normalized.attributes.media_categories = mediaCategories;
  await client.query(
    `UPDATE zzsh_supply.listing_version SET title=$2,description=$3,attributes=$4,term_option_code=$5,pricing_option_code=$6,schema_version=$7,payload=NULL,content_hash=NULL,rule_release_id=NULL,revision=revision+1 WHERE id=$1`,
    [
      v.id,
      title,
      description,
      normalized.attributes,
      normalized.termOptionCode,
      normalized.pricingOptionCode,
      normalized.attributes.rentalPricing === undefined ? 1 : 2,
    ],
  );
  await bumpAccount(client, a);
}
