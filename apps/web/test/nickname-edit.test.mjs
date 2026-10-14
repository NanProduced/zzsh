import { test } from "node:test";
import assert from "node:assert/strict";
import { mountAuthComponent } from "./react-auth-harness.mjs";

// 昵称编辑已从账号安全页迁到总览「编辑资料」入口；这组用例承接原安全页昵称保障：
// 身份隔离、提交锁、未知结果恢复、草稿跨卸载保留、概况失败撤下入口（F1 同一语义）。
const file = "apps/web/src/components/account/nickname-edit.tsx";
const overview = { userId: "user_A", nickname: "自己的昵称", phoneNumber: "+8613800138000", email: null, passwordState: "not-set" };
const response = value => Response.json(value);
function handler(options = {}) {
  return async (url) => {
    if (url.endsWith("/security/overview")) {
      if (options.read) return options.read();
      return response({ ...overview, nickname: options.committed?.() ?? overview.nickname });
    }
    if (url.endsWith("/profile/nickname")) {
      if (options.write) return options.write();
      return response({ status: true });
    }
    return response({ status: true });
  };
}
const mount = (options = {}, props = {}) =>
  mountAuthComponent(file, "NicknameEditEntry", { userId: "user_A", ...props }, { initialStatus: "authenticated", fetch: handler(options) });
const writes = p => p.calls.filter(item => item.url.endsWith("/profile/nickname"));
const dialog = p => p.host.querySelector('[role="dialog"]');

test("概况读取成功后才出现编辑入口；读取失败与401都不出现（对齐安全页F1）", async () => {
  let mode = "ok";
  const p = await mount({ read: () => mode === "ok" ? response(overview) : Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }) });
  try {
    await p.settle();
    assert.ok(p.host.querySelector('[data-testid="edit-profile"]'));
    mode = "forbidden";
    // 重新触发读取：换主体重挂载（同主体读取失败时入口随事实撤下）
    await p.render({ key: "retry", userId: "user_A" });
    await p.settle();
    assert.equal(p.host.querySelector('[data-testid="edit-profile"]'), null, "概况失败撤下编辑入口");
  } finally { await p.close(); }
});

test("概况401经共享会话刷新撤下入口，不展示任何昵称事实", async () => {
  let revalidated = 0;
  const p = await mountAuthComponent(file, "NicknameEditEntry", { userId: "user_A" }, {
    initialStatus: "authenticated",
    fetch: async url => url.endsWith("/security/overview") ? Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }) : response({ status: true }),
    revalidate: () => { revalidated += 1; },
  });
  try {
    await p.settle();
    assert.equal(p.host.querySelector('[data-testid="edit-profile"]'), null);
    assert.equal(revalidated, 1);
    assert.doesNotMatch(p.host.textContent, /自己的昵称/);
  } finally { await p.close(); }
});

test("昵称校验沿用 1–64 规则，错误逐字段绑定", async () => {
  const p = await mount();
  try {
    await p.settle();
    await p.click("编辑资料");
    await p.input("profile-nickname", "   ");
    await p.submit('form[aria-label="修改昵称"]');
    assert.match(p.host.querySelector("#profile-nickname-result").textContent, /1–64/);
    assert.equal(p.host.querySelector("#profile-nickname").getAttribute("aria-invalid"), "true");
    assert.equal(writes(p).length, 0, "校验失败不发写入");
    await p.input("profile-nickname", "超".repeat(65));
    await p.submit('form[aria-label="修改昵称"]');
    assert.equal(writes(p).length, 0);
    assert.equal(p.host.querySelector("#profile-nickname").getAttribute("aria-invalid"), "true");
  } finally { await p.close(); }
});

test("保存成功只发一次写入、回读确认后关闭并清空草稿", async () => {
  const nicknameDraft = { current: null };
  let committed = false;
  const p = await mount({ committed: () => committed ? "新昵称" : overview.nickname, write: async () => { committed = true; return response({ status: true }); } }, { nicknameDraft });
  try {
    await p.settle();
    await p.click("编辑资料");
    assert.equal(p.host.querySelector("#profile-nickname").value, overview.nickname, "打开时采用服务端昵称");
    await p.input("profile-nickname", "新昵称");
    assert.equal(nicknameDraft.current.value, "新昵称", "草稿写入共享容器");
    await p.submit('form[aria-label="修改昵称"]');
    await p.settle();
    assert.equal(writes(p).length, 1);
    assert.equal(dialog(p), null, "确认成功后关闭");
    assert.equal(nicknameDraft.current, null, "成功后清空草稿");
    // 重新打开采用服务端已确认的新昵称。
    await p.click("编辑资料");
    assert.equal(p.host.querySelector("#profile-nickname").value, "新昵称");
  } finally { await p.close(); }
});

