import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import React from "react";
import { DEFAULT_RESOURCES, RESOURCE_SCHEMA } from "@zzsh/content";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."), cache = new Map();
function load(relative) {
  const file = path.join(tree, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const module = new Module(file), native = createRequire(file);
  module.filename = file; module.paths = Module._nodeModulePaths(path.dirname(file)); cache.set(file, module);
  module.require = name => {
    if (name.endsWith(".css")) return {};
    if (name === "next/link") return ({ children, ...props }) => React.createElement("a", props, children);
    if (name === "@zzsh/ui/content-document" || name === "./content-document") return load("packages/ui/src/content-document.tsx");
    if (name === "@zzsh/ui/content-markdown") return load("packages/ui/src/content-markdown.tsx");
    return contentFixtureDependency(name) ?? native(name);
  };
  module._compile(ts.transpileModule(readFileSync(file,"utf8"), { fileName:file, compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true} }).outputText,file);
  return module.exports;
}
// Transaction and picker tests use builtin explanatory content; live reads have separate contract/browser checks.
export const loadContentFixture = load;
export function contentFixtureDependency(name) {
  if (name === "@/components/content/platform-update-notices") return { BusinessUpdateNotices: () => null };
  if (["./public-content-provider", "@/components/content/public-content-provider"].includes(name)) return { usePublicContent: key => ({status:"ready",resource:{schema:RESOURCE_SCHEMA,key,source:"BUILTIN",state:"available",payload:DEFAULT_RESOURCES[key] ?? null,media:[]},retry(){}}) };
  if (name === "@/components/content/managed-notice") return load("apps/web/src/components/content/managed-notice.tsx");
  if (name === "@/components/content/market-content") return load("apps/web/src/components/content/market-content.tsx");
  if (["./catalog-item-art", "@/components/supply/catalog-item-art"].includes(name)) return load("apps/web/src/components/supply/catalog-item-art.tsx");
}
