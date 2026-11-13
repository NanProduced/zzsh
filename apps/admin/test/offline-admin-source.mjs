import fs from "node:fs";
import path from "node:path";
import {createRequire,Module} from "node:module";
import {fileURLToPath} from "node:url";

const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../.."),require=createRequire(path.join(tree,"package.json")),ts=require("typescript");
// Reuse only emitted JS. Each loader still evaluates fresh modules for the case.
const compiled = new Map();

/** Current T component probes use the same in-memory TypeScript loading as Web tests: no Vite, listener, optimizer or dependency write. */
export async function createOfflineAdminSource(options){
  const root=options.root,cache=new Map();
  const resolveSource=(name,from)=>{
    let base;
    if(name.startsWith("@/"))base=path.join(tree,"apps/admin/src",name.slice(2));
    else if(name.startsWith("."))base=path.resolve(path.dirname(from),name);
    else return null;
    for(const suffix of ["",".tsx",".ts",".js","/index.tsx","/index.ts"]){const p=base+suffix;if(fs.existsSync(p)&&fs.statSync(p).isFile())return p;}
    throw new Error("Missing component source: "+name);
  };
  const load=file=>{
    if(cache.has(file))return cache.get(file).exports;
    const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));cache.set(file,m);
    const native=createRequire(file);
    m.require=name=>{
      if(name.endsWith(".css"))return {};
      if(name.endsWith(".png"))return name;
      // Vite ?raw 导入（默认内容清单等）：离线按原文读取，与浏览器侧语义一致。
      if(name.endsWith("?raw")){const raw=resolveSource(name.slice(0,-4),file);return {__esModule:true,default:fs.readFileSync(raw,"utf8")};}
      const source=resolveSource(name,file);
      if(source&&/\.(?:tsx?|jsx?|mjs)$/.test(source))return load(source);
      if(name.startsWith("@zzsh/")){const shared=native.resolve(name);if(/\.(?:tsx?|jsx?)$/.test(shared))return load(shared);}
      return native(name);
    };
    const source = fs.readFileSync(file, "utf8");
    let artifact = compiled.get(file);
    if (artifact?.source !== source) {
      // Treat .mjs as .js so TypeScript emits CommonJS for Module._compile.
      const transpileName = file.endsWith(".mjs") ? file.slice(0, -4) + ".js" : file;
      const { outputText } = ts.transpileModule(source, {
        fileName: transpileName,
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      });
      artifact = { source, outputText };
      compiled.set(file, artifact);
    }
    m._compile(artifact.outputText, file);
    return m.exports;
  };
  return {ssrLoadModule:async url=>load(path.join(root,url.replace(/^\//,""))),close:async()=>cache.clear()};
}
