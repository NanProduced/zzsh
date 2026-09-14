import { strict as assert } from "node:assert";
import type { Pool } from "pg";

type CookieJar = { values: Map<string, string>; update: (response: Response) => void; header: () => string };
type RequestResult = { response: Response; body: Record<string, any> | null };
type Requester = (
  base: string,
  path: string,
  body: Record<string, unknown> | undefined,
  jar: CookieJar,
  origin: string,
  method?: string,
  extraHeaders?: Record<string, string>,
) => Promise<RequestResult>;
type MediaUploader = (base: string, path: string, jar: CookieJar, origin: string, token: string) => Promise<{ status: number; body: Record<string, any> | null }>;

type Input = {
  base: string;
  gameId: string;
  boss: CookieJar;
  bossId: string;
  user: CookieJar;
  operator: CookieJar;
  gunsmithOnly: CookieJar;
  catalogOnly: CookieJar;
  request: Requester;
  key: () => Record<string, string>;
  adminOrigin: string;
  apiOrigin: string;
  userOrigin: string;
  pool: Pool;
  uploadBytes: MediaUploader;
  mediaBytes: () => Buffer;
};

function anonymousJar(): CookieJar {
  return { values: new Map(), update: () => undefined, header: () => "" };
}

export async function runGunsmithChecks(input: Input): Promise<{ firearmId: string }> {
  const { base, gameId, boss, bossId, user, operator, gunsmithOnly, catalogOnly, request, key, adminOrigin, apiOrigin, userOrigin, pool, uploadBytes, mediaBytes } = input;
  const adminGames = await request(base, "/api/bff/admin/supply/games", undefined, operator, adminOrigin);
  assert.equal(adminGames.response.status, 200, JSON.stringify(adminGames.body));
  const initialService = adminGames.body?.games?.find((game: { id: string }) => game.id === gameId)?.services?.find((service: { serviceCode: string }) => service.serviceCode === "GUNSMITH");
  assert.equal(initialService?.supported, true);
  assert.equal(initialService?.enabled, false);

  const gunsmithOnlyGames = await request(base, "/api/bff/admin/supply/games", undefined, gunsmithOnly, adminOrigin);
  assert.equal(gunsmithOnlyGames.response.status, 200, JSON.stringify(gunsmithOnlyGames.body));
  assert.equal(gunsmithOnlyGames.body?.games?.some((game: { id: string }) => game.id === gameId), true);

  const empty = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, operator, adminOrigin);
  assert.equal(empty.response.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body?.firearms, []);
  const gunsmithOnlyFirearms = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, gunsmithOnly, adminOrigin);
  assert.equal(gunsmithOnlyFirearms.response.status, 200, JSON.stringify(gunsmithOnlyFirearms.body));
  assert.deepEqual(gunsmithOnlyFirearms.body?.firearms, []);
  const withoutGunsmithPermission = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, catalogOnly, adminOrigin);
  assert.equal(withoutGunsmithPermission.response.status, 403);

  const invalidSourceNamespace = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, {
    code: "invalid-source-namespace",
    name: "非法来源命名空间",
    sourceNamespace: "community-candidate",
    sourceToken: "1",
  }, operator, adminOrigin, "POST", key());
  assert.equal(invalidSourceNamespace.response.status, 400, JSON.stringify(invalidSourceNamespace.body));

  const classification = await request(base, `/api/bff/admin/supply/games/${gameId}/firearm-classifications`, {
    code: "assault_rifle",
    name: "突击步枪",
    sourceNamespace: "community:delta_classification",
    sourceToken: "candidate-assault-rifle",
  }, operator, adminOrigin, "POST", key());
  assert.equal(classification.response.status, 200, JSON.stringify(classification.body));
  const classificationId = classification.body?.id as string;
  assert.ok(classificationId);

  const firearm = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, {
    code: "m4a1",
    name: "M4A1",
    classificationId,
    sourceNamespace: "legacy_mysql:la_gun",
    sourceToken: "9001",
  }, operator, adminOrigin, "POST", key());
  assert.equal(firearm.response.status, 200, JSON.stringify(firearm.body));
  const firearmId = firearm.body?.id as string;
  assert.ok(firearmId);

  const alias = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms/${firearmId}/aliases`, {
    locale: "zh-CN",
    name: "M4A1 突击步枪",
    sourceNamespace: "community:delta_alias",
    sourceToken: "m4a1-alias-9001",
  }, operator, adminOrigin, "POST", key());
  assert.equal(alias.response.status, 200, JSON.stringify(alias.body));

  const code = await request(base, "/api/bff/admin/supply/gunsmith/codes", {
    gameId,
    firearmId,
    code: "M4A1-TEST-OPAQUE-CODE-001",
    note: "合成核验码",
    modeCode: "HAZARD",
    sourceNamespace: "community:delta_gunsmith_code",
    sourceToken: "m4a1-code-001",
  }, operator, adminOrigin, "POST", key());
  assert.equal(code.response.status, 200, JSON.stringify(code.body));
  const codeId = code.body?.id as string;
  assert.ok(codeId);

  const hidden = await request(base, "/api/v1/supply/gunsmith/games", undefined, anonymousJar(), apiOrigin);
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.body?.games?.some((game: { id: string }) => game.id === gameId), false);

  const enabledService = await request(base, `/api/bff/admin/supply/games/${gameId}/services/GUNSMITH`, { expectedRevision: "1", enabled: true }, operator, adminOrigin, "PUT", key());
  assert.equal(enabledService.response.status, 200, JSON.stringify(enabledService.body));

  const publicGames = await request(base, "/api/v1/supply/gunsmith/games", undefined, anonymousJar(), apiOrigin);
  assert.equal(publicGames.response.status, 200);
  assert.equal(publicGames.body?.games?.some((game: { id: string }) => game.id === gameId), true);

  const publicFirearms = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms?q=${encodeURIComponent("M4A1")}&classificationId=${encodeURIComponent(classificationId)}`, undefined, anonymousJar(), apiOrigin);
  assert.equal(publicFirearms.response.status, 200, JSON.stringify(publicFirearms.body));
  assert.equal(publicFirearms.body?.items?.length, 1);
  assert.equal(publicFirearms.body?.items[0]?.name, "M4A1");
  assert.equal(publicFirearms.body?.items[0]?.classificationName, "突击步枪");
  assert.match(String(publicFirearms.body?.items[0]?.updatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.equal(Object.hasOwn(publicFirearms.body?.items[0] ?? {}, "revision"), false);
  assert.equal(Object.hasOwn(publicFirearms.body?.items[0] ?? {}, "sourceToken"), false);

  const publicCodes = await request(base, `/api/v1/supply/gunsmith/firearms/${firearmId}/codes`, undefined, anonymousJar(), apiOrigin);
  assert.equal(publicCodes.response.status, 200, JSON.stringify(publicCodes.body));
  assert.equal(publicCodes.body?.items[0]?.code, "M4A1-TEST-OPAQUE-CODE-001");
  assert.equal(publicCodes.body?.items[0]?.modeCode, "HAZARD");
  assert.match(String(publicCodes.body?.items[0]?.updatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  const publicCodeJson = JSON.stringify(publicCodes.body);
  assert.equal(publicCodeJson.includes("sourceToken"), false);
  assert.equal(publicCodeJson.includes('"revision"'), false);
  assert.equal(publicCodeJson.includes('"status"'), false);

  const secondFirearm = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, {
    code: "m16",
    name: "M16",
    classificationId,
  }, operator, adminOrigin, "POST", key());
  assert.equal(secondFirearm.response.status, 200, JSON.stringify(secondFirearm.body));
  const secondFirearmId = secondFirearm.body?.id as string;
  const sortedSecondFirearm = await request(base, `/api/bff/admin/supply/firearms/${secondFirearmId}`, {
    expectedRevision: secondFirearm.body?.revision,
    sortOrder: -1,
  }, operator, adminOrigin, "PUT", key());
  assert.equal(sortedSecondFirearm.response.status, 200, JSON.stringify(sortedSecondFirearm.body));
  const concurrentRevision = sortedSecondFirearm.body?.revision as string;
  const concurrentUpdates = await Promise.all([
    request(base, `/api/bff/admin/supply/firearms/${secondFirearmId}`, { expectedRevision: concurrentRevision, name: "M16 竞态 A" }, operator, adminOrigin, "PUT", key()),
    request(base, `/api/bff/admin/supply/firearms/${secondFirearmId}`, { expectedRevision: concurrentRevision, name: "M16 竞态 B" }, operator, adminOrigin, "PUT", key()),
  ]);
  assert.deepEqual(concurrentUpdates.map((result) => result.response.status).sort((left, right) => left - right), [200, 409]);
  const duplicateCode = await request(base, "/api/bff/admin/supply/gunsmith/codes", {
    gameId,
    firearmId: secondFirearmId,
    code: "M4A1-TEST-OPAQUE-CODE-001",
  }, operator, adminOrigin, "POST", key());
  assert.equal(duplicateCode.response.status, 409, JSON.stringify(duplicateCode.body));
  const secondCode = await request(base, "/api/bff/admin/supply/gunsmith/codes", {
    gameId,
    firearmId: secondFirearmId,
    code: "M16-TEST-OPAQUE-CODE-001",
  }, operator, adminOrigin, "POST", key());
  assert.equal(secondCode.response.status, 200, JSON.stringify(secondCode.body));

  const sameSourceDifferentCode = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, {
    code: "m4a1-source-duplicate",
    name: "M4A1 来源重复候选",
    sourceNamespace: "legacy_mysql:la_gun",
    sourceToken: "9001",
  }, operator, adminOrigin, "POST", key());
  assert.equal(sameSourceDifferentCode.response.status, 409, JSON.stringify(sameSourceDifferentCode.body));
  assert.match(String(sameSourceDifferentCode.body?.error?.message), /source mapping/i);

  const sameNumericDifferentEntity = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, {
    code: "other-source-entity",
    name: "同数字不同来源实体",
    sourceNamespace: "legacy_mysql:la_other_gun",
    sourceToken: "9001",
  }, operator, adminOrigin, "POST", key());
  assert.equal(sameNumericDifferentEntity.response.status, 200, JSON.stringify(sameNumericDifferentEntity.body));

  const concurrentSourceCreates = await Promise.all([
    request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, { code: "concurrent-source-a", name: "并发来源 A", sourceNamespace: "legacy_mysql:la_gun", sourceToken: "9002" }, operator, adminOrigin, "POST", key()),
    request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, { code: "concurrent-source-b", name: "并发来源 B", sourceNamespace: "legacy_mysql:la_gun", sourceToken: "9002" }, operator, adminOrigin, "POST", key()),
  ]);
  assert.deepEqual(concurrentSourceCreates.map((result) => result.response.status).sort((left, right) => left - right), [200, 409]);
  const sortedPageOne = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms?limit=1`, undefined, anonymousJar(), apiOrigin);
  assert.equal(sortedPageOne.response.status, 200, JSON.stringify(sortedPageOne.body));
  assert.equal(sortedPageOne.body?.items?.[0]?.id, secondFirearmId);
  assert.ok(sortedPageOne.body?.nextCursor);
  const sortedPageTwo = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms?limit=1&cursor=${encodeURIComponent(sortedPageOne.body?.nextCursor)}`, undefined, anonymousJar(), apiOrigin);
  assert.equal(sortedPageTwo.response.status, 200, JSON.stringify(sortedPageTwo.body));
  assert.equal(sortedPageTwo.body?.items?.[0]?.id, firearmId);
  const firearmCursorMismatch = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms?limit=2&cursor=${encodeURIComponent(sortedPageOne.body?.nextCursor)}`, undefined, anonymousJar(), apiOrigin);
  assert.equal(firearmCursorMismatch.response.status, 409);

  const withdrawn = await request(base, `/api/bff/admin/supply/gunsmith/codes/${codeId}/withdraw`, { expectedRevision: "1" }, operator, adminOrigin, "POST", key());
  assert.equal(withdrawn.response.status, 200, JSON.stringify(withdrawn.body));
  const noActiveFirearm = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms`, undefined, anonymousJar(), apiOrigin);
  assert.equal(noActiveFirearm.response.status, 200);
  assert.equal(
    noActiveFirearm.body?.items?.some((entry: { id: string }) => entry.id === firearmId),
    false,
  );
  const history = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, operator, adminOrigin);
  assert.equal(history.response.status, 200);
  assert.equal(history.body?.codes?.find((entry: { id: string }) => entry.id === codeId)?.status, "WITHDRAWN");

  const restored = await request(base, `/api/bff/admin/supply/gunsmith/codes/${codeId}/restore`, { expectedRevision: "2" }, operator, adminOrigin, "POST", key());
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));

  const disabledService = await request(base, `/api/bff/admin/supply/games/${gameId}/services/GUNSMITH`, { expectedRevision: "2", enabled: false }, operator, adminOrigin, "PUT", key());
  assert.equal(disabledService.response.status, 200, JSON.stringify(disabledService.body));
  const unavailable = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms`, undefined, anonymousJar(), apiOrigin);
  assert.equal(unavailable.response.status, 404);
  const historyWhileDisabled = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, operator, adminOrigin);
  assert.equal(historyWhileDisabled.response.status, 200, "admin history read must survive public service disable");
  const blockedCreate = await request(base, "/api/bff/admin/supply/gunsmith/codes", { gameId, firearmId, code: "M4A1-SERVICE-OFF-CODE" }, operator, adminOrigin, "POST", key());
  assert.equal(blockedCreate.response.status, 200, "supported catalog data may be prepared while public service is off");
  const stillHidden = await request(base, `/api/v1/supply/gunsmith/firearms/${firearmId}/codes`, undefined, anonymousJar(), apiOrigin);
  assert.equal(stillHidden.response.status, 404, "service-off catalog must remain private");

  const enabledAgain = await request(base, `/api/bff/admin/supply/games/${gameId}/services/GUNSMITH`, { expectedRevision: "3", enabled: true }, operator, adminOrigin, "PUT", key());
  assert.equal(enabledAgain.response.status, 200, JSON.stringify(enabledAgain.body));

  const codePageOne = await request(base, `/api/v1/supply/gunsmith/firearms/${firearmId}/codes?limit=1`, undefined, anonymousJar(), apiOrigin);
  assert.equal(codePageOne.response.status, 200, JSON.stringify(codePageOne.body));
  assert.equal(codePageOne.body?.items?.length, 1);
  assert.match(String(codePageOne.body?.items?.[0]?.updatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.ok(codePageOne.body?.nextCursor);
  const codePageTwo = await request(base, `/api/v1/supply/gunsmith/firearms/${firearmId}/codes?limit=1&cursor=${encodeURIComponent(codePageOne.body?.nextCursor)}`, undefined, anonymousJar(), apiOrigin);
  assert.equal(codePageTwo.response.status, 200, JSON.stringify(codePageTwo.body));
  assert.equal(codePageTwo.body?.items?.length, 1);
  assert.notEqual(codePageTwo.body?.items?.[0]?.id, codePageOne.body?.items?.[0]?.id);
  assert.equal(codePageTwo.body?.nextCursor, null);
  const codeCursorMismatch = await request(base, `/api/v1/supply/gunsmith/firearms/${firearmId}/codes?limit=2&cursor=${encodeURIComponent(codePageOne.body?.nextCursor)}`, undefined, anonymousJar(), apiOrigin);
  assert.equal(codeCursorMismatch.response.status, 409);

  const mediaIntent = await request(base, "/api/bff/admin/supply/media/upload-intents", { gameId, purpose: "FIREARM_MEDIA", mime: "image/png", size: mediaBytes().length }, operator, adminOrigin, "POST", key());
  assert.equal(mediaIntent.response.status, 200, JSON.stringify(mediaIntent.body));
  const mediaUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${mediaIntent.body?.intentId}`, operator, adminOrigin, mediaIntent.body?.uploadToken as string);
  assert.equal(mediaUpload.status, 200, JSON.stringify(mediaUpload.body));
  const firearmMediaId = mediaUpload.body?.assetId as string;
  const mediaReview = await request(base, `/api/bff/admin/supply/media/${firearmMediaId}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, operator, adminOrigin, "POST", key());
  assert.equal(mediaReview.response.status, 200, JSON.stringify(mediaReview.body));
  const mediaOptions = await request(base, `/api/bff/admin/supply/games/${gameId}/media-options?purpose=FIREARM_MEDIA`, undefined, operator, adminOrigin);
  assert.equal(mediaOptions.response.status, 200, JSON.stringify(mediaOptions.body));
  assert.equal(mediaOptions.body?.items?.some((entry: { id: string }) => entry.id === firearmMediaId), true);
  const gunsmithOnlyMediaOptions = await request(base, `/api/bff/admin/supply/games/${gameId}/media-options?purpose=FIREARM_MEDIA`, undefined, gunsmithOnly, adminOrigin);
  assert.equal(gunsmithOnlyMediaOptions.response.status, 200, JSON.stringify(gunsmithOnlyMediaOptions.body));
  assert.equal(gunsmithOnlyMediaOptions.body?.items?.some((entry: { id: string }) => entry.id === firearmMediaId), true);
  const gunsmithOnlyUpload = await request(base, "/api/bff/admin/supply/media/upload-intents", { gameId, purpose: "FIREARM_MEDIA", mime: "image/png", size: mediaBytes().length }, gunsmithOnly, adminOrigin, "POST", key());
  assert.equal(gunsmithOnlyUpload.response.status, 403, "gunsmith.manage may select and bind approved media but may not upload it");
  const firearmBeforeMedia = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, operator, adminOrigin);
  const mediaRevision = firearmBeforeMedia.body?.firearms?.find((entry: { id: string }) => entry.id === firearmId)?.revision as string;
  assert.ok(mediaRevision);
  const boundMedia = await request(base, `/api/bff/admin/supply/firearms/${firearmId}`, { expectedRevision: mediaRevision, mediaId: firearmMediaId }, gunsmithOnly, adminOrigin, "PUT", key());
  assert.equal(boundMedia.response.status, 200, JSON.stringify(boundMedia.body));
  const publicWithMedia = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms`, undefined, anonymousJar(), apiOrigin);
  assert.equal(publicWithMedia.response.status, 200);
  assert.equal(publicWithMedia.body?.items?.find((entry: { id: string }) => entry.id === firearmId)?.mediaId, firearmMediaId);
  const revokedMedia = await request(base, `/api/bff/admin/supply/media/${firearmMediaId}/visibility`, { visibility: "PRIVATE_REVIEW", reason: "撤销合成枪械图" }, operator, adminOrigin, "POST", key());
  assert.equal(revokedMedia.response.status, 200, JSON.stringify(revokedMedia.body));
  assert.equal((await pool.query(`SELECT media_id FROM zzsh_supply.firearm WHERE id=$1`, [firearmId])).rows[0]?.media_id, null);
  const publicAfterMediaRevoke = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms`, undefined, anonymousJar(), apiOrigin);
  assert.equal(publicAfterMediaRevoke.body?.items?.find((entry: { id: string }) => entry.id === firearmId)?.mediaId, null);
  const revokedContent = await request(base, `/api/v1/supply/media/${firearmMediaId}/content`, undefined, anonymousJar(), apiOrigin);
  assert.equal(revokedContent.response.status, 404);
  const firearmAfterMedia = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, operator, adminOrigin);
  const enabledRevision = firearmAfterMedia.body?.firearms?.find((entry: { id: string }) => entry.id === firearmId)?.revision as string;
  const secondEnabledRevision = firearmAfterMedia.body?.firearms?.find((entry: { id: string }) => entry.id === secondFirearmId)?.revision as string;
  const disabledSecondFirearm = await request(base, `/api/bff/admin/supply/firearms/${secondFirearmId}`, { expectedRevision: secondEnabledRevision, enabled: false }, operator, adminOrigin, "PUT", key());
  assert.equal(disabledSecondFirearm.response.status, 200, JSON.stringify(disabledSecondFirearm.body));
  const disabledFirearm = await request(base, `/api/bff/admin/supply/firearms/${firearmId}`, { expectedRevision: enabledRevision, enabled: false }, operator, adminOrigin, "PUT", key());
  assert.equal(disabledFirearm.response.status, 200, JSON.stringify(disabledFirearm.body));
  const noEnabledFirearm = await request(base, `/api/v1/supply/gunsmith/games/${gameId}/firearms`, undefined, anonymousJar(), apiOrigin);
  assert.equal(noEnabledFirearm.body?.items?.length, 0);
  const disabledHistory = await request(base, `/api/bff/admin/supply/games/${gameId}/firearms`, undefined, operator, adminOrigin);
  assert.equal(disabledHistory.body?.firearms?.find((entry: { id: string }) => entry.id === firearmId)?.enabled, false);
  const reenabledFirearm = await request(base, `/api/bff/admin/supply/firearms/${firearmId}`, { expectedRevision: disabledFirearm.body?.revision, enabled: true }, operator, adminOrigin, "PUT", key());
  assert.equal(reenabledFirearm.response.status, 200, JSON.stringify(reenabledFirearm.body));

  const otherGame = await request(base, "/api/bff/admin/supply/games", { code: "future_game", name: "未实现第二游戏" }, boss, adminOrigin, "POST", key());
  assert.equal(otherGame.response.status, 200, JSON.stringify(otherGame.body));
  const otherGameId = otherGame.body?.game?.id as string;
  assert.ok(otherGameId);
  const futureItem = await request(base, `/api/bff/admin/supply/games/${otherGameId}/items`, { code: "future_item", name: "未来游戏物品", unit: "PIECE" }, boss, adminOrigin, "POST", key());
  assert.equal(futureItem.response.status, 200, JSON.stringify(futureItem.body));
  const futurePrice = await request(base, "/api/bff/admin/supply/price-drafts", { gameId: otherGameId, mode: "SPREAD" }, boss, adminOrigin, "POST", key());
  assert.equal(futurePrice.response.status, 200, JSON.stringify(futurePrice.body));
  const futurePriceId = futurePrice.body?.id as string;
  const futurePriceUpdated = await request(base, `/api/bff/admin/supply/price-drafts/${futurePriceId}`, {
    expectedRevision: "1",
    lines: [{ itemId: futureItem.body?.id, pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "1", ownerUnitAmount: "1" }],
  }, boss, adminOrigin, "PUT", key());
  assert.equal(futurePriceUpdated.response.status, 200, JSON.stringify(futurePriceUpdated.body));
  const futureTerm = await request(base, "/api/bff/admin/supply/term-drafts", { gameId: otherGameId }, boss, adminOrigin, "POST", key());
  assert.equal(futureTerm.response.status, 200, JSON.stringify(futureTerm.body));
  const futureTermId = futureTerm.body?.id as string;
  const futureTermUpdated = await request(base, `/api/bff/admin/supply/term-drafts/${futureTermId}`, { expectedRevision: "1", options: [{ code: "future-day", name: "未来日租", dailyConsumption: "1" }] }, boss, adminOrigin, "PUT", key());
  assert.equal(futureTermUpdated.response.status, 200, JSON.stringify(futureTermUpdated.body));
  const futureAgreement = await request(base, "/api/bff/admin/supply/agreement-drafts", { gameId: otherGameId, title: "未来游戏租赁协议", body: "未来游戏租赁协议合成正文。" }, boss, adminOrigin, "POST", key());
  assert.equal(futureAgreement.response.status, 200, JSON.stringify(futureAgreement.body));
  const futureAgreementId = futureAgreement.body?.id as string;
  for (const [path, expectedRevision] of [[`/api/bff/admin/supply/price-drafts/${futurePriceId}/seal`, "2"], [`/api/bff/admin/supply/term-drafts/${futureTermId}/seal`, "2"], [`/api/bff/admin/supply/agreement-drafts/${futureAgreementId}/seal`, "1"]] as const) {
    const sealed = await request(base, path, { expectedRevision }, boss, adminOrigin, "POST", key());
    assert.equal(sealed.response.status, 200, JSON.stringify(sealed.body));
  }
  const futureRelease = await request(base, "/api/bff/admin/supply/releases", { gameId: otherGameId, priceVersionId: futurePriceId, termVersionId: futureTermId, agreementVersionId: futureAgreementId, expectedGeneration: "0" }, boss, adminOrigin, "POST", key());
  assert.equal(futureRelease.response.status, 200, JSON.stringify(futureRelease.body));
  const futureRules = await request(base, `/api/bff/admin/supply/games/${otherGameId}/rules`, undefined, boss, adminOrigin);
  assert.equal(futureRules.response.status, 200);
  assert.ok(futureRules.body?.game?.currentReleaseId, "the unsupported game has a complete active rental release for the gate test");
  const publicRentalGames = await request(base, "/api/v1/supply/games", undefined, anonymousJar(), apiOrigin);
  assert.equal(publicRentalGames.response.status, 200);
  assert.equal(publicRentalGames.body?.games?.some((game: { id: string }) => game.id === otherGameId), false);
  const unsupportedPublishingOptions = await request(base, `/api/v1/supply/games/${otherGameId}/publishing-options`, undefined, anonymousJar(), apiOrigin);
  assert.equal(unsupportedPublishingOptions.response.status, 404);
  const unsupportedAccount = await request(base, "/api/v1/supply/accounts", { gameId: otherGameId }, user, userOrigin, "POST", key());
  assert.equal(unsupportedAccount.response.status, 409);
  const unsupportedRentalEnable = await request(base, `/api/bff/admin/supply/games/${otherGameId}/services/ACCOUNT_RENTAL`, { expectedRevision: "1", enabled: true }, boss, adminOrigin, "PUT", key());
  assert.equal(unsupportedRentalEnable.response.status, 409);
  const unsupportedEnable = await request(base, `/api/bff/admin/supply/games/${otherGameId}/services/GUNSMITH`, { expectedRevision: "1", enabled: true }, boss, adminOrigin, "PUT", key());
  assert.equal(unsupportedEnable.response.status, 409);
  const unsupportedCreate = await request(base, `/api/bff/admin/supply/games/${otherGameId}/firearm-classifications`, { code: "unsupported", name: "未实现分类" }, boss, adminOrigin, "POST", key());
  assert.equal(unsupportedCreate.response.status, 409);

  const otherClassificationId = "synthetic_other_classification";
  await pool.query(`INSERT INTO "zzsh_supply"."firearm_classification" ("id", "game_id", "code", "name") VALUES ($1,$2,'synthetic','合成未实现分类')`, [otherClassificationId, otherGameId]);
  const historicalFirearmId = "synthetic_unsupported_firearm";
  const historicalCodeId = "synthetic_unsupported_code";
  await pool.query(`INSERT INTO "zzsh_supply"."firearm" ("id", "game_id", "code", "name", "classification_id") VALUES ($1,$2,'historical_firearm','未适配历史枪械',$3)`, [historicalFirearmId, otherGameId, otherClassificationId]);
  await pool.query(`INSERT INTO "zzsh_supply"."gunsmith_code" ("id", "game_id", "firearm_id", "code", "created_by_admin_id", "updated_by_admin_id") VALUES ($1,$2,$3,'HISTORICAL-UNSUPPORTED-CODE',$4,$4)`, [historicalCodeId, otherGameId, historicalFirearmId, bossId]);
  const unsupportedHistory = await request(base, `/api/bff/admin/supply/games/${otherGameId}/firearms`, undefined, boss, adminOrigin);
  assert.equal(unsupportedHistory.response.status, 200);
  assert.equal(unsupportedHistory.body?.codes?.find((entry: { id: string }) => entry.id === historicalCodeId)?.status, "ACTIVE");
  const historicalDisabled = await request(base, `/api/bff/admin/supply/firearms/${historicalFirearmId}`, { expectedRevision: "1", enabled: false }, boss, adminOrigin, "PUT", key());
  assert.equal(historicalDisabled.response.status, 200, JSON.stringify(historicalDisabled.body));
  const historicalWithdrawn = await request(base, `/api/bff/admin/supply/gunsmith/codes/${historicalCodeId}/withdraw`, { expectedRevision: "1" }, boss, adminOrigin, "POST", key());
  assert.equal(historicalWithdrawn.response.status, 200, JSON.stringify(historicalWithdrawn.body));
  const unsupportedPublic = await request(base, `/api/v1/supply/gunsmith/firearms/${historicalFirearmId}/codes`, undefined, anonymousJar(), apiOrigin);
  assert.equal(unsupportedPublic.response.status, 404);
  const crossGameFirearmId = "synthetic_cross_game_firearm";
  await assert.rejects(
    () => pool.query(`INSERT INTO "zzsh_supply"."firearm" ("id", "game_id", "code", "name", "classification_id") VALUES ($1,$2,'synthetic_cross','跨游戏非法关系',$3)`, [crossGameFirearmId, gameId, otherClassificationId]),
    (error: { code?: string }) => error.code === "23503",
  );
  assert.equal((await pool.query(`SELECT 1 FROM "zzsh_supply"."firearm" WHERE "id"=$1`, [crossGameFirearmId])).rowCount, 0);
  return { firearmId };
}
