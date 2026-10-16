import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";

const require = createRequire(import.meta.url);

const railSource = readFileSync(new URL("../src/components/support/support-rail.tsx", import.meta.url), "utf8");

test("preview=1 is gated on a non-production NODE_ENV at the support rail", () => {
  // 源码级合同：演示数据只允许非生产环境通过 ?preview=1 打开，生产构建忽略该参数。
  assert.match(
    railSource,
    /setPreview\(\s*process\.env\.NODE_ENV !== "production" && new URLSearchParams\(window\.location\.search\)\.get\("preview"\) === "1"\s*\)/,
    "the rail must ignore ?preview=1 when NODE_ENV is production",
  );
});

// 与 auth-entry-behavior 同一转译执行手法：stub react hooks，让 useEffect 立即跑，
// 直接读出 useState 槽位验证 preview 门控在 production 下不激活。
function runRail(nodeEnv, search) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    const code = ts.transpileModule(railSource, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
    const states = [];
    let index = 0;
    const exports = {};
    new Function("require", "exports", "window", "document", code)(name => {
      if (name === "react") return {
        ...React,
        useState(initial) { const i = index++; states[i] = initial; return [initial, value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
        useRef: value => ({ current: value }),
        useCallback: fn => fn,
        useEffect(callback) { callback(); },
      };
      if (name === "next/navigation") return { usePathname: () => "/" };
      if (name === "next/link") return { default: () => null };
      if (name.includes("auth-overlay-provider")) return { useAuthOverlay: () => ({ open() {} }) };
      if (name === "./contact-popover") return { ContactPopover: () => null };
      if (name === "./customer-support-workspace") return { CustomerSupportWorkspace: () => null };
      if (name === "@radix-ui/react-dialog") return {
        Root: () => null,
        Portal: () => null,
        Overlay: () => null,
        Content: () => null,
        Title: () => null,
        Description: () => null,
      };
      if (name.endsWith(".css")) return {};
      return require(name);
    }, exports, {
      location: { pathname: "/", search },
      addEventListener() {},
      removeEventListener() {},
    }, { querySelector() { return null; } });
    exports.SupportRail();
    // SupportRail 的 useState 顺序：supportOpen(0)、requestedType(1)、preview(2)…
    return states[2];
  } finally {
    process.env.NODE_ENV = previous;
  }
}

test("functional gate: ?preview=1 activates preview off production and stays off under production", () => {
  assert.equal(runRail("test", "?preview=1"), true, "non-production builds keep the preview demo reachable");
  assert.equal(runRail("production", "?preview=1"), false, "production builds ignore ?preview=1");
  assert.equal(runRail("test", ""), false, "without the parameter preview stays off");
});
