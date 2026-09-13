import { projectQuote, type ProjectedQuote } from "./pricing";
import type { PoolClient } from "pg";
import { readAdminContext, assertAdminContextInTransaction } from "../auth/auth-security";
import {
  loadEffectiveAdminAccess,
  requirePermission,
} from "../auth/admin-authorization";
import {
  readUserContext,
  assertUserContextInTransaction,
} from "../auth/user-identity";
import {
  recordAudit,
  setAuditContext,
  withTransaction,
} from "../auth/security-core";
import { validateIdempotencyKey } from "../contracts/api-v1";
import type { SupplyRuntimeOptions } from "./supply-routes";
import { loadMediaAsset } from "./media";
import {
  assertGameScope,
  bodyOf,
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
  acceptListingRules,
  checkAccountRevision,
  createListingDraft,
  currentVersion,
  listingDetail,
  lockPublishingAccount,
  readPublishingAccount,
  readCurrentVersion,
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
  /^\/accounts\/([A-Za-z0-9._:-]+)(?:\/(drafts|draft|quote|accept-rules|submit|withdraw|pause|resume|restriction|duplicates))?$/;
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
  const optionsMatch = /^\/games\/([A-Za-z0-9._:-]+)\/publishing-options$/.exec(
    path,
  );
  if (!admin && method === "GET" && optionsMatch) {
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
      baseBySafeBox?: Record<string, string>;
      options?: Record<string, { enabled: boolean }>;
      vitalityDeltaByLevel?: Record<string,string>;
      bearDeltaByLevel?: Record<string,string>;
    } | null;
    sendJson(
      response,
      200,
      {
        releaseId: release.id,
        generation: release.generation,
        termOptions: terms,
        vitalityLevels:Object.keys(rule?.vitalityDeltaByLevel??{}).map(Number).filter(n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647).sort((a,b)=>a-b),
        bearLevels:Object.keys(rule?.bearDeltaByLevel??{}).map(Number).filter(n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647).sort((a,b)=>a-b),
        safeBoxCodes: Object.keys(rule?.baseBySafeBox ?? {}).sort(),
        pricingOptionCodes: Object.entries(rule?.options ?? {})
          .filter(([, v]) => v.enabled)
          .map(([key]) => key)
          .sort(),
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
          const detail = await listingDetail(client, a, "public", gate);
          if (!publicMatch[2]) return { detail };
          const asset = await loadMediaAsset(client, publicMatch[2]);
          const v = await readCurrentVersion(client, a);
          if (
            !asset ||
            asset.ownerUserId !== a.owner_user_id ||
            asset.purpose !== "ACCOUNT_DISPLAY" ||
            !asset.publicStorageKey ||
            !v.payload?.declaration.mediaBindings.some(
              (m) => m.assetId === asset.id && m.purpose === "ACCOUNT_DISPLAY",
            )
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
    const limit = Number(query.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw invalid("Limit is invalid");
    const filter = {
      gameId: query.get("gameId") ?? null,
      itemId: query.get("itemId") ?? null,
      minQuantity: query.get("minQuantity") ?? null,
      skins: query.getAll("skinId").sort(),
      skinMatch: query.get("skinMatch") ?? "ANY",
    };
    if (
      !["ANY", "ALL"].includes(filter.skinMatch) ||
      (filter.minQuantity !== null && !/^\d{1,24}$/.test(filter.minQuantity)) ||
      filter.skins.length > 50
    )
      throw invalid("Filter is invalid");
    let cursor = "";
    if (query.has("cursor")) {
      try {
        const c = JSON.parse(
          Buffer.from(query.get("cursor")!, "base64url").toString(),
        );
        if (
          c.filter !== sha256Hex(JSON.stringify(filter)) ||
          typeof c.id !== "string"
        )
          throw Error();
        cursor = c.id;
      } catch {
        throw invalid("Cursor is invalid");
      }
    }
    const data = await withPublicListingSnapshot(
      options.pool,
      async (client) => {
        const rows = (
          await client.query<{
            id: string;
            version_id: string;
          }>(
            `SELECT a.id,v.id AS version_id FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_supply.game g ON g.id=a.game_id WHERE a.id>$1 AND a.lifecycle='ACTIVE' AND NOT a.owner_paused AND NOT a.staff_restricted AND a.legacy_hold='NONE' AND v.review_state='APPROVED' AND v.rule_release_id=g.current_release_id AND ($2::text IS NULL OR a.game_id=$2) AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM zzsh_supply.inventory_line l WHERE l.version_id=v.id AND l.item_id=$3 AND l.quantity>=COALESCE($4::numeric,0))) AND (cardinality($5::text[])=0 OR CASE WHEN $6='ALL' THEN (SELECT count(*) FROM zzsh_supply.listing_skin s WHERE s.version_id=v.id AND s.skin_id=ANY($5))=cardinality($5::text[]) ELSE EXISTS(SELECT 1 FROM zzsh_supply.listing_skin s WHERE s.version_id=v.id AND s.skin_id=ANY($5)) END) ORDER BY a.id LIMIT 200`,
            [
              cursor,
              filter.gameId,
              filter.itemId,
              filter.minQuantity,
              filter.skins,
              filter.skinMatch,
            ],
          )
        ).rows;
        const items: unknown[] = [];
        let last = cursor;
        let hasMore = false;
        for (const row of rows) {
          if (items.length === limit) {
            hasMore = true;
            break;
          }
          last = row.id;
          try {
            items.push(
              await listingDetail(
                client,
                await readPublishingAccount(client, row.id),
                "public",
                gate,
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
  if (accountMatch && method === "GET" && action) throw notFound();
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
      requirePermission(access, "supply.review.read");
      requirePermission(access, permission);
      if (a) await assertGameScope(client, actorId, access!.isBoss, a.game_id);
      return access;
    }
    await assertUserContextInTransaction(client, context);
    if (a && a.owner_user_id !== actorId) throw notFound();
    return null;
  };
  if (method === "GET") {
    const data = await withTransaction(options.pool, async (client) => {
      const access = await authorize(client);
      if (accountMatch) {
        const a = await lockPublishingAccount(client, accountMatch[1]!);
        await authorize(client, a);
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
            `SELECT id FROM zzsh_supply.listing_version WHERE account_id=$1 AND id<>$2 AND review_state='APPROVED' ORDER BY sequence DESC LIMIT 1`,
            [a.id, a.current_version_id],
          )
        ).rows[0];
        const duplicateHints = admin
          ? (
              await client.query(
                `SELECT h.id,h.related_account_id,h.evidence_ref,h.result,h.reason FROM zzsh_supply.duplicate_hint h JOIN zzsh_supply.rental_account related ON related.id=h.related_account_id WHERE h.account_id=$1 AND ($2 OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$3 AND s.game_id=related.game_id))`,
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
        return {
          ...detail,
          history,
          previousDeclaration:
            admin && old ? await readDeclaration(client, old) : null,
          previousPresentation: admin && old ? old.presentation : null,
          duplicateHints,
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
          "IMPORTED_UNVERIFIED",
        ].includes(state)
      )
        throw invalid("State is invalid");
      const limit = Number(query.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
      const rows = (
        await client.query(
          `SELECT a.id,a.game_id,a.revision::text,a.owner_paused,a.staff_restricted,v.id AS version_id,v.title,v.review_state,v.sequence::text,u.name AS owner_name,g.name AS game_name FROM zzsh_supply.rental_account a LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id JOIN zzsh_supply.game g ON g.id=a.game_id WHERE a.id>$1 AND ($2::boolean OR a.owner_user_id=$3) AND (NOT $2::boolean OR (v.review_state=$4 AND ($5::boolean OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope s WHERE s.admin_user_id=$3 AND s.game_id=a.game_id)))) ORDER BY a.id LIMIT $6`,
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
      return {
        items: rows,
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
      "contentHash",
    ],
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
          await submitListing(client, a, body, gate);
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
        const after = await summary(client, a);
        await recordAudit(client, {
          actorType: admin ? "admin" : "user",
          actorId,
          sessionId: context.sessionId,
          action: operation,
          objectType: "rental_account",
          objectId: a.id,
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
            a,
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
            quote: projectQuote(cached.version.quote, "public"),
          },
        },
      };
    }
    return result;
  });
  sendJson(response, result.status, result.body, requestId);
  return true;
}
