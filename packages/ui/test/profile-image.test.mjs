import assert from "node:assert/strict";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { Window } from "happy-dom";
import { createOfflineAdminSource } from "../../../apps/admin/test/offline-admin-source.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createOfflineAdminSource({ root });
const { ProfileImage, managedProfileImage } = await source.ssrLoadModule("/packages/ui/src/profile-image.tsx");
after(() => source.close());

test("profile image permits only managed avatar paths, never attachment or legacy URLs", () => {
  for (const value of ["/api/v1/profile/avatars/user/user_a/0", "/api/v1/profile/avatars/admin/admin_a/3", "/api/v1/profile/avatars/presets/avatar-strike/1/content"]) assert.equal(managedProfileImage(value), value);
  for (const value of [null, "https://legacy.invalid/a.jpg", "//external.invalid/a", "data:image/png,private", "blob:local-preview", "/api/im/images/asset", "/api/v1/profile/avatars/user/user_a/1?x=1", "/api/v1/profile/avatars/user/../1"]) assert.equal(managedProfileImage(value), null);
});

test("images render, revoked/error versions stop retrying, and changing identity cannot retain the old image", async () => {
  const browser = new Window({ url: "http://127.0.0.1:4241" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Node: browser.Node, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client"), node = browser.document.createElement("div"), rendered = createRoot(node);
  const a = "/api/v1/profile/avatars/user/user_a/1", b = "/api/v1/profile/avatars/user/user_b/2";
  const render = async (url, fallback) => act(async () => rendered.render(React.createElement(ProfileImage, { src: url, fallback, className: "member-image" })));
  try {
    await render(a, "甲"); const old = node.querySelector("img"); assert.equal(old.getAttribute("src"), a); assert.equal(old.alt, "");
    await act(async () => old.dispatchEvent(new browser.Event("error")));
    assert.equal(node.querySelector("img"), null); assert.equal(node.textContent, "甲");
    await render(a, "甲"); assert.equal(node.querySelector("img"), null, "the same missing/revoked URL is not recreated on a normal render");
    await render(b, "乙"); const fresh = node.querySelector("img"); assert.equal(fresh.getAttribute("src"), b); assert.notEqual(fresh, old);
    await act(async () => old.dispatchEvent(new browser.Event("error"))); assert.equal(node.querySelector("img"), fresh);
    await act(async () => fresh.dispatchEvent(new browser.Event("error"))); assert.equal(node.querySelector("img"), null); assert.equal(node.textContent, "乙");
    await render(null, "丙"); assert.equal(node.textContent, "丙"); assert.equal(node.querySelector("img"), null);
    await render("https://external.invalid/a.jpg", "丙"); assert.equal(node.querySelector("img"), null, "unsafe external values never start an image fetch");
  } finally { await act(async () => rendered.unmount()); browser.happyDOM.abort(); }
});
