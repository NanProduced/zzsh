import { projectDeltaQuote, type ProjectedQuote } from "./pricing";
import { DELTA_CUSTOM_DAILY_CONSUMPTION, DELTA_INFO_SOURCE_DICTIONARY, DELTA_PUBLISH_LEVELS, deltaPublicationLevels } from "./delta-rental";
import { formatDecimalExact, parseSignedDecimal } from "./decimal";
import { listSupervision, parseSupervisionQuery, readSupervision, supervisionViewer } from "./admin-supervision-read";
import { loadLegacyHistoricalRead, loadLegacyHistoricalReads, withoutLegacyResourceNo } from "./legacy-listing-read";
import { publicAccountNumber } from "./account-number";
import { listOwnerAccounts, parseOwnerAccountQuery, projectOwnerAccount } from "./owner-account-list";
import { listV2 } from "./listing-filter-routes";
import { lookupPublicListing, parseNumberLookupQuery } from "./public-listing-lookup";
import { candidatePredicates,PUBLIC_CANDIDATE_FROM,PUBLIC_CANDIDATE_WHERE } from "./listing-candidates";
import type { PoolClient } from "pg";
import { assertGameScopeUsable, gameScopeSql, readAdminGameScope } from "../auth/admin-scope";
import { readAdminContext, assertAdminContextInTransaction } from "../auth/auth-security";
import {
  loadEffectiveAdminAccess,
  hasPermission,
  requirePermission,
} from "../auth/admin-authorization";
import {
  readUserContext,
  assertUserContextInTransaction,
} from "../auth/user-identity";
import {
  recordAudit,
  SecurityApiError,
  setAuditContext,
  withTransaction,
} from "../auth/security-core";
import { API_V1_ERROR_CODES, validateIdempotencyKey } from "../contracts/api-v1";
import { OWNER_INCOME_PREVIEW_MAX_BYTES, parseOwnerIncomePreviewInput, readOwnerIncomePreview } from "./owner-income-preview";
import type { SupplyRuntimeOptions } from "./supply-routes";
import { GAME_SERVICE, requirePublicGameService } from "./game-services";
import { loadMediaAsset } from "./media";
import {
  assertGameScope,
  bodyOf,
  conflict,
  ensureOnlyFields,
  fingerprintRequest,
  forbidden,
  headerValue,
  invalid,
  newSupplyId,
  notFound,
  sendJson,
  sha256Hex,
  withIdempotency,
  type SupplyNodeRequest,
  type SupplyNodeResponse,
} from "./supply-util";
import {
  EFFECTIVE_PUBLICATION_STATE_SQL,
  isAccountDisplayPubliclyEligible,
  parsePublicListingSearch,
  publicGradingOptions,
  publicLoginMethodOptions,
  publicSafeBoxOptions,
  publicSafeBoxCodes,
} from "./listing-query";
import {
  acceptListingRules,
  checkAccountRevision,
  createListingDraft,
  currentVersion,
  listingCandidatePage,
  listingDetail,
  lockPublishingAccount,
  readPublicListing,
  readPublishingAccount,
  readCurrentVersion,
  readDepositRecommendation,
  readResourceIncomePreview,
  withPublicListingSnapshot,
  quoteListing,
  readDeclaration,
  restrictListing,
  reviewListing,
  saveListingDraft,
  setOwnerPaused,
  submitListing,
  unknownSupplyGate,
  withdrawListing,
  type PublishingAccount,
} from "./publishing";
const ACCOUNT_ROUTE =
  /^\/accounts\/([A-Za-z0-9._:-]+)(?:\/(drafts|draft|quote|accept-rules|submit|withdraw|pause|resume|restriction|duplicates|deposit-recommendation))?$/;
const ADMIN_ROUTE =
  /^\/listing-reviews\/([A-Za-z0-9._:-]+)(?:\/(decide|restriction|duplicates))?$/;
