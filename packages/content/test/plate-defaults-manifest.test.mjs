// 默认内容确认清单守卫（P2 起常驻）：34 条默认内容与 manifest.confirmed.json 逐条比对。
// 任一文件改动都会使摘要不符；初始化（content-bootstrap）依赖同一份清单。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validatePlateDocument, extractPlate, plateDigest } from "../plate-schema.mjs";

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../defaults");
const sha256 = buf => createHash("sha256").update(buf).digest("hex");
const strip = s => s.replace(/\s+/g, "");
const abs = rel => path.join(defaultsDir, rel);
const manifest = JSON.parse(fs.readFileSync(abs("manifest.confirmed.json"), "utf8"));
const presetFor = kind => kind === "legal" ? "legal" : kind;

test("确认清单恰好 34 条（24 help + 6 notice + 1 update + 3 legal）且文件齐全", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.confirmationSource, "owner-chat-approval-2026-11-12");
  assert.equal(manifest.items.length, 34);
  const counts = manifest.items.reduce((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { help: 24, notice: 6, update: 1, legal: 3 });
  for (const item of manifest.items) {
    assert.ok(fs.existsSync(abs(item.file)), `缺失 ${item.file}`);
    assert.match(item.digest, /^[0-9a-f]{64}$/);
    assert.ok(item.confirmedBy && item.confirmedAt);
  }
});

test("plate 默认内容摘要与清单一致且 publish 校验通过", async () => {
  for (const item of manifest.items) {
    if (item.file.endsWith(".txt")) continue;
    const entry = JSON.parse(fs.readFileSync(abs(item.file), "utf8"));
    assert.equal(entry.key, item.key);
    assert.equal(await plateDigest(entry.document), item.digest, `${item.key} 摘要不符`);
    const result = validatePlateDocument(entry.document, { preset: presetFor(item.kind), mode: "publish" });
    assert.ok(result.ok, `${item.key} publish 校验失败：${JSON.stringify(result.errors.slice(0, 4))}`);
  }
});

test("notice 可见字 ≤1200，update 投影 ≤20000 字节", () => {
  for (const item of manifest.items) {
    if (item.file.endsWith(".txt")) continue;
    const entry = JSON.parse(fs.readFileSync(abs(item.file), "utf8"));
    const plain = extractPlate(entry.document).plainText;
    if (item.kind === "notice") assert.ok(plain.length <= 1200, `${item.key} 可见字超过 1200`);
    if (item.kind === "update") assert.ok(new TextEncoder().encode(plain).length <= 20000, `${item.key} 投影超过 20000 字节`);
  }
});

test("legal 去空白逐字等于 source 原文且 sourceSha256 匹配", () => {
  for (const item of manifest.items.filter(i => i.kind === "legal" && !i.file.endsWith(".txt"))) {
    const entry = JSON.parse(fs.readFileSync(abs(item.file), "utf8"));
    assert.ok(entry.source && entry.sourceSha256, `${item.key} 应带 source 与 sourceSha256`);
    const sourceBuf = fs.readFileSync(abs(entry.source));
    assert.equal(sha256(sourceBuf), entry.sourceSha256, `${item.key} sourceSha256 不匹配`);
    assert.equal(strip(extractPlate(entry.document).plainText), strip(sourceBuf.toString("utf8")), `${item.key} 去空白后与原文不一致`);
  }
});

test("early-settlement-v1.txt 摘要命中清单与金标准", () => {
  const item = manifest.items.find(i => i.file === "legal/early-settlement-v1.txt");
  assert.ok(item);
  const digest = sha256(fs.readFileSync(abs(item.file)));
  assert.equal(digest, item.digest);
  assert.equal(digest, "81f4072ced38de89f047c6c09522145d6a2ce904462a42b8e89405c4c116717d");
});