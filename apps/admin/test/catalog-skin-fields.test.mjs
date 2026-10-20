import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceFields, rarityOptions, skinValues, skinPayload } from "../src/views/catalog-skin-fields.ts";
import { skinIsSelectable, skinRarityBasisText } from "../src/views/supply-catalog/model.ts";

// 北京时间 2026-10-14 00:30 = UTC 2026-10-13 16:30：UTC 切片会把“今日”填成前一天。
const beijingMidnight = Date.UTC(2026, 9, 13, 16, 30);
const evidence = (over = {}) => ({ reason: "核对隐藏皮肤身份", evidenceUrls: "https://example.com/a", region: "中国大陆", note: "官方页面截图", ...over });

test("F5 evidence date defaults to the Beijing calendar day, not the UTC one", t => {
  t.mock.timers.enable({ apis: ["Date"], now: beijingMidnight });
  assert.equal(skinValues().observedAt, "2026-10-14", "the prefilled day matches 「今日」 in Beijing time");
  assert.equal(evidenceFields(evidence({ observedAt: "" })).evidenceRefs[0].observedAt, "2026-10-14");
});

test("F5 an explicit operator date is preserved and invalid dates are refused", () => {
  assert.equal(evidenceFields(evidence({ observedAt: "2026-09-01" })).evidenceRefs[0].observedAt, "2026-09-01", "a hand-edited date is never overwritten by today");
  for (const observedAt of ["2026-02-30", "2026-13-01", "not-a-date"]) {
    assert.throws(() => evidenceFields(evidence({ observedAt })), /核对日期/, observedAt);
  }
});

// SKIN-MODEL-7 B: the admin quality picker matches the server guard.
test("SK7 quality options offer enabled entries, keep only the current disabled binding, and never default", () => {
  const rarities = [
    { id: "r1", code: "q_enabled", name: "品质甲", sortOrder: 0, enabled: true },
    { id: "r2", code: "q_retired", name: "品质乙", sortOrder: 1, enabled: false },
  ];
  assert.deepEqual(rarityOptions(rarities, null), [{ value: "", label: "品质未知（不默认）" }, { value: "q_enabled", label: "品质甲" }]);
  assert.deepEqual(rarityOptions(rarities, "q_enabled").map((o) => o.value), ["", "q_enabled"]);
  assert.deepEqual(rarityOptions(rarities, "q_retired"), [{ value: "", label: "品质未知（不默认）" }, { value: "q_enabled", label: "品质甲" }, { value: "q_retired", label: "品质乙（已停用，仅保留现有绑定）" }]);
  assert.deepEqual(rarityOptions([], undefined), [{ value: "", label: "品质未知（不默认）" }], "an empty vocabulary leaves quality unknown");
});

const oldSkin = () => ({ id: "skin_fixture", code: "fixture", name: "旧词条", categoryId: "cat_fixture", rarityCode: "quality_retired", namingState: "VERIFIED", baseName: "外观", ownerRef: { kind: "AGENT", id: "agent_fixture" }, enabled: true, formVisible: true, sortOrder: 0, aliases: [], sourceNamespace: null, mediaId: null });
const valuesFor = skin => ({ ...Object.fromEntries(Object.entries(skin).filter(([key]) => ["name", "categoryId", "rarityCode", "enabled", "formVisible", "sortOrder"].includes(key)).map(([key, value]) => [key, String(value)])), ...skinValues(skin) });

test("skin metadata preserves unknown and historic quality during unrelated edits", () => {
  const skin = oldSkin(), values = valuesFor(skin);
  values.aliases = "旧名别名";
  assert.deepEqual(skinPayload(values, "1235", skin), { expectedCatalogRevision: "1235", aliases: ["旧名别名"] });
  values.isCollectible = "false"; values.defaultState = "NON_DEFAULT"; values.reason = "按平台资料核实";
  const body = skinPayload(values, "1235", skin);
  assert.equal(body.isCollectible, false); assert.equal(body.defaultState, "NON_DEFAULT");
  assert.equal(Object.hasOwn(body, "rarityEvidence"), false);
  values.isCollectible = "unknown"; values.defaultState = "UNKNOWN";
  assert.equal(Object.hasOwn(skinPayload(values, "1235", skin), "isCollectible"), false);
});

test("relabeling quality requires its separate evidence without upgrading platform references to official", () => {
  const skin = oldSkin(), values = { ...valuesFor(skin), rarityCode: "quality_new", reason: "对照平台品质" };
  assert.throws(() => skinPayload(values, "1235", skin), /品质依据/);
  Object.assign(values, { rarityBasis: "PLATFORM_REFERENCE", raritySourceName: "合成平台参考", rarityEvidenceUrls: "https://example.org/quality", rarityObservedAt: "2026-10-20", rarityNote: "合成品质证据" });
  const body = skinPayload(values, "1235", skin);
  assert.equal(body.rarityEvidence.basis, "PLATFORM_REFERENCE");
  assert.equal(Object.hasOwn(body, "confirmIdentity"), false);
  values.rarityCode = "";
  assert.equal(skinPayload(values, "1235", skin).rarityEvidence, null);
});