test("未知写入保留待确认意图：弹窗内可恢复，关闭后入口仍在，只查询不重发", async () => {
  const pendingWrite = { current: null }, nicknameDraft = { current: null };
  let committed = false;
  const p = await mount({
    committed: () => committed ? "新昵称" : overview.nickname,
    write: async () => { if (!committed) { committed = true; throw new Error("network dropped after apply"); } return response({ status: true }); },
  }, { pendingWrite, nicknameDraft });
  try {
    await p.settle();
    await p.click("编辑资料");
    await p.input("profile-nickname", "新昵称");
    await p.submit('form[aria-label="修改昵称"]');
    assert.match(p.host.textContent, /操作结果待确认/);
    assert.ok(p.findButton("保存昵称").disabled, "提交锁保持");
    assert.ok(pendingWrite.current, "意图写入共享容器");
    assert.equal(pendingWrite.current.intent.action, "nickname");
    // 关闭弹窗不丢意图：入口旁出现待确认提示。
    await p.click("取消");
    assert.ok(pendingWrite.current, "关闭后意图仍在");
    assert.match(p.host.textContent, /昵称修改结果待确认/);
    // 重新打开与页面级恢复走同一查询，不产生第二次写入。
    await p.click("重新确认结果");
    await p.settle();
    assert.equal(pendingWrite.current, null);
    assert.equal(writes(p).length, 1, "只有最初的那次写入");
    assert.equal(nicknameDraft.current, null);
  } finally { await p.close(); }
});

test("同主体重挂载保留未保存草稿；换主体丢弃草稿并读取新主体概况", async () => {
  let id = "user_A";
  const nicknameDraft = { current: null };
  const p = await mount({ read: () => response({ ...overview, userId: id }) }, { nicknameDraft });
  try {
    await p.settle();
    await p.click("编辑资料");
    await p.input("profile-nickname", "尚未保存的私人草稿");
    await p.render({ key: "same-user-confirmed" });
    await p.settle();
    await p.click("编辑资料");
    assert.equal(p.host.querySelector("#profile-nickname").value, "尚未保存的私人草稿");
    await p.click("取消");
    // 换主体：共享草稿按 userId 隔离，输入回落到新主体的服务端昵称。
    id = "user_B"; p.identity.userId = "user_B"; nicknameDraft.current = null;
    await p.render({ key: "changed-user", userId: "user_B" });
    await p.settle();
    await p.click("编辑资料");
    assert.equal(p.host.querySelector("#profile-nickname").value, overview.nickname);
    assert.doesNotMatch(p.host.textContent, /尚未保存的私人草稿/);
  } finally { await p.close(); }
});

// ===== repair-20261014 返修：F1 实时主体守卫 / F2 跨页意图互斥 / F3 成功后失权（反例回归底线） =====

for (const [label, mutate] of [
  ["A→B 换主体", (identity) => { identity.userId = "user_B"; }],
  ["退出登录变 guest", (identity) => { identity.status = "guest"; identity.userId = null; }],
  ["同主体 identityVersion 变化", (identity) => { identity.identityVersion += 1; }],
]) test(`F1 提交前同步核共享身份（${label}）阻断昵称 POST 并撤下入口`, async () => {
  const pendingWrite = { current: null };
  const p = await mount({}, { pendingWrite });
  try {
    await p.settle();
    await p.click("编辑资料");
    await p.input("profile-nickname", "新昵称");
    mutate(p.identity);
    await p.submit('form[aria-label="修改昵称"]');
    assert.equal(writes(p).length, 0, "共享身份已变化不发昵称写入");
    assert.equal(pendingWrite.current, null, "不写入共享意图");
    assert.equal(p.host.querySelector('[data-testid="edit-profile"]'), null, "旧主体入口撤下");
    assert.match(p.host.textContent, /登录状态已变化/);
  } finally { await p.close(); }
});

test("F1 迟到的概况响应在共享身份切换后不回填旧主体事实", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const p = await mount({ read: async () => { await gate; return response(overview); } });
  try {
    // 读取在途时共享会话换主体，props 尚未更新。
    p.identity.userId = "user_B";
    release();
    await p.settle();
    await p.settle();
    assert.equal(p.host.querySelector('[data-testid="edit-profile"]'), null, "迟到响应不回填编辑入口");
    assert.doesNotMatch(p.host.textContent, /自己的昵称/);
  } finally { release(); await p.close(); }
});

