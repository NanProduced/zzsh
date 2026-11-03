// Conservative CI scope: run affected applications and their database contracts. Unknown paths
// expand to full instead of silently skipping coverage.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const normalize = (file) => file.replaceAll("\\", "/");

export function classify(input) {
  const files = input.map(normalize).filter(Boolean);
  const known = /^(apps\/(?:api|web|admin)\/|packages\/|scripts\/|docs\/|assets\/|\.github\/|package(?:-lock)?\.json$|tsconfig[^/]*$|AGENTS\.md$|README(?:\.md)?$|\.node-version$|\.gitignore$|\.editorconfig$)/;
  const full = files.length === 0 || files.some((file) =>
    file === "package.json" || file === "package-lock.json" || file === "AGENTS.md" || file === ".node-version" ||
    /^apps\/(?:api|web|admin)\/package\.json$/.test(file) ||
    file.startsWith("packages/") || file.startsWith("scripts/") || file.startsWith(".github/") ||
    file.startsWith("docs/testing.md") || file.startsWith("docs/development.md") ||
    file.startsWith("docs/local-postgresql.md") || file.startsWith("tsconfig") ||
    !known.test(file));
  const api = full || files.some((file) => file.startsWith("apps/api/"));
  const web = full || files.some((file) => file.startsWith("apps/web/"));
  const admin = full || files.some((file) => file.startsWith("apps/admin/"));
  // API helpers and fixture/admission code participate in real DB contracts too; do not infer
  // a test's storage boundary from whether its filename happens to contain "postgres".
  const pg = full || files.some((file) => /^apps\/api\/(?:src|test|scripts|migrations)\//.test(file));
  return { full, api, web, admin, pg };
}

export function changedFiles(env = process.env, run = execFileSync) {
  const base = env.BASE_SHA?.trim(), head = env.HEAD_SHA?.trim();
  if (!base || !head) return [];
  // Include both halves of cross-domain renames; NUL avoids quoting/newline ambiguities.
  const output = run("git", ["diff", "--no-renames", "--name-only", "-z", base, head, "--"], { encoding: "utf8" });
  return output.split("\0").map(normalize).filter(Boolean);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = classify(changedFiles());
  for (const [key, value] of Object.entries(result)) console.log(`${key}=${value}`);
}