test("quality and media source names match the server's 100-character boundary", () => {
  const skin = { ...oldSkin(), mediaId: "media_fixture" }, name = "源".repeat(100);
  const values = { ...valuesFor(skin), reason: "合成来源边界", changeRarityEvidence: "true", rarityBasis: "PLATFORM_REFERENCE", raritySourceName: name, rarityEvidenceUrls: "https://example.org/quality", rarityObservedAt: "2026-10-20", rarityNote: "合成证据", changeMediaSource: "true", mediaSourceKind: "MODEL_IMAGE", mediaSourceName: name, mediaSourceUrl: "https://example.org/model.webp" };
  const body = skinPayload(values, "1235", skin);
  assert.equal(body.rarityEvidence.sourceName, name); assert.equal(body.mediaSource.sourceName, name);
  for (const key of ["raritySourceName", "mediaSourceName"]) assert.throws(() => skinPayload({ ...values, [key]: "源".repeat(101) }, "1235", skin), /最多100个字符/);
});

test("a verified melee category needs no invented concrete owner; other types still require owners", () => {
  const skin = { ...oldSkin(), namingState: "PENDING", ownerRef: null }, values = { ...valuesFor(skin), ownerKind: "MELEE_TYPE", ownerId: "", baseName: "合成近战", ...evidence() };
  const body = skinPayload(values, "1235", skin, true);
  assert.equal(body.ownerKind, "MELEE_TYPE"); assert.equal(body.ownerRef, null);
  for (const ownerKind of ["AGENT", "FIREARM"]) assert.throws(() => skinPayload({ ...values, ownerKind }, "1235", skin, true), /所属对象/);
});

test("media provenance is explicit and never becomes a hotlinked image binding", () => {
  const skin = { ...oldSkin(), mediaId: "media_fixture" }, values = { ...valuesFor(skin), reason: "记录来源", changeMediaSource: "true", mediaSourceKind: "PORTRAIT_CARD", mediaSourceName: "合成图库", mediaSourceUrl: "https://example.org/card.webp" };
  const body = skinPayload(values, "1235", skin);
  assert.equal(body.mediaSource.kind, "PORTRAIT_CARD"); assert.equal(Object.hasOwn(body, "mediaId"), false);
  for (const mediaSourceUrl of ["http://example.org/a", "https://name:pass@example.org/a", "not-url"]) assert.throws(() => skinPayload({ ...values, mediaSourceUrl }, "1235", skin), /HTTPS/);
  const previous = { ...skin, mediaId: "old_media", mediaSource: { schema: "skin-media-source-v1", kind: "MODEL_IMAGE", sourceName: "旧来源", url: "https://example.org/old" } };
  assert.equal(skinPayload({ ...valuesFor(previous), mediaId: "new_media", reason: "替换图片，来源待补" }, "1235", previous).mediaSource, null, "replacement cannot retain the old image's provenance as the new source");
  assert.equal(skinPayload({ ...valuesFor(previous), mediaId: "", reason: "解除图片及来源" }, "1235", previous).mediaSource, null, "unbinding still explicitly clears the previous source");
});

test("unbound new and existing skins reject a source locally while an existing bound skin accepts it", () => {
  const skin = oldSkin(), source = { changeMediaSource: "true", mediaSourceKind: "MODEL_IMAGE", mediaSourceName: "合成图库", mediaSourceUrl: "https://example.org/model.webp", reason: "合成来源关联" };
  const create = { ...skinValues(), code: "new_skin", name: "合成新词条", categoryId: "cat_fixture", rarityCode: "", sortOrder: "0", ...source };
  assert.throws(() => skinPayload(create, "1235"), /先保存词条并绑定平台图片/);
  assert.throws(() => skinPayload({ ...valuesFor(skin), ...source }, "1235", skin), /先保存词条并绑定平台图片/);
  const body = skinPayload({ ...valuesFor(skin), ...source, mediaId: "new_platform_media" }, "1235", skin);
  assert.equal(body.mediaId, "new_platform_media"); assert.equal(body.mediaSource.sourceName, "合成图库");
});

test("selectable state includes category ancestors and does not equate identity with official quality", () => {
  const skin = oldSkin(), catalog = { game: { enabled: true }, categories: [{ id: "cat_fixture", parentId: "parent", enabled: true, formVisible: true }, { id: "parent", parentId: null, enabled: true, formVisible: true }] };
  assert.equal(skinIsSelectable(skin, catalog), true);
  catalog.categories[1].formVisible = false; assert.equal(skinIsSelectable(skin, catalog), false);
  catalog.categories[1].formVisible = true; catalog.categories[1].parentId = "cat_fixture"; assert.equal(skinIsSelectable(skin, catalog), false);
  assert.equal(skinRarityBasisText(skin), "品质依据待补");
  assert.equal(skinRarityBasisText({ ...skin, rarityEvidence: { basis: "PLATFORM_REFERENCE" } }), "平台参考");
});
