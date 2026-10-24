import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const rootPath = fileURLToPath(new URL("..", import.meta.url));

test("R1-01 formatSpreadRate renders valid percentage and safe placeholder without throwing in React", async () => {
  const vite = await createServer({
    configFile: false,
    root: rootPath,
    plugins: [react()],
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  try {
    const {
      formatSpreadRate,
      formatCents,
      parsePolicyAllowanceYuan,
      formatDepositBenefitText,
      parseYuanToCents,
      formatCentsToYuan,
      parseHumanDiscount,
      parseHaffMillions,
      exactPercentTenths,
      formatTenthsPercent,
    } = await vite.ssrLoadModule("/src/views/membership-growth-view.tsx");

    const point = {
      payableRatio: "1",
      payableRentalCents: "171538",
      discountCents: "0",
      ownerIncomeCents: "80000",
      platformSpreadCents: "91538",
      ownerFloorSatisfied: true,
      spreadRate: { numerator: "91538", denominator: "171538" },
    };

    // Exact counterexample from Master review: must NOT throw in React
    assert.equal(formatSpreadRate(point.spreadRate), "53.4%");
    assert.doesNotThrow(() => {
      const html = renderToString(createElement("td", { className: "tabular-nums" }, formatSpreadRate(point.spreadRate)));
      assert.match(html, /53\.4%/);
    });

    // Null/undefined spreadRate (e.g. zero revenue or break even) renders em-dash
    assert.equal(formatSpreadRate(null), "—");
    assert.equal(formatSpreadRate(undefined), "—");
    assert.doesNotThrow(() => {
      const html = renderToString(createElement("td", { className: "tabular-nums" }, formatSpreadRate(null)));
      assert.match(html, /—/);
    });

    // R1-02 deposit allowance three-state formatting and edge cases
    assert.equal(formatDepositBenefitText(false, "0"), "不减免押金");
    assert.equal(formatDepositBenefitText(false, undefined), "不减免押金");
    assert.equal(formatDepositBenefitText(false, "20000"), "减免押金 ¥200 元");
    assert.equal(formatDepositBenefitText(false, "20050"), "减免押金 ¥200.5 元");
    assert.equal(formatDepositBenefitText(false, "1"), "减免押金 ¥0.01 元");
    assert.equal(formatDepositBenefitText(true, "0"), "完全免除押金");
    assert.equal(formatDepositBenefitText(true, undefined), "完全免除押金");

    // Exact decimal string parsing (no float arithmetic)
    assert.equal(parseYuanToCents("200"), "20000");
    assert.equal(parseYuanToCents("200.5"), "20050");
    assert.equal(parseYuanToCents("200.50"), "20050");
    assert.equal(parseYuanToCents("0.01"), "1");
    assert.equal(parseYuanToCents("0"), "0");
    assert.equal(parseYuanToCents(""), null);
    assert.equal(parseYuanToCents("-50"), null);
    assert.equal(parseYuanToCents("abc"), null);

    // Cents to Yuan exact formatting
    assert.equal(formatCentsToYuan("20000"), "200");
    assert.equal(formatCentsToYuan("20050"), "200.5");
    assert.equal(formatCentsToYuan("1"), "0.01");
    assert.equal(formatCentsToYuan("0"), "0");

    // BigInt cents and percentage boundary; Number would collapse this reduction to zero.
    assert.equal(formatCents("9007199254740993"), "¥90071992547409.93");
    assert.equal(formatCents("-1"), "-¥0.01");
    assert.equal(formatSpreadRate({ numerator: "9007199254740993", denominator: "9007199254740992" }), "100%");
    assert.equal(formatSpreadRate({ numerator: "-1", denominator: "3" }), "-33.3%");
    assert.equal(formatSpreadRate({ numerator: "1", denominator: "0" }), "—");

    // Raw policy allowance is accepted only as exact, positive yuan with at most two decimals and 24 cent digits.
    assert.deepEqual(parsePolicyAllowanceYuan("200.50"), { cents: "20050", error: "" });
    assert.equal(parsePolicyAllowanceYuan("1.999").cents, null);
    assert.equal(parsePolicyAllowanceYuan("-1").cents, null);
    assert.equal(parsePolicyAllowanceYuan("").cents, null);
    assert.equal(parsePolicyAllowanceYuan("1e3").cents, null);
    assert.equal(parsePolicyAllowanceYuan("0").cents, null);
    assert.equal(parsePolicyAllowanceYuan(`${"9".repeat(23)}.99`).cents, null);

    // Human discount and Haff-M inputs convert exactly, never through floating multiplication.
    assert.equal(parseHumanDiscount("8折"), "0.8");
    assert.equal(parseHumanDiscount("8.5折"), "0.85");
    assert.equal(parseHumanDiscount("8.1234折"), "0.81234");
    assert.equal(parseHumanDiscount("原价"), "1");
    assert.equal(parseHumanDiscount("0.8"), "0.8");
    assert.equal(parseHumanDiscount("0折"), null);
    assert.equal(parseHumanDiscount("abc"), null);
    assert.equal(parseHaffMillions("60"), "60000000");
    assert.equal(parseHaffMillions("60M"), "60000000");
    assert.equal(parseHaffMillions("0.5"), "500000");
    assert.equal(parseHaffMillions("0"), null);
    assert.equal(parseHaffMillions("1.1234567"), null);
    assert.equal(exactPercentTenths(1n, 3n), 333n);
    assert.equal(formatTenthsPercent(-333n), "-33.3%");
    assert.equal(formatTenthsPercent(0n), "0.0%");
  } finally {
    await vite.close();
  }
});
