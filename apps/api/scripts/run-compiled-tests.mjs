// Runs the same compiled test file set as before; spawns node directly to avoid the Windows cmd.exe 8191-char limit.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const files = JSON.parse(readFileSync(new URL("./compiled-tests.json", import.meta.url), "utf8"));
if (!Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length) {
  throw new Error("Compiled test manifest must contain unique test entries.");
}
for (const file of files) {
  // A deleted test can still have a compiled file left behind by TypeScript.
  if (!/^dist\/test\/[\w.-]+\.js$/.test(file)) throw new Error("Invalid compiled test entry: " + file);
  const source = file.slice("dist/".length, -".js".length) + ".ts";
  if (!existsSync(source)) throw new Error("Missing source for compiled test entry: " + source);
  if (!existsSync(file)) throw new Error("Missing compiled test entry: " + file + ". Run the API build first.");
}
const result = spawnSync(process.execPath, ["--import", "../../scripts/assert-offline-env.mjs", "--test", ...files, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
