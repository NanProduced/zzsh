import fs from "node:fs";
import path from "node:path";
import {createRequire,Module} from "node:module";
import {fileURLToPath} from "node:url";

const tree=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../.."),require=createRequire(path.join(tree,"package.json")),ts=require("typescript");
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
      const source=resolveSource(name,file);
      if(source&&/\.(?:tsx?|jsx?)$/.test(source))return load(source);
      return native(name);
    };
    const source=fs.readFileSync(file,"utf8");
    m._compile(ts.transpileModule(source,{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
    return m.exports;
  };
  return {ssrLoadModule:async url=>load(path.join(root,url.replace(/^\//,""))),close:async()=>cache.clear()};
}
