// Runs the same compiled test file set as before; spawns node directly to avoid the Windows cmd.exe 8191-char limit.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = JSON.parse(readFileSync(new URL("./compiled-tests.json", import.meta.url), "utf8"));
const result = spawnSync(process.execPath, ["--import", "../../scripts/assert-offline-env.mjs", "--test", ...files, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
