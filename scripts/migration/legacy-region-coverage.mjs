// Compares the legacy account region values with the published region word list.
//
// The word list is the frozen UI dictionary extracted from the legacy publish page. The migration must
// not truncate it, invent entries or rewrite legacy values: every source pair is reported as matched,
// unknown (a value the word list does not carry) or missing (an account with no usable region), so the
// initialisation can be judged against real numbers instead of an assumption.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha = value => createHash("sha256").update(value).digest("hex");

export function parseRegionWordList(text) {
  const pairs = [...text.matchAll(/"province":\s*"([^"]*)"\s*,\s*"city":\s*"([^"]*)"/g)].map(m => [m[1], m[2]]);
  const seen = new Set();
  for (const [province, city] of pairs) {
    const key = province + "/" + city;
    if (seen.has(key)) throw new Error("REGION_WORD_LIST_DUPLICATE:" + key);
    seen.add(key);
    if (!province || !city) throw new Error("REGION_WORD_LIST_EMPTY_VALUE");
  }
  return { pairs, digest: sha(pairs.map(pair => pair.join("/")).join("\n")) };
}

/** `rows` are {province, city, accounts} as read from the legacy table. */
export function compareLegacyRegions(wordList, rows) {
  const known = new Set(wordList.pairs.map(pair => pair.join("/")));
  const matched = [], unknown = [], missing = [];
  for (const row of rows) {
    const province = row.province ?? "", city = row.city ?? "";
    if (!province || !city) { missing.push({ province, city, accounts: row.accounts }); continue; }
    const key = province + "/" + city;
    (known.has(key) ? matched : unknown).push({ province, city, accounts: row.accounts });
  }
  const sum = list => list.reduce((n, row) => n + row.accounts, 0);
  return {
    schema: "zzsh.legacy-region-coverage.v1",
    wordList: { pairs: wordList.pairs.length, digest: wordList.digest },
    sourcePairs: rows.length,
    matchedPairs: matched.length, unknownPairs: unknown.length, missingPairs: missing.length,
    sourceAccounts: sum(rows), matchedAccounts: sum(matched), unknownAccounts: sum(unknown), missingAccounts: sum(missing),
    // Never truncate: the caller decides what to do with an unknown value, and it stays visible here.
    unknown: unknown.sort((a, b) => b.accounts - a.accounts),
    missing: missing.sort((a, b) => b.accounts - a.accounts),
  };
}

export function parseRegionPairsTsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [province = "", city = "", accounts = "0"] = line.split("\t");
    const count = Number(accounts);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("REGION_PAIR_COUNT_INVALID");
    rows.push({ province, city, accounts: count });
  }
  return rows;
}