async function summary(
  client: PoolClient,
  a: PublishingAccount,
): Promise<Record<string, unknown>> {
  const v = a.current_version_id ? await currentVersion(client, a) : null;
  const d = v ? await readDeclaration(client, v) : null;
  return {
    revision: a.revision,
    currentVersionId: a.current_version_id,
    ownerPaused: a.owner_paused,
    staffRestricted: a.staff_restricted,
    restrictionReason: a.restriction_reason,
    versionState: v?.review_state ?? null,
    versionRevision: v?.revision ?? null,
    releaseId: v?.rule_release_id ?? null,
    contentHash: v?.content_hash ?? null,
    title: v?.title ?? null,
    inventory: d?.inventory ?? [],
    declarationDigest: d ? sha256Hex(JSON.stringify(d)) : null,
  };
}
export async function handlePublishingRoute(
  request: SupplyNodeRequest,
  response: SupplyNodeResponse,
  options: SupplyRuntimeOptions,
  requestId: string,
  path: string,
  query: URLSearchParams,
  admin: boolean,
): Promise<boolean> {
  const method = (request.method ?? "GET").toUpperCase();
  const gate = options.supplyGateReader ?? unknownSupplyGate;
  const ownerPreviewMatch = /^\/games\/([A-Za-z0-9._:-]+)\/owner-income-preview$/.exec(path);
  if (!admin && ownerPreviewMatch) {
    const cacheControl = "private, no-store";
    try {
      if (method !== "POST") throw notFound();
      if (typeof request.headers.origin !== "string" || ![options.userOrigin, options.apiOrigin].includes(request.headers.origin)) throw forbidden();
      if ([...query.keys()].length) throw invalid("预览不接受查询参数");
      if (typeof request.headers["content-type"] !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"])) throw invalid("预览须使用JSON内容");
      // Nest's existing rawBody parser supplies actual bytes, including whitespace and escaped text.
      if (!Buffer.isBuffer(request.rawBody) || request.rawBody.length > OWNER_INCOME_PREVIEW_MAX_BYTES) throw invalid("预览内容缺失或过大");
      const input = parseOwnerIncomePreviewInput(bodyOf(request));
      const context = await readUserContext(request, options);
      const result = await withPublicListingSnapshot(options.pool, async client => {
        await client.query("SELECT set_config('statement_timeout','3s',true),set_config('lock_timeout','500ms',true)");
        await assertUserContextInTransaction(client, context, "READ");
        await requirePublicGameService(client, ownerPreviewMatch[1]!, GAME_SERVICE.ACCOUNT_RENTAL);
        return readOwnerIncomePreview(client, context, ownerPreviewMatch[1]!, input);
      });
      sendJson(response, 200, result, requestId, cacheControl);
    } catch (error) {
      const known = error instanceof SecurityApiError ? error : null;
      sendJson(response, known?.status ?? 500, { error: { code: known?.code ?? API_V1_ERROR_CODES.INTERNAL_ERROR, message: known?.message ?? "号主收入预览暂不可用", requestId, ...(known?.details ? { details: known.details } : {}) } }, requestId, cacheControl);
    }
    return true;
  }
  const resourcePreviewMatch = /^\/games\/([A-Za-z0-9._:-]+)\/resource-income-preview$/.exec(path);
  if(!admin&&method==="GET"&&resourcePreviewMatch){
    for(const key of query.keys())if(!["inventory","catalogRevision","releaseId"].includes(key)||query.getAll(key).length!==1)throw invalid("资源预估参数错误",key);
    let inventory:unknown;try{inventory=JSON.parse(query.get("inventory")??"[]");}catch{throw invalid("库存格式错误","inventory");}
    const catalogRevision=query.get("catalogRevision"),releaseId=query.get("releaseId");
    if(!catalogRevision||!/^\d+$/.test(catalogRevision)||!releaseId||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(releaseId))throw invalid("资源预估须绑定当前目录和规则");
    const context=await readUserContext(request,options);
    const result=await withPublicListingSnapshot(options.pool,async client=>{
      await assertUserContextInTransaction(client,context,"READ");
      await requirePublicGameService(client,resourcePreviewMatch[1]!,GAME_SERVICE.ACCOUNT_RENTAL);
      return readResourceIncomePreview(client,resourcePreviewMatch[1]!,inventory,{catalogRevision,releaseId});
    });
    sendJson(response,200,result,requestId,"no-store");return true;
  }
  const optionsMatch = /^\/games\/([A-Za-z0-9._:-]+)\/publishing-options$/.exec(
    path,
  );
  if (!admin && method === "GET" && optionsMatch) {
    await requirePublicGameService(options.pool, optionsMatch[1]!, GAME_SERVICE.ACCOUNT_RENTAL);
    const release = (
      await options.pool.query(
        `SELECT r.id,r.generation::text,r.term_version_id,p.haff_rule,ag.id AS agreement_id,ag.title,ag.body,ag.digest FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id JOIN zzsh_supply.price_version p ON p.id=r.price_version_id JOIN zzsh_supply.agreement_version ag ON ag.id=r.agreement_version_id WHERE g.id=$1 AND g.enabled`,
        [optionsMatch[1]],
      )
    ).rows[0];
    if (!release) throw notFound();
    const terms = (
      await options.pool.query(
        `SELECT code,name,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 ORDER BY code`,
        [release.term_version_id],
      )
    ).rows;
    const rule = release.haff_rule as {
      schema?: string;
      compatibility?: import("./delta-rental").DeltaCompatPricing;
      baseBySafeBox?: Record<string, string>;
      options?: Record<string, { enabled: boolean }>;
      vitalityDeltaByLevel?: Record<string,string>;
      bearDeltaByLevel?: Record<string,string>;
      dailyDeltaByTermOption?: Record<string,string>;
    } | null;
    const mappedTerms = terms.filter(term => Object.hasOwn(rule?.dailyDeltaByTermOption ?? {}, term.code));
    const customTerms = mappedTerms.filter(term => term.dailyConsumption === DELTA_CUSTOM_DAILY_CONSUMPTION);
    const customEnabled = rule?.compatibility?.modes?.custom?.enabled === true && customTerms.length > 0;
    const termOptions = terms.map(term => {
      let adjustment: string | null = null;
      const value = rule?.dailyDeltaByTermOption?.[term.code];
      if (typeof value === "string") try { adjustment = formatDecimalExact(parseSignedDecimal(value, 8, "daily ratio adjustment")); } catch { /* An unproved adjustment stays unknown. */ }
      return { ...term, ownerRatioAdjustmentWanPerYuan: adjustment };
    });
    sendJson(
      response,
      200,
      {
        releaseId: release.id,
        generation: release.generation,
        termOptions,
        declarationOptions: {
          next_season_pass: { enabled: true, required: true, requiredAt: "QUOTE_AND_PUBLICATION", label: "下赛季通行证计划", type: "BOOLEAN", public: true },
          demulan_unlocked: { enabled: true, required: true, requiredAt: "QUOTE_AND_PUBLICATION", label: "是否已解锁德穆兰", type: "BOOLEAN", public: true },
          info_source: { enabled: true, required: false, label: "通过哪个渠道了解洲洲商行", public: false, options: DELTA_INFO_SOURCE_DICTIONARY.options, optionsState: "CONFIGURED", sourceSnapshot: DELTA_INFO_SOURCE_DICTIONARY.sourceSnapshot, acceptsLegacyText: true },
        },
        vitalityLevels:[...DELTA_PUBLISH_LEVELS],
        bearLevels:[...DELTA_PUBLISH_LEVELS],
        diveLevels:[0,1,2,3],
        safeBoxCodes: publicSafeBoxCodes(),
        safeBoxOptions: publicSafeBoxOptions(publicSafeBoxCodes()),
        pricingInputOptions: {
          safeBoxCodes: publicSafeBoxCodes().filter(code=>Object.hasOwn(rule?.baseBySafeBox??{},code)),
          vitalityLevels: deltaPublicationLevels(rule?.vitalityDeltaByLevel),
          bearLevels: deltaPublicationLevels(rule?.bearDeltaByLevel),
        },
        gradingOptions: publicGradingOptions(),
        loginMethodOptions: publicLoginMethodOptions(),
        pricingOptionCodes: Object.entries(rule?.options ?? {})
          .filter(([, v]) => v.enabled)
          .map(([key]) => key)
          .sort(),
        ...(rule?.schema === "haff-ratio-v2" ? {
          pricingSchema: "haff-ratio-v2",
          rentalModes: rule.compatibility?.modes ? { ...rule.compatibility.modes, custom: { ...rule.compatibility.modes.custom, enabled: customEnabled } } : undefined,
          rentalTermOptions: {
            ordinary: { termOptionCodes: mappedTerms.map(term => term.code) },
            custom: { termOptionCodes: customTerms.map(term => term.code), requiredDailyConsumption: DELTA_CUSTOM_DAILY_CONSUMPTION, reasonCodes: !customTerms.length ? ["CUSTOM_10M_TERM_UNAVAILABLE"] : [] },
            fast: { termOptionCodes: mappedTerms.map(term => term.code) },
          },
        } : {}),
        agreement: {
          id: release.agreement_id,
          title: release.title,
          body: release.body,
          digest: release.digest,
        },
      },
      requestId,
    );
    return true;
  }
  const accountMatch = admin
    ? ADMIN_ROUTE.exec(path)
    : ACCOUNT_ROUTE.exec(path);
  if (!admin && method === "GET" && path === "/listings/lookup") {
    const lookup = parseNumberLookupQuery(query);
    const result = await withPublicListingSnapshot(options.pool, client => lookupPublicListing(client, lookup, gate, options.legacyPublicAdmission, options.legacyPublicAdmissionDetail));
    sendJson(response, 200, result, requestId);
    return true;
  }
  const publicMatch = !admin
    ? /^\/listings\/([A-Za-z0-9._:-]+)(?:\/media\/([A-Za-z0-9._:-]+))?$/.exec(
        path,
      )
    : null;
  if (!admin && method === "GET" && (path === "/listings" || publicMatch)) {
    if (publicMatch) {
      const result = await withPublicListingSnapshot(
        options.pool,
        async (client) => {
          const a = await readPublishingAccount(client, publicMatch[1]!);
          const detail = await readPublicListing(client, a, gate, options.legacyPublicAdmission, false, "DETAIL", options.legacyPublicAdmissionDetail);
          if (!publicMatch[2]) return { detail };
          if (!Array.isArray(detail.media) || !detail.media.some((media: { assetId?: string }) => media.assetId === publicMatch[2])) throw notFound();
          const asset = await loadMediaAsset(client, publicMatch[2]);
          const v = await readCurrentVersion(client, { ...a, current_version_id: String(detail.versionId) });
          if (
            !asset ||
            asset.ownerUserId !== a.owner_user_id ||
            asset.purpose !== "ACCOUNT_DISPLAY" ||
            !isAccountDisplayPubliclyEligible(asset) ||
            !(await client.query(
              `SELECT 1 FROM zzsh_supply.listing_media WHERE version_id=$1 AND asset_id=$2`,
              [v.id, asset.id],
            )).rowCount
          )
            throw notFound();
          return { asset };
        },
      );
      if (result.asset) {
        const bytes = await options.mediaStorage.read(
          result.asset.publicStorageKey!,
        );
        const out = response as SupplyNodeResponse & {
          send: (bytes: Buffer) => void;
        };
        out
          .status(200)
          .setHeader("Content-Type", result.asset.mime)
          .setHeader("Content-Length", String(bytes.length))
          .setHeader("Cache-Control", "no-store")
          .setHeader("X-Content-Type-Options", "nosniff");
        out.send(bytes);
      } else sendJson(response, 200, result.detail, requestId);
      return true;
    }
    if(query.has("queryVersion")) {
      if(query.get("queryVersion")!=="2")throw invalid("Unsupported query version","queryVersion");
      sendJson(response,200,await listV2(request,options,query),requestId);return true;
    }
    const limit = Number(query.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw invalid("Limit is invalid");
    const filter = {
      gameId: query.get("gameId") ?? null,
      itemId: query.get("itemId") ?? null,
      minQuantity: query.get("minQuantity") ?? null,
      skins: query.getAll("skinId").sort(),
      skinMatch: query.get("skinMatch") ?? "ANY",
      q: parsePublicListingSearch(query.get("q")),
    };
    if (
      !["ANY", "ALL"].includes(filter.skinMatch) ||
      (filter.minQuantity !== null && !/^\d{1,24}$/.test(filter.minQuantity)) ||
      filter.skins.length > 50
    )
      throw invalid("Filter is invalid");
    let cursor = "";
    if (query.has("cursor")) {
      let c: Record<string, unknown>;
      try {
        c = JSON.parse(
          Buffer.from(query.get("cursor")!, "base64url").toString(),
        );
      } catch {
        throw invalid("Cursor is invalid");
      }
      if (!c || typeof c !== "object" || Array.isArray(c)) throw invalid("Cursor is invalid");
      if (c.v === 1) throw conflict("Cursor is stale; refresh from the first page");
      if (c.v !== 2 || c.filter !== sha256Hex(JSON.stringify(filter)) || typeof c.id !== "string")
        throw invalid("Cursor is invalid");
      cursor = c.id;
    }
    const data = await withPublicListingSnapshot(
      options.pool,
      async (client) => {
        if (filter.gameId) {
          await requirePublicGameService(client, filter.gameId, GAME_SERVICE.ACCOUNT_RENTAL);
        }
        const values:unknown[]=[cursor,filter.gameId];
        const param=(value:unknown)=>{values.push(value);return '$'+values.length;};
        const predicates=candidatePredicates({resources:filter.itemId?[{itemId:filter.itemId,minQuantity:filter.minQuantity??"0"}]:[],skinGroups:[{ids:filter.skins,match:filter.skinMatch}]},filter.q,param);
        const rows = (
          await client.query<{
            id: string;
            version_id: string;
          }>(
            `SELECT a.id,v.id AS version_id ${PUBLIC_CANDIDATE_FROM} WHERE a.id>$1 AND ${PUBLIC_CANDIDATE_WHERE} AND ($2::text IS NULL OR a.game_id=$2)${predicates.length?' AND '+predicates.join(' AND '):''} ORDER BY a.id LIMIT 200`,
            values,
          )
        ).rows;
        const items: unknown[] = [];
        let last = cursor;
        let hasMore = false;
        const page = listingCandidatePage(client);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          // The page is full and candidates remain unscanned: the caller still
          // has rows to fetch, so the cursor advances to the last scanned one.
          if (items.length === limit) {
            hasMore = true;
            break;
          }
          if (!page.has(row.id))
            await page.load(rows.slice(i, i + limit).map((candidate) => candidate.id));
          last = row.id;
          const account = page.account(row.id);
          if (!account) continue;
          try {
            items.push(
              await listingDetail(
                client,
                account,
                "public",
                gate,
                undefined,
                undefined,
                false,
                "RENTABLE",
                { version: page.version(row.id), shared: page.shared },
              ),
            );
          } catch (error) {
            if (
              (
                error as {
                  status?: number;
                }
              ).status !== 404
            )
              throw error;
          }
        }
        if (rows.length === 200) hasMore = true;
        return {
          items,
          nextCursor: hasMore
            ? Buffer.from(
                JSON.stringify({
                  v: 2,
                  id: last,
                  filter: sha256Hex(JSON.stringify(filter)),
                }),
              ).toString("base64url")
            : null,
        };
      },
    );
    sendJson(response, 200, data, requestId);
    return true;
  }
  if (
    !accountMatch &&
    !(
      method === "GET" &&
      (admin ? path === "/listing-reviews" : path === "/me/accounts")
    )
  )
    return false;
  if (method !== "GET" && !["POST", "PUT"].includes(method)) throw notFound();
  const origin = headerValue(request.headers.origin);
  if (
    method !== "GET" &&
    ![
      options.apiOrigin,
      admin ? options.adminOrigin : options.userOrigin,
    ].includes(origin ?? "")
  )
    throw forbidden();
  const context = admin
    ? await readAdminContext(request, options)
    : await readUserContext(request, options);
  const actorId = "userId" in context ? context.userId : "";
  const action = accountMatch?.[2];
  if (accountMatch && method === "GET" && action && action !== "deposit-recommendation") throw notFound();
  if (
    accountMatch &&
    method !== "GET" &&
    method !== (action === "draft" ? "PUT" : "POST")
  )
    throw notFound();
  const permission =
    action === "restriction"
      ? "supply.restrict"
      : action === "duplicates"
        ? "supply.duplicate.review"
        : action === "decide"
          ? "supply.review.decide"
          : "supply.review.read";
  const authorize = async (client: PoolClient, a?: PublishingAccount) => {
    if (admin) {
      await assertAdminContextInTransaction(client, context);
      const access = await loadEffectiveAdminAccess(client, actorId);
      if (method === "GET" && accountMatch && !action && query.get("queryVersion") === "3" && !hasPermission(access, "supply.review.read")) {
        requirePermission(access, "supply.rental_account.read");
      } else {
        requirePermission(access, "supply.review.read");
        requirePermission(access, permission);
      }
      if (a) await assertGameScope(client, actorId, access!.isBoss, a.game_id);
      return access;
    }
    await assertUserContextInTransaction(client, context);
    if (a && a.owner_user_id !== actorId) throw notFound();
    return null;
  };
  if (method === "GET") {
    if (admin && query.has("queryVersion")) {
      if (query.get("queryVersion") !== "3") throw invalid("Unsupported supervision query version");
      const data = await withPublicListingSnapshot(options.pool, async client => {
        const access = await authorize(client);
        const viewer = await supervisionViewer(client, context, access!);
        if (!accountMatch) return { ...await listSupervision(client, viewer, parseSupervisionQuery(query), gate, options.listingCursorKey, options.legacyPublicAdmission, options.legacyPublicAdmissionDetail), stationOrigins: { admin: options.adminOrigin, user: options.userOrigin } };
        for (const key of query.keys()) if (!["queryVersion", "versionId"].includes(key) || query.getAll(key).length !== 1) throw invalid("Unsupported supervision detail query", key);
        const a = await readPublishingAccount(client, accountMatch[1]!);
        await authorize(client, a);
        return readSupervision(client, a, viewer, gate, query.get("versionId"), options.legacyPublicAdmission, options.legacyPublicAdmissionDetail);
      });
      sendJson(response, 200, data, requestId);
      return true;
    }
    const data = await withTransaction(options.pool, async (client) => {
      const access = await authorize(client);
      if (accountMatch) {
        const a = await lockPublishingAccount(client, accountMatch[1]!);
        await authorize(client, a);
        if (action === "deposit-recommendation")
          return readDepositRecommendation(client, a);
        const requestedVersion = query.get("versionId");
        if (
          requestedVersion &&
          !(
            await client.query(
              `SELECT 1 FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2`,
              [requestedVersion, a.id],
            )
          ).rowCount
        )
          throw notFound();
        const historical = Boolean(
          requestedVersion && requestedVersion !== a.current_version_id,
        );
        const detail = await listingDetail(
          client,
          requestedVersion ? { ...a, current_version_id: requestedVersion } : a,
          admin ? "admin" : "owner",
          gate,
          admin && !access!.permissions.has("supply.quote.internal.read")
            ? "public"
            : undefined,
          a,
        );
        if (historical) {
          detail.account = a;
          detail.available = false;
          detail.blockers = [
            ...(detail.blockers as string[]),
            "HISTORICAL_VERSION",
          ];
        }
        const history = (
          await client.query(
            `SELECT id,sequence,origin,review_state,title,content_hash,rule_release_id,created_at FROM zzsh_supply.listing_version WHERE account_id=$1 ORDER BY sequence DESC`,
            [a.id],
          )
        ).rows;
        const previous = (
          await client.query(
            `SELECT v.id FROM zzsh_supply.listing_version v JOIN zzsh_supply.listing_publication p ON p.version_id=v.id AND p.account_id=v.account_id WHERE v.account_id=$1 AND v.id<>$2 AND ${EFFECTIVE_PUBLICATION_STATE_SQL} ORDER BY v.sequence DESC LIMIT 1`,
            [a.id, a.current_version_id],
          )
        ).rows[0];
        const duplicateHints = admin
          ? (
              await client.query(
                `SELECT h.id,h.related_account_id,h.evidence_ref,h.result,h.reason FROM zzsh_supply.duplicate_hint h JOIN zzsh_supply.rental_account related ON related.id=h.related_account_id WHERE h.account_id=$1 AND ${gameScopeSql("related.game_id","$3","$2")}`,
                [a.id, access!.isBoss, actorId],
              )
            ).rows
          : [];
        const old = previous
          ? (
              await client.query(
                `SELECT * FROM zzsh_supply.listing_version WHERE id=$1`,
                [previous.id],
              )
            ).rows[0]
          : null;
        const historicalRead = await loadLegacyHistoricalRead(client, a.id);
        return {
          ...detail,
          historicalRead: admin ? historicalRead : withoutLegacyResourceNo(historicalRead),
          history,
          previousDeclaration:
            admin && old ? await readDeclaration(client, old) : null,
          previousPresentation: admin && old ? old.presentation : null,
          duplicateHints,
        };
      }
      if (!admin) {
        // B1: owner list with rentalState / accountDisplay / activeOrder; legacy row fields and `after`/`nextCursor` unchanged.
        const owned = await listOwnerAccounts(client, actorId, parseOwnerAccountQuery(query), options.listingCursorKey);
        const historical = await loadLegacyHistoricalReads(client, owned.page.map(row => row.id));
        return {
          items: owned.page.map(row => ({ ...projectOwnerAccount(row), historicalRead: withoutLegacyResourceNo(historical.get(row.id) ?? null) })),
          nextCursor: owned.hasMore ? owned.last : null,
          nextPageCursor: owned.nextPageCursor,
        };
      }
      const state = query.get("state") ?? "SUBMITTED";
      if (
        ![
          "SUBMITTED",
          "APPROVED",
          "REJECTED",
          "WITHDRAWN",
          "DRAFT",
          "PUBLISHED",
          "IMPORTED_UNVERIFIED",
        ].includes(state)
      )
        throw invalid("State is invalid");
      const limit = Number(query.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
      if (admin) assertGameScopeUsable(await readAdminGameScope(client, actorId), access?.isBoss === true);
      const rows = (
        await client.query(
          `SELECT a.id,a.display_no,a.game_id,a.revision::text,a.owner_paused,a.staff_restricted,v.id AS version_id,v.title,v.review_state,v.sequence::text,u.name AS owner_name,g.name AS game_name FROM zzsh_supply.rental_account a LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id JOIN zzsh_supply.game g ON g.id=a.game_id WHERE a.id>$1 AND ($2::boolean OR a.owner_user_id=$3) AND (NOT $2::boolean OR (v.review_state=$4 AND ${gameScopeSql("a.game_id","$3","$5")})) ORDER BY a.id LIMIT $6`,
          [
            query.get("after") ?? "",
            admin,
            actorId,
            state,
            access?.isBoss ?? false,
            limit,
          ],
        )
      ).rows;
      const historical = admin ? null : await loadLegacyHistoricalReads(client, rows.map(row => row.id));
      return {
        items: historical ? rows.map(row => ({ ...row, display_no: publicAccountNumber(row.display_no), historicalRead: withoutLegacyResourceNo(historical.get(row.id) ?? null) })) : rows,
        nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
      };
    });
    sendJson(response, 200, data, requestId);
    return true;
  }
  if (!accountMatch || !action) throw notFound();
  const accountId = accountMatch[1]!;
  const body = bodyOf(request);
  const allowed: Record<string, string[]> = {
    drafts: ["expectedRevision"],
    quote: ["expectedRevision"],
    "accept-rules": [
      "expectedRevision",
      "versionId",
      "releaseId",
      "contentHash", "fullPayoutTermsAcceptance"],
    submit: ["expectedRevision", "versionId", "releaseId", "contentHash"],
    withdraw: ["expectedRevision", "versionId", "reason"],
    pause: ["expectedRevision", "reason"],
    resume: ["expectedRevision", "reason"],
    decide: [
      "expectedRevision",
      "versionId",
      "releaseId",
      "contentHash",
      "decision",
      "reason",
    ],
    restriction: ["expectedRevision", "restricted", "reason"],
    duplicates: [
      "expectedRevision",
      "relatedAccountId",
      "result",
      "evidenceRef",
      "reason",
    ],
  };
  if (action !== "draft") ensureOnlyFields(body, allowed[action] ?? []);
  if (!admin && ["decide", "restriction", "duplicates"].includes(action))
    throw forbidden();
  const operation = `supply.publication.${action}`;
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(
      client,
      admin ? "admin" : "user",
      actorId,
      context.sessionId,
      requestId,
    );
    let account: PublishingAccount;
    const result = await withIdempotency(
      client,
      {
        realm: admin ? "admin" : "user",
        principalId: actorId,
        operation,
        resourceId: accountId,
      },
      validateIdempotencyKey(headerValue(request.headers["idempotency-key"])),
      fingerprintRequest(operation, accountId, body),
      async () => {
        account = await lockPublishingAccount(client, accountId);
        await authorize(client, account);
      },
      async () => {
        const a = account!;
        const before = await summary(client, a);
        if (action === "drafts")
          await createListingDraft(client, a, body.expectedRevision, gate);
        else if (action === "draft")
          await saveListingDraft(client, a, body, gate);
        else if (action === "quote")
          await quoteListing(client, a, body.expectedRevision);
        else if (action === "accept-rules")
          await acceptListingRules(client, a, body);
        else if (action === "submit")
          await submitListing(client, a, actorId, body, gate);
        else if (action === "withdraw") await withdrawListing(client, a, body);
        else if (action === "pause" || action === "resume")
          await setOwnerPaused(client, a, body, action === "pause", gate);
        else if (action === "decide")
          await reviewListing(client, a, actorId, body, gate);
        else if (action === "restriction")
          await restrictListing(client, a, body);
        else if (action === "duplicates") {
          checkAccountRevision(a, body.expectedRevision);
          if (
            typeof body.relatedAccountId !== "string" ||
            body.relatedAccountId === a.id ||
            !["UNREVIEWED", "DISTINCT", "POSSIBLE_SAME"].includes(
              String(body.result),
            ) ||
            typeof body.reason !== "string" ||
            body.reason.trim().length < 2 ||
            body.reason.length > 500 ||
            typeof body.evidenceRef !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(body.evidenceRef)
          )
            throw invalid("请填写关联依据和人工判断");
          const other = (
            await client.query<PublishingAccount>(
              `SELECT * FROM zzsh_supply.rental_account WHERE id=$1`,
              [body.relatedAccountId],
            )
          ).rows[0];
          if (!other) throw notFound();
          await authorize(client, other);
          if (other.game_id !== a.game_id) throw invalid("仅可关联同游戏供给");
          await client.query(
            `INSERT INTO zzsh_supply.duplicate_hint(id,account_id,related_account_id,evidence_ref,result,reason,reviewer_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              newSupplyId("duplicate"),
              a.id,
              other.id,
              body.evidenceRef,
              body.result,
              body.reason,
              actorId,
            ],
          );
        } else throw notFound();
        const responseAccount = (
          await client.query<PublishingAccount>(
            `SELECT * FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,
            [a.id],
          )
        ).rows[0]!;
        const after = await summary(client, responseAccount);
        await recordAudit(client, {
          actorType: admin ? "admin" : "user",
          actorId,
          sessionId: context.sessionId,
          action: operation,
          objectType: "rental_account",
          objectId: responseAccount.id,
          outcome: "SUCCESS",
          reason: typeof body.reason === "string" ? body.reason : action,
          requestId,
          details: {
            before,
            after,
            ...(action === "duplicates"
              ? {
                  relatedAccountId: body.relatedAccountId,
                  result: body.result,
                  evidenceRef: body.evidenceRef,
                }
              : { result: "APPLIED" }),
          },
        });
        const access = admin
          ? await loadEffectiveAdminAccess(client, actorId)
          : null;
        return {
          status: 200,
          body: await listingDetail(
            client,
            responseAccount,
            admin ? "admin" : "owner",
            gate,
            admin && !access!.permissions.has("supply.quote.internal.read")
              ? "public"
              : undefined,
          ),
        };
      },
    );
    // Keep the original receipt/version, but intersect cached quote fields with current access.
    // Covers both first responses and legacy cached full responses without rerunning the action.
    const access = admin
      ? await loadEffectiveAdminAccess(client, actorId)
      : null;
    const cached = result.body as {
      version?: { quote?: ProjectedQuote | null } | null;
    };
    if (
      admin &&
      !access?.permissions.has("supply.quote.internal.read") &&
      cached.version?.quote
    ) {
      return {
        ...result,
        body: {
          ...cached,
          version: {
            ...cached.version,
            quote: projectDeltaQuote(cached.version.quote, "public"),
          },
        },
      };
    }
    return result;
  });
  sendJson(response, result.status, result.body, requestId);
  return true;
}
