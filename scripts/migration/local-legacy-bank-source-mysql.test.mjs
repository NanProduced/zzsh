import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { legacyBankPrivateComparisonDigest, verifyLegacyBankMysqlSnapshot } from "./local-legacy-bank-source.mjs";

const container = process.env.ZZSH_BANK_SYNTHETIC_CONTAINER_ID;
test("synthetic MySQL streams and verifies 174,846 bank hashes in one read-only transaction", { skip: !container, timeout: 60000 }, async () => {
  assert.match(container, /^[a-f0-9]{64}$/);
  const inspection = spawnSync("docker", ["inspect", container, "--format", "{{json .}}"], { encoding: "utf8", timeout: 5000 });
  assert.equal(inspection.status, 0);
  const instance = JSON.parse(inspection.stdout);
  assert.equal(instance.Id, container);
  assert.equal(instance.Name, "/zzsh-bank-source-synthetic-20261110");
  assert.equal(instance.Config.Labels?.["zzsh.synthetic"], "bank-source-v1");
  assert.equal(instance.HostConfig.NetworkMode, "none");
  assert.deepEqual(instance.Mounts, []);
  assert.match(instance.HostConfig.Tmpfs?.["/var/lib/mysql"] ?? "", /^rw,nosuid,size=512m$/);
  const salt = "a".repeat(64), rows = Array.from({ length: 174846 }, (_, i) => ({
    user_id: String(i + 1), name: `synthetic-${i + 1}`, card_no: String(i + 1).padStart(16, "0"),
    create_time: "1760000000", update_time: "1760000001",
  }));
  const digest = legacyBankPrivateComparisonDigest(rows, salt);
  await verifyLegacyBankMysqlSnapshot(container, salt, rows.length, digest);
  await assert.rejects(verifyLegacyBankMysqlSnapshot(container, salt, rows.length, "0".repeat(64)), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
  await assert.rejects(verifyLegacyBankMysqlSnapshot(container, salt, rows.length - 1, digest), /LEGACY_BANK_SOURCE_VERIFICATION_FAILED/);
});
