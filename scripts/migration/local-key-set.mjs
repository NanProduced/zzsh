// Per-row readback proves every planned object is correct. This proves the two sides are the same
// set: a target that is missing one object and carrying one extra object has the right total and the
// wrong contents, so counts alone must never be accepted as coverage.
import { createHash } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");

export function compareKeySets(sourceKeys, targetRows, { key = row => row.legacy_id, sample = 20 } = {}) {
  const source = new Set(sourceKeys.map(String));
  const target = new Set(targetRows.map(row => String(key(row))));
  const missing = [...source].filter(id => !target.has(id));
  const extra = [...target].filter(id => !source.has(id));
  return {
    source: source.size,
    target: target.size,
    missing: missing.length,
    extra: extra.length,
    sourceDigest: sha([...source].sort().join("\n")),
    targetDigest: sha([...target].sort().join("\n")),
    missingSample: missing.slice(0, sample),
    extraSample: extra.slice(0, sample),
    equal: missing.length === 0 && extra.length === 0,
  };
}
