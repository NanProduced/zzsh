// Synthetic memory probe for the prepare stage. It reproduces the loader's shape - one JSON object per
// source row with the same field counts as the real capture - without any real personal data, then
// measures what holding every domain at once actually costs. It never reads the capture, never touches
// a database and never writes outside its own temporary directory.
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";


const root = process.argv[2];
if (!root) throw new Error("USAGE: node local-prepare-memory-benchmark.mjs <empty-dir>");
if (existsSync(root)) throw new Error("BENCHMARK_DIR_MUST_NOT_EXIST");
mkdirSync(root, { recursive: true });

const SHAPE = {
  users: { rows: 174846, fields: 28 },
  accounts: { rows: 52398, fields: 82 },
  orders: { rows: 40065, fields: 75 },
  earnings: { rows: 47586, fields: 12 },
  withdraws: { rows: 20503, fields: 17 },
  pays: { rows: 41672, fields: 10 },
  refunds: { rows: 11138, fields: 14 },
  distribution: { rows: 174842, fields: 10 },
  distributionOrders: { rows: 9994, fields: 18 },
  orderAfter: { rows: 11136, fields: 22 },
};

const fill = (index, fields) => {
  const row = { id: String(index) };
  for (let i = 1; i < fields; i++) row["f" + i] = i % 3 === 0 ? String(index * i) : i % 3 === 1 ? "text-" + (index % 97) : null;
  return row;
};

const started = performance.now();
const files = {};
for (const [domain, { rows, fields }] of Object.entries(SHAPE)) {
  const file = join(root, domain + ".jsonl");
  const stream = createWriteStream(file);
  for (let i = 1; i <= rows; i++) if (!stream.write(JSON.stringify(fill(i, fields)) + "\n")) await new Promise(resolve => stream.once("drain", resolve));
  await new Promise(resolve => stream.end(resolve));
  files[domain] = file;
}
const generatedMs = performance.now() - started;

let peak = 0;
const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
const timer = setInterval(sample, 20);
const loadStarted = performance.now();
const data = {}, ids = {};
for (const [domain, file] of Object.entries(files)) {
  data[domain] = [];
  const seen = new Set();
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) if (line) { const raw = JSON.parse(line); seen.add(raw.id); data[domain].push(raw); sample(); }
  reader.close();
  ids[domain] = seen.size;
}
// The prepare stage also keeps a per-domain id set and re-walks every domain for the scope digest.
const digests = {};
for (const domain of Object.keys(data)) digests[domain] = data[domain].length + ids[domain];
const loadMs = performance.now() - loadStarted;
clearInterval(timer);
sample();

const totals = Object.fromEntries(Object.entries(SHAPE).map(([domain, { rows }]) => [domain, rows]));
console.log(JSON.stringify({
  schema: "zzsh.prepare-memory-benchmark.v1",
  synthetic: true,
  rows: totals,
  totalRows: Object.values(totals).reduce((n, v) => n + v, 0),
  generatedMs: Math.round(generatedMs),
  loadMs: Math.round(loadMs),
  peakRssBytes: peak,
  peakRssMiB: Math.round(peak / 1048576),
  heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
  heapTotalMiB: Math.round(process.memoryUsage().heapTotal / 1048576),
  note: "Synthetic rows with the real field counts; excludes the real capture, the planner work and the output files.",
}, null, 2));
rmSync(root, { recursive: true, force: true });
