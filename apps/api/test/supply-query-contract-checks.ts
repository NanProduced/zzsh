import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TestContext } from "node:test";
import type { SupplyGate } from "../src/supply/publishing";

type Jar = { header: () => string; update?: (r: Response) => void };

export async function runQueryContractChecks(o: {
  testContext: TestContext;
  base: string;
  pool: Pool;
  maintenance: Pool;
  gameId: string;
  accountId: string;
  itemId: string;
  user: Jar;
  stranger: Jar;
  boss: Jar;
  userOrigin: string;
  adminOrigin: string;
  bytes: Buffer;
  gates: Map<string, SupplyGate>;
}): Promise<void> {
  const call = async (
    path: string,
    body: unknown,
    jar: Jar = o.user,
    method = body === undefined ? "GET" : "POST",
    key = "m3q_" + randomUUID(),
  ) => {
    const r = await fetch(o.base + path, {
      method,
      headers: {
        cookie: jar.header(),
        origin: path.includes("/admin/") ? o.adminOrigin : o.userOrigin,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    jar.update?.(r);
    return { status: r.status, body: await r.json() };
  };
  const ok = async (
    path: string,
    body: unknown,
    jar: Jar = o.user,
    method?: string,
  ) => {
    const r = await call(path, body, jar, method);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const token = (d: any) => ({
    expectedRevision: d.account.revision,
    versionId: d.version.id,
    releaseId: d.version.releaseId,
    contentHash: d.version.contentHash,
  });
  const uploadApproved = async (
    accountId: string,
    purpose: "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE",
    visibility?: "PUBLIC_DISPLAY",
  ) => {
    const intent = await ok("/api/v1/supply/media/upload-intents", {
      gameId: o.gameId,
      accountId,
      mime: "image/png",
      size: o.bytes.length,
      purpose,
    });
    const uploaded = await fetch(
      o.base + "/api/v1/supply/media/uploads/" + intent.intentId,
      {
        method: "PUT",
        headers: {
          origin: o.userOrigin,
          cookie: o.user.header(),
          "content-type": "image/png",
          "x-upload-token": intent.uploadToken,
          "idempotency-key": "m3q_upload_" + randomUUID(),
        },
        body: new Uint8Array(o.bytes),
      },
    );
    const asset = await uploaded.json();
    assert.equal(uploaded.status, 200, JSON.stringify(asset));
    await ok(
      "/api/bff/admin/supply/media/" + asset.assetId + "/review",
      {
        decision: "APPROVE",
        ...(visibility ? { visibility } : {}),
      },
      o.boss,
    );
    return asset.assetId as string;
  };
  const publish = async (input: {
    title: string;
    quantity?: string;
    skins?: string[];
    bindEvidence?: boolean;
  }) => {
    const created = await ok("/api/v1/supply/accounts", { gameId: o.gameId });
    const accountId = created.accountId as string;
    o.gates.set(accountId, {
      publisherBail: "NOT_REQUIRED",
      occupancy: "FREE",
      reference: "fixture:m3-query",
    });
    let d = await ok("/api/v1/supply/accounts/" + accountId + "/drafts", {
      expectedRevision: "1",
    });
    const displayId = await uploadApproved(
      accountId,
      "ACCOUNT_DISPLAY",
      "PUBLIC_DISPLAY",
    );
    const evidenceId = input.bindEvidence
      ? await uploadApproved(accountId, "ACCOUNT_EVIDENCE")
      : null;
    const mediaBindings = [
      { assetId: displayId, position: 0 },
      ...(evidenceId ? [{ assetId: evidenceId, position: 1 }] : []),
    ];
    d = await ok(
      "/api/v1/supply/accounts/" + accountId + "/draft",
      {
        title: input.title,
        description: "合成检索资料，不含登录凭据",
        attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6 },
        termOptionCode: "daily-10m",
        pricingOptionCode: "standard",
        inventory: [{ itemId: o.itemId, quantity: input.quantity ?? "60000000" }],
        skins: input.skins ?? [],
        entitlements: [],
        mediaBindings,
        expectedRevision: d.account.revision,
      },
      o.user,
      "PUT",
    );
    d = await ok("/api/v1/supply/accounts/" + accountId + "/quote", {
      expectedRevision: d.account.revision,
    });
    d = await ok(
      "/api/v1/supply/accounts/" + accountId + "/accept-rules",
      token(d),
    );
    d = await ok("/api/v1/supply/accounts/" + accountId + "/submit", token(d));
    d = await ok(
      "/api/bff/admin/supply/listing-reviews/" + accountId + "/decide",
      {
        ...token(d),
        decision: "APPROVE",
        reason: "合成检索样例核对通过",
      },
      o.boss,
    );
    return {
      accountId,
      versionId: d.version.id as string,
      displayId,
      evidenceId,
      revision: d.account.revision as string,
    };
  };

  const skinId = (
    await o.pool.query(
      `SELECT id FROM zzsh_supply.skin WHERE game_id=$1 AND code='skin_m4_gold'`,
      [o.gameId],
    )
  ).rows[0].id as string;

  await o.testContext.test(
    "M3 query: public listing search is server-side, bounded and cursor-bound",
    async () => {
      const alpha = await publish({ title: "检索样例甲·公开标题" });
      const wild = await publish({
        title: "检索样例乙·含%与_的标题",
        skins: [skinId],
      });
      const later = await publish({ title: "检索样例丙·翻页目标" });
      const hidden = await ok("/api/v1/supply/accounts", { gameId: o.gameId });
      o.gates.set(hidden.accountId, {
        publisherBail: "NOT_REQUIRED",
        occupancy: "FREE",
        reference: "fixture:m3-query",
      });
      let draft = await ok(
        "/api/v1/supply/accounts/" + hidden.accountId + "/drafts",
        { expectedRevision: "1" },
      );
      draft = await ok(
        "/api/v1/supply/accounts/" + hidden.accountId + "/draft",
        {
          title: "检索样例甲·公开标题",
          description: null,
          attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6 },
          termOptionCode: "daily-10m",
          pricingOptionCode: "standard",
          inventory: [{ itemId: o.itemId, quantity: "60000000" }],
          skins: [],
          entitlements: [],
          mediaBindings: [],
          expectedRevision: draft.account.revision,
        },
        o.user,
        "PUT",
      );
      assert.equal(draft.version.reviewState, "DRAFT");

      const none = await fetch(
        o.base +
          "/api/v1/supply/listings?q=" +
          encodeURIComponent("绝无此标题zzzz"),
      );
      assert.equal(none.status, 200);
      assert.equal((await none.json()).items.length, 0);

      const chinese = await (
        await fetch(
          o.base +
            "/api/v1/supply/listings?q=" +
            encodeURIComponent("检索样例甲"),
        )
      ).json();
      assert.deepEqual(
        chinese.items.map((i: any) => i.id),
        [alpha.accountId],
      );
      const blank = await (
        await fetch(o.base + "/api/v1/supply/listings?q=" + encodeURIComponent("   "))
      ).json();
      const unfiltered = await (
        await fetch(o.base + "/api/v1/supply/listings")
      ).json();
      assert.equal(blank.items.length, unfiltered.items.length);

      const percent = await (
        await fetch(
          o.base +
            "/api/v1/supply/listings?q=" +
            encodeURIComponent("含%与_的标题"),
        )
      ).json();
      assert.deepEqual(
        percent.items.map((i: any) => i.id),
        [wild.accountId],
      );
      const onlyPercent = await (
        await fetch(o.base + "/api/v1/supply/listings?q=" + encodeURIComponent("%"))
      ).json();
      assert.ok(onlyPercent.items.every((i: any) => i.title.includes("%")));
      const injection = await (
        await fetch(
          o.base +
            "/api/v1/supply/listings?q=" +
            encodeURIComponent("' OR 1=1 --"),
        )
      ).json();
      assert.equal(injection.items.length, 0);

      const tooLong = await fetch(
        o.base + "/api/v1/supply/listings?q=" + "x".repeat(121),
      );
      assert.equal(tooLong.status, 400);
      assert.equal((await tooLong.json()).error.details[0].path, "q");

      const firstPage = await (
        await fetch(o.base + "/api/v1/supply/listings?limit=1")
      ).json();
      assert.equal(firstPage.items.length, 1);
      const firstId = firstPage.items[0].id;
      const outside =
        later.accountId === firstId ? wild.accountId : later.accountId;
      const outsideTitle =
        later.accountId === firstId
          ? "检索样例乙·含%与_的标题"
          : "检索样例丙·翻页目标";
      assert.notEqual(firstId, outside);
      const recovered = await (
        await fetch(
          o.base +
            "/api/v1/supply/listings?limit=1&q=" +
            encodeURIComponent(outsideTitle),
        )
      ).json();
      assert.deepEqual(
        recovered.items.map((i: any) => i.id),
        [outside],
      );

      const combined = await (
        await fetch(
          o.base +
            "/api/v1/supply/listings?gameId=" +
            o.gameId +
            "&itemId=" +
            o.itemId +
            "&minQuantity=60000000&skinMatch=ALL&skinId=" +
            skinId +
            "&q=" +
            encodeURIComponent("检索样例乙"),
        )
      ).json();
      assert.deepEqual(
        combined.items.map((i: any) => i.id),
        [wild.accountId],
      );

      const pageQuery =
        "/api/v1/supply/listings?limit=1&q=" +
        encodeURIComponent("检索样例");
      const page1 = await (await fetch(o.base + pageQuery)).json();
      assert.ok(page1.nextCursor);
      const page2 = await (
        await fetch(
          o.base + pageQuery + "&cursor=" + encodeURIComponent(page1.nextCursor),
        )
      ).json();
      const page3 = await (
        await fetch(
          o.base +
            pageQuery +
            "&cursor=" +
            encodeURIComponent(page2.nextCursor),
        )
      ).json();
      const paged = [...page1.items, ...page2.items, ...page3.items].map(
        (i: any) => i.id,
      );
      assert.equal(new Set(paged).size, paged.length);
      assert.ok(paged.includes(alpha.accountId));
      assert.ok(paged.includes(wild.accountId));
      assert.ok(paged.includes(later.accountId));
      assert.equal(paged.includes(hidden.accountId), false);
      const stale = await fetch(
        o.base +
          "/api/v1/supply/listings?limit=1&q=" +
          encodeURIComponent("检索样例甲") +
          "&cursor=" +
          encodeURIComponent(page1.nextCursor),
      );
      assert.equal(stale.status, 400);

      await o.maintenance.query(
        "UPDATE zzsh_supply.rental_account SET owner_paused=true WHERE id=$1",
        [alpha.accountId],
      );
      try {
        const paused = await (
          await fetch(
            o.base +
              "/api/v1/supply/listings?q=" +
              encodeURIComponent("检索样例甲·公开标题"),
          )
        ).json();
        assert.equal(paused.items.length, 0);
      } finally {
        await o.maintenance.query(
          "UPDATE zzsh_supply.rental_account SET owner_paused=false WHERE id=$1",
          [alpha.accountId],
        );
      }
      const bff = await (
        await fetch(
          o.base +
            "/api/bff/user/supply/listings?q=" +
            encodeURIComponent("检索样例甲·公开标题"),
        )
      ).json();
      assert.deepEqual(
        bff.items.map((i: any) => i.id),
        [alpha.accountId],
      );
    },
  );

  await o.testContext.test(
    "M3 query: public offer fields come from the approved snapshot",
    async () => {
      const published = await publish({ title: "公开条件快照样例" });
      const listing = await (
        await fetch(o.base + "/api/v1/supply/listings/" + published.accountId)
      ).json();
      assert.equal(listing.attributes.safe_box_code, "box-a");
      assert.deepEqual(listing.safeBox, {
        code: "box-a",
        displayName: null,
      });
      assert.equal(listing.termOption.code, "daily-10m");
      assert.equal(listing.termOption.displayName, "日消耗 10M");
      assert.deepEqual(listing.termOption.dailyConsumption, {
        quantity: "10000000",
        unit: "HAFF_BASE",
      });
      assert.equal(listing.quote.termSeconds, String(6 * 86400));
      assert.equal(listing.quote.resourceTotal.amount, "150.00");
      for (const field of [
        "ownerTotal",
        "byteHash",
        "reviewState",
        "publiclyReadable",
        "ACCOUNT_EVIDENCE",
        "storageKey",
        "review_reason",
      ])
        assert.equal(JSON.stringify(listing).includes(field), false, field);

      const draftTerm = await ok(
        "/api/bff/admin/supply/term-drafts",
        { gameId: o.gameId },
        o.boss,
      );
      await ok(
        "/api/bff/admin/supply/term-drafts/" + draftTerm.id,
        {
          expectedRevision: "1",
          options: [
            {
              code: "daily-10m",
              name: "不该出现在旧公开版本",
              dailyConsumption: "20000000",
            },
            {
              code: "daily-20m",
              name: "日消耗 20M",
              dailyConsumption: "20000000",
            },
          ],
        },
        o.boss,
        "PUT",
      );
      await ok(
        "/api/bff/admin/supply/term-drafts/" + draftTerm.id + "/seal",
        { expectedRevision: draftTerm.revision ?? "2" },
        o.boss,
      );
      const still = await (
        await fetch(o.base + "/api/v1/supply/listings/" + published.accountId)
      ).json();
      assert.equal(still.termOption.displayName, "日消耗 10M");
      assert.equal(still.termOption.dailyConsumption.quantity, "10000000");
      const current = (
        await o.pool.query(
          `SELECT r.id,r.term_version_id FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id WHERE g.id=$1`,
          [o.gameId],
        )
      ).rows[0];
      const oldTerm = (
        await o.pool.query(
          `SELECT daily_consumption::text AS qty,name FROM zzsh_supply.term_option WHERE version_id=$1 AND code='daily-10m'`,
          [current.term_version_id],
        )
      ).rows[0];
      const newer = (
        await o.pool.query(
          `SELECT daily_consumption::text AS qty,name FROM zzsh_supply.term_option WHERE version_id=$1 AND code='daily-10m'`,
          [draftTerm.id],
        )
      ).rows[0];
      assert.equal(oldTerm.qty, "10000000");
      assert.equal(oldTerm.name, "日消耗 10M");
      assert.equal(newer.qty, "20000000");
      assert.equal(newer.name, "不该出现在旧公开版本");
      assert.notEqual(current.term_version_id, draftTerm.id);
    },
  );

  await o.testContext.test(
    "M3 query: owner media status is per-asset and not a public leak",
    async () => {
      const published = await publish({
        title: "媒体状态样例",
        bindEvidence: true,
      });
      const owner = await ok(
        "/api/v1/supply/accounts/" + published.accountId,
        undefined,
      );
      const bindings = owner.version.declaration.mediaBindings as any[];
      const display = bindings.find((b) => b.assetId === published.displayId);
      const evidence = bindings.find((b) => b.assetId === published.evidenceId);
      assert.equal(display.purpose, "ACCOUNT_DISPLAY");
      assert.equal(display.reviewState, "APPROVED");
      assert.equal(display.publicDisplayEligible, true);
      assert.equal(display.publiclyReadable, true);
      assert.equal(evidence.purpose, "ACCOUNT_EVIDENCE");
      assert.equal(evidence.reviewState, "APPROVED");
      assert.equal(evidence.publicDisplayEligible, false);
      assert.equal(evidence.publiclyReadable, false);
      const publicMedia =
        "/api/v1/supply/listings/" +
        published.accountId +
        "/media/" +
        published.displayId;
      assert.equal((await fetch(o.base + publicMedia)).status, 200);
      const paused = await ok(
        "/api/v1/supply/accounts/" + published.accountId + "/pause",
        {
          expectedRevision: owner.account.revision,
          reason: "暂停接单核对公开图",
        },
      );
      const afterPause = paused.version.declaration.mediaBindings.find(
        (b: any) => b.assetId === published.displayId,
      );
      assert.equal(afterPause.publicDisplayEligible, true);
      assert.equal(afterPause.publiclyReadable, false);
      assert.equal((await fetch(o.base + publicMedia)).status, 404);
      const resumed = await ok(
        "/api/v1/supply/accounts/" + published.accountId + "/resume",
        { expectedRevision: paused.account.revision },
      );
      const afterResume = resumed.version.declaration.mediaBindings.find(
        (b: any) => b.assetId === published.displayId,
      );
      assert.equal(afterResume.publiclyReadable, true);
      assert.equal((await fetch(o.base + publicMedia)).status, 200);
      assert.equal(
        (await call("/api/v1/supply/accounts/" + published.accountId, undefined, o.stranger))
          .status,
        404,
      );
      const pendingAccount = await ok("/api/v1/supply/accounts", {
        gameId: o.gameId,
      });
      o.gates.set(pendingAccount.accountId, {
        publisherBail: "NOT_REQUIRED",
        occupancy: "FREE",
        reference: "fixture:m3-query",
      });
      let pending = await ok(
        "/api/v1/supply/accounts/" + pendingAccount.accountId + "/drafts",
        { expectedRevision: "1" },
      );
      const pendingIntent = await ok("/api/v1/supply/media/upload-intents", {
        gameId: o.gameId,
        accountId: pendingAccount.accountId,
        mime: "image/png",
        size: o.bytes.length,
        purpose: "ACCOUNT_DISPLAY",
      });
      const pendingUpload = await fetch(
        o.base + "/api/v1/supply/media/uploads/" + pendingIntent.intentId,
        {
          method: "PUT",
          headers: {
            origin: o.userOrigin,
            cookie: o.user.header(),
            "content-type": "image/png",
            "x-upload-token": pendingIntent.uploadToken,
            "idempotency-key": "m3q_pending_" + randomUUID(),
          },
          body: new Uint8Array(o.bytes),
        },
      );
      const pendingAsset = await pendingUpload.json();
      assert.equal(pendingUpload.status, 200, JSON.stringify(pendingAsset));
      pending = await ok(
        "/api/v1/supply/accounts/" + pendingAccount.accountId + "/draft",
        {
          title: "待审图片",
          description: null,
          attributes: {},
          termOptionCode: "daily-10m",
          pricingOptionCode: "standard",
          inventory: [],
          skins: [],
          entitlements: [],
          mediaBindings: [{ assetId: pendingAsset.assetId, position: 0 }],
          expectedRevision: pending.account.revision,
        },
        o.user,
        "PUT",
      );
      assert.equal(
        pending.version.declaration.mediaBindings[0].reviewState,
        "PENDING",
      );
      assert.equal(
        pending.version.declaration.mediaBindings[0].publicDisplayEligible,
        false,
      );
      assert.equal(
        pending.version.declaration.mediaBindings[0].publiclyReadable,
        false,
      );
      await ok(
        "/api/bff/admin/supply/media/" + pendingAsset.assetId + "/review",
        { decision: "REJECT", reason: "合成驳回待替换" },
        o.boss,
      );
      const rejected = await ok(
        "/api/v1/supply/accounts/" + pendingAccount.accountId,
        undefined,
      );
      assert.equal(
        rejected.version.declaration.mediaBindings[0].reviewState,
        "REJECTED",
      );
      assert.equal(
        rejected.version.declaration.mediaBindings[0].publiclyReadable,
        false,
      );
      const rejectedWrite = await call(
        "/api/v1/supply/accounts/" + pendingAccount.accountId + "/draft",
        {
          title: "待审图片",
          description: null,
          attributes: {},
          termOptionCode: "daily-10m",
          pricingOptionCode: "standard",
          inventory: [],
          skins: [],
          entitlements: [],
          mediaBindings: [
            {
              assetId: pendingAsset.assetId,
              position: 0,
              reviewState: "APPROVED",
              publicDisplayEligible: true,
              publiclyReadable: true,
            },
          ],
          expectedRevision: pending.account.revision,
        },
        o.user,
        "PUT",
      );
      assert.equal(rejectedWrite.status, 400);
      assert.equal(rejectedWrite.body.error.details[0].path, "reviewState");

      await ok(
        "/api/bff/admin/supply/media/" + published.displayId + "/visibility",
        { visibility: "PRIVATE_REVIEW", reason: "撤销公开展示" },
        o.boss,
      );
      assert.equal(
        (await fetch(o.base + "/api/v1/supply/listings/" + published.accountId))
          .status,
        404,
      );
      assert.equal(
        (
          await fetch(
            o.base +
              "/api/v1/supply/listings/" +
              published.accountId +
              "/media/" +
              published.displayId,
          )
        ).status,
        404,
      );
      const afterRevoke = await ok(
        "/api/v1/supply/accounts/" + published.accountId,
        undefined,
      );
      const revoked = afterRevoke.version.declaration.mediaBindings.find(
        (b: any) => b.assetId === published.displayId,
      );
      assert.equal(afterRevoke.version.reviewState, "APPROVED");
      assert.equal(revoked.reviewState, "APPROVED");
      assert.equal(revoked.publicDisplayEligible, false);
      assert.equal(revoked.publiclyReadable, false);
      const drafted = await ok(
        "/api/v1/supply/accounts/" + published.accountId + "/drafts",
        { expectedRevision: afterRevoke.account.revision },
      );
      const extraDisplay = await uploadApproved(
        published.accountId,
        "ACCOUNT_DISPLAY",
        "PUBLIC_DISPLAY",
      );
      const draftedBindings = drafted.version.declaration.mediaBindings.map(
        (b: any) => ({ assetId: b.assetId, position: b.position }),
      );
      draftedBindings.push({
        assetId: extraDisplay,
        position: draftedBindings.length,
      });
      const withDraftImage = await ok(
        "/api/v1/supply/accounts/" + published.accountId + "/draft",
        {
          title: "媒体状态样例",
          description: "合成检索资料，不含登录凭据",
          attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6 },
          termOptionCode: "daily-10m",
          pricingOptionCode: "standard",
          inventory: [{ itemId: o.itemId, quantity: "60000000" }],
          skins: [],
          entitlements: [],
          mediaBindings: draftedBindings,
          expectedRevision: drafted.account.revision,
        },
        o.user,
        "PUT",
      );
      const draftOnly = withDraftImage.version.declaration.mediaBindings.find(
        (b: any) => b.assetId === extraDisplay,
      );
      assert.equal(draftOnly.publicDisplayEligible, true);
      assert.equal(draftOnly.publiclyReadable, false);
      const publicList = await (
        await fetch(o.base + "/api/v1/supply/listings/" + o.accountId)
      ).json();
      assert.equal(
        JSON.stringify(publicList).includes("publiclyReadable"),
        false,
      );
      assert.equal(
        JSON.stringify(publicList).includes("publicDisplayEligible"),
        false,
      );
      assert.equal(JSON.stringify(publicList).includes("reviewState"), false);
    },
  );
}