test("F3 保存403撤下编辑入口与旧概况，明确说明且不残留意图", async () => {
  const pendingWrite = { current: null };
  const p = await mount({ write: async () => Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }) }, { pendingWrite });
  try {
    await p.settle();
    await p.click("编辑资料");
    await p.input("profile-nickname", "新昵称");
    await p.submit('form[aria-label="修改昵称"]');
    await p.settle();
    assert.equal(writes(p).length, 1);
    assert.equal(p.host.querySelector('[data-testid="edit-profile"]'), null, "403 撤下编辑资格");
    assert.doesNotMatch(p.host.textContent, /自己的昵称/, "撤下旧概况事实");
    assert.equal(pendingWrite.current, null, "确定失败不残留意图");
    assert.match(p.host.textContent, /当前身份无法执行该操作/);
  } finally { await p.close(); }
});

test("F3 先成功再失权：确认读取403撤下入口但保留已接受意图，恢复只查询不重发", async () => {
  const pendingWrite = { current: null };
  let committed = false;
  const p = await mount({
    read: () => committed ? Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }) : response(overview),
    write: async () => { committed = true; return response({ status: true }); },
  }, { pendingWrite });
  try {
    await p.settle();
    await p.click("编辑资料");
    await p.input("profile-nickname", "新昵称");
    await p.submit('form[aria-label="修改昵称"]');
    await p.settle();
    assert.equal(writes(p).length, 1, "写入已发出");
    assert.equal(p.host.querySelector('[data-testid="edit-profile"]'), null, "确认读取403撤下编辑资格");
    assert.ok(pendingWrite.current, "已接受意图保留");
    assert.equal(pendingWrite.current.intent.action, "nickname");
    assert.equal(pendingWrite.current.accepted, true);
    assert.match(p.host.textContent, /昵称修改结果待确认/, "恢复入口留在页面上");
    const before = writes(p).length;
    await p.click("重新确认结果");
    await p.settle();
    assert.equal(writes(p).length, before, "恢复只查询不重发");
    assert.ok(pendingWrite.current, "确认读取仍403时意图不清除");
    assert.equal(pendingWrite.current.accepted, true, "已接受状态保留");
    assert.equal(p.host.querySelector('[data-testid="edit-profile"]'), null);
  } finally { await p.close(); }
});

test("F2 安全侧未决写入暂停昵称修改：说明、返回恢复入口、互斥与重挂载", async () => {
  const pendingWrite = { current: { userId: "user_A", intent: { action: "sessions", scope: "others" }, accepted: true, target: "" } };
  const original = pendingWrite.current;
  const p = await mount({}, { pendingWrite });
  try {
    await p.settle();
    assert.match(p.host.textContent, /其他操作结果待确认/, "给出暂停说明");
    assert.ok(p.host.querySelector('a[href="/account?view=security"]'), "返回安全页的恢复入口");
    await p.click("编辑资料");
    assert.match(dialog(p).textContent, /其他操作结果待确认/, "弹窗内同样给出说明");
    assert.ok(p.findButton("保存昵称").disabled, "表单与提交同步锁定");
    await p.submit('form[aria-label="修改昵称"]');
    await p.settle();
    assert.equal(writes(p).length, 0, "不发昵称写入");
    assert.equal(pendingWrite.current, original, "他类意图不被覆盖或清除");
    assert.equal(pendingWrite.current.accepted, true, "对方已接受状态保留");
    // 卸载/重挂载后互斥与说明仍在。
    await p.render({ key: "remount" });
    await p.settle();
    assert.equal(writes(p).length, 0, "重挂载后仍互斥");
    assert.equal(pendingWrite.current, original);
    assert.match(p.host.textContent, /其他操作结果待确认/);
  } finally { await p.close(); }
});

test("F2 他类意图在渲染之后到达也在调用时同步阻止新写", async () => {
  const pendingWrite = { current: null };
  const p = await mount({}, { pendingWrite });
  try {
    await p.settle();
    await p.click("编辑资料");
    await p.input("profile-nickname", "新昵称");
    // 安全页写入随后落入共享容器，本组件尚未重渲染。
    pendingWrite.current = { userId: "user_A", intent: { action: "password", operationId: "a".repeat(32) }, accepted: false, target: "" };
    const slot = pendingWrite.current;
    await p.submit('form[aria-label="修改昵称"]');
    await p.settle();
    assert.equal(writes(p).length, 0, "调用时活读共享容器并阻止新写");
    assert.equal(pendingWrite.current, slot, "不覆盖他类意图");
  } finally { await p.close(); }
});

test("same-user identityVersion changes discard an in-flight overview instead of reauthorizing it", async () => {
 let release; const gate = new Promise(resolve => { release = resolve; });
 const p = await mount({read: async () => { await gate; return response(overview); }});
 try { p.identity.identityVersion += 1; release(); await p.settle(); assert.equal(Boolean(p.host.querySelector('[data-testid="edit-profile"]')),false); }
 finally { await p.close(); }
});
