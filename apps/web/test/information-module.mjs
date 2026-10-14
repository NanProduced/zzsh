import fs from "node:fs";
import path from "node:path";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const typescript = requireFromTree("typescript");

/**
 * 载入 apps/web/src/components/ui/information.tsx 供组件行为测试挂载。
 * 六类信息组件是纯展示组件，测试只需覆盖样式无关的结构与无障碍属性。
 */
export function loadInformation(overrides = {}) {
  const file = path.join(tree, "apps/web/src/components/ui/information.tsx");
  const module = new Module(file);
  module.filename = file;
  module.paths = Module._nodeModulePaths(path.dirname(file));
  const native = module.require.bind(module);
  module.require = (name) => overrides[name] ?? (name.endsWith(".css") ? {} : native(name));
  module._compile(
    typescript.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        jsx: typescript.JsxEmit.ReactJSX,
        target: typescript.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  );
  return module.exports;
}
