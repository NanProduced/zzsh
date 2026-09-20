import { invalid } from "./supply-util";
import { parsePublicListingSearch } from "./listing-query";

export const LISTING_URL_BYTES=8192;
export const LISTING_OPERATORS={resources:"AND_MIN",safeBoxCodes:"ANY",vitality:"MIN",bear:"MIN",gradingCodes:"ANY",loginMethodCodes:"ANY",regions:"PAIRS_ANY",serviceWindow:"COVERS",skinGroups:"GROUPS"} as const;
export type FilterKey=keyof typeof LISTING_OPERATORS;
export type Region={province:string;city:string};
export type ServiceWindow={startMinute:number;endMinute:number;crossMidnight:boolean;timezone:"Asia/Shanghai"};
export type ListingFilters={resources?:{itemId:string;minQuantity:string}[];safeBoxCodes?:string[];vitality?:{min:number};bear?:{min:number};gradingCodes?:string[];loginMethodCodes?:string[];regions?:Region[];serviceWindow?:ServiceWindow;skinGroups?:{categoryId:string;ids:string[];match:"ANY"|"ALL"}[]};
export type ListingSort="latest"|"resourceTotal"|"coreQuantity";
export type FilterField={key:FilterKey;operator:string;label:string;enabled:boolean;order:number;items?:{itemId:string;min:string;max:string}[];options?:{value:string;label:string}[];levels?:number[];regions?:Region[];categoryIds?:string[]};
export type FilterConfig={schemaVersion:1;fields:FilterField[];sorts:{key:ListingSort;label:string;enabled:boolean;order:number;itemIds?:string[]}[]};
export type ListingQueryV2={queryVersion:2;gameId:string;q:string|null;filters:ListingFilters;sort:ListingSort;direction:"ASC"|"DESC";coreItemId:string|null;limit:number;cursor:string|null;filterRevision:string|null;catalogRevision:string|null;ruleReleaseId:string|null};
export function checkedObject(v:unknown,path:string,keys:readonly string[]):Record<string,unknown> {
  if(!v || typeof v!=="object" || Array.isArray(v))throw invalid("Expected an object",path);
  for(const k of Object.keys(v))if(!keys.includes(k))throw invalid("Unsupported field",path?path+"."+k:k);
  return v as Record<string,unknown>;
}
export function checkedText(v:unknown,path:string,max=128):string {
  if(typeof v!=="string" || !v.trim() || v.length>max || /[\u0000-\u001f]/.test(v))throw invalid("Invalid text",path);
  return v.normalize("NFC").trim();
}
export function checkedId(v:unknown,path:string):string {const s=checkedText(v,path);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)||s!==v)throw invalid("Invalid identifier",path);return s;}
export function checkedQuantity(v:unknown,path:string):string {if(typeof v!=="string"||!/^(0|[1-9]\d{0,23})$/.test(v))throw invalid("Expected base-unit integer text within numeric(24,0)",path);return v;}
function array(v:unknown,path:string,max:number):unknown[]{if(!Array.isArray(v)||v.length>max)throw invalid("Array exceeds limit or is invalid",path);return v;}
function unique<T>(values:T[],path:string,key:(v:T)=>string):T[]{const keys=values.map(key);if(new Set(keys).size!==keys.length)throw invalid("Duplicate condition",path);return values.sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);}
function codes(v:unknown,path:string,max=50):string[]{return unique(array(v,path,max).map(x=>checkedText(x,path)),path,x=>x);}
function ids(v:unknown,path:string,max:number):string[]{return unique(array(v,path,max).map(x=>checkedId(x,path)),path,x=>x);}
function integer(v:unknown,path:string,max=2147483647):number{if(typeof v!=="number"||!Number.isSafeInteger(v)||v<0||v>max)throw invalid("Invalid integer",path);return v;}
export function parseServiceWindow(v:unknown,path="filters.serviceWindow"):ServiceWindow {
  const o=checkedObject(v,path,["startMinute","endMinute","crossMidnight","timezone"]);
  const startMinute=integer(o.startMinute,path+".startMinute",1439),endMinute=integer(o.endMinute,path+".endMinute",1440);
  if(typeof o.crossMidnight!=="boolean"||o.timezone!=="Asia/Shanghai"||startMinute===endMinute||o.crossMidnight!==(endMinute<startMinute))throw invalid("Inconsistent service window",path);
  return {startMinute,endMinute,crossMidnight:o.crossMidnight,timezone:"Asia/Shanghai"};
}
function regions(v:unknown,path:string,max:number):Region[]{return unique(array(v,path,max).map(x=>{const r=checkedObject(x,path,["province","city"]);return {province:checkedText(r.province,path+".province",64),city:checkedText(r.city,path+".city",64)};}),path,x=>JSON.stringify(x));}
export function parseListingFilters(v:unknown):ListingFilters {
  const o=checkedObject(v,"filters",Object.keys(LISTING_OPERATORS)),f:ListingFilters={};
  if(o.resources!==undefined){const values=unique(array(o.resources,"filters.resources",16).map(x=>{const r=checkedObject(x,"filters.resources",["itemId","minQuantity"]);return {itemId:checkedId(r.itemId,"filters.resources.itemId"),minQuantity:checkedQuantity(r.minQuantity,"filters.resources.minQuantity")};}),"filters.resources",x=>x.itemId);if(values.length)f.resources=values;}
  for(const key of ["safeBoxCodes","gradingCodes","loginMethodCodes"] as const)if(o[key]!==undefined){const a=codes(o[key],"filters."+key);if(a.length)f[key]=a;}
  for(const key of ["vitality","bear"] as const)if(o[key]!==undefined){const r=checkedObject(o[key],"filters."+key,["min"]);f[key]={min:integer(r.min,"filters."+key+".min")};}
  if(o.regions!==undefined){const a=regions(o.regions,"filters.regions",20);if(a.length)f.regions=a;}
  if(o.serviceWindow!==undefined)f.serviceWindow=parseServiceWindow(o.serviceWindow);
  if(o.skinGroups!==undefined){const a=unique(array(o.skinGroups,"filters.skinGroups",8).map(x=>{const r=checkedObject(x,"filters.skinGroups",["categoryId","ids","match"]);if(r.match!=="ANY"&&r.match!=="ALL")throw invalid("Invalid skin match","filters.skinGroups.match");return {categoryId:checkedId(r.categoryId,"filters.skinGroups.categoryId"),ids:ids(r.ids,"filters.skinGroups.ids",50),match:r.match as "ANY"|"ALL"};}),"filters.skinGroups",x=>x.categoryId);const all=a.flatMap(g=>g.ids);if(all.length>50||new Set(all).size!==all.length)throw invalid("Duplicate or excessive skin IDs","filters.skinGroups.ids");const nonempty=a.filter(g=>g.ids.length);if(nonempty.length)f.skinGroups=nonempty;}
  return f;
}
export function assertListingUrlBudget(raw:string){if(Buffer.byteLength(raw,"utf8")>LISTING_URL_BYTES)throw invalid("Query URL exceeds 8KiB","url");}
export function parseListingQueryV2(q:URLSearchParams,raw:string):ListingQueryV2 {
  assertListingUrlBudget(raw);
  const allowed=["queryVersion","gameId","q","filters","sort","direction","coreItemId","limit","cursor","filterRevision","catalogRevision","ruleReleaseId","view"];
  for(const key of q.keys())if(!allowed.includes(key)||q.getAll(key).length!==1)throw invalid("Unknown or repeated query parameter",key);
  if(q.get("queryVersion")!=="2")throw invalid("Unsupported query version","queryVersion");
  const gameId=checkedId(q.get("gameId"),"gameId"),sort=q.get("sort")??"latest",direction=q.get("direction")??"DESC";
  if(!["latest","resourceTotal","coreQuantity"].includes(sort))throw invalid("Invalid sort","sort");
  if(direction!=="ASC"&&direction!=="DESC")throw invalid("Invalid direction","direction");
  const coreItemId=q.has("coreItemId")?checkedId(q.get("coreItemId"),"coreItemId"):null;
  if((sort==="coreQuantity")!==(coreItemId!==null))throw invalid("coreQuantity requires an explicit core item only","coreItemId");
  const limitText=q.get("limit")??"20";if(!/^[1-9]\d?$/.test(limitText)||Number(limitText)>50)throw invalid("Limit must be 1–50","limit");
  let value:unknown={};if(q.has("filters")){try{value=JSON.parse(q.get("filters")!);}catch{throw invalid("Malformed filter JSON","filters");}}
  for(const key of ["filterRevision","catalogRevision"])if(q.has(key)&&!(/^[1-9]\d{0,18}$/.test(q.get(key)!)))throw invalid("Invalid revision",key);
  if(q.has("view")&&!['list','card'].includes(q.get("view")!))throw invalid("Invalid view","view");
  return {queryVersion:2,gameId,q:parsePublicListingSearch(q.get("q")),filters:parseListingFilters(value),sort:sort as ListingSort,direction,coreItemId,limit:Number(limitText),cursor:q.get("cursor"),filterRevision:q.get("filterRevision"),catalogRevision:q.get("catalogRevision"),ruleReleaseId:q.has("ruleReleaseId")?checkedId(q.get("ruleReleaseId"),"ruleReleaseId"):null};
}
export function parseFilterConfig(value:unknown):FilterConfig {
  const c=checkedObject(value,"config",["schemaVersion","fields","sorts"]);if(c.schemaVersion!==1)throw invalid("Unsupported config schema","config.schemaVersion");
  const fields=unique(array(c.fields,"config.fields",9).map(x=>{
    const f=checkedObject(x,"config.fields",["key","operator","label","enabled","order","items","options","levels","regions","categoryIds"]),key=f.key as FilterKey;
    if(typeof key!=="string"||!Object.hasOwn(LISTING_OPERATORS,key)||f.operator!==LISTING_OPERATORS[key])throw invalid("Unsupported filter logic","config.fields.key");
    const optionKey=key==="resources"?"items":key==="skinGroups"?"categoryIds":key==="regions"?"regions":key==="vitality"||key==="bear"?"levels":key==="serviceWindow"?null:"options";
    for(const name of ["items","options","levels","regions","categoryIds"])if(name!==optionKey && f[name]!==undefined)throw invalid("Unsupported field parameters","config.fields."+name);
    if(typeof f.enabled!=="boolean")throw invalid("Enabled must be boolean","config.fields.enabled");
    const field:FilterField={key,operator:LISTING_OPERATORS[key],label:checkedText(f.label,"config.fields.label",40),enabled:f.enabled,order:integer(f.order,"config.fields.order",1000)};
    if(optionKey==="items")field.items=unique(array(f.items,"config.fields.items",16).map(x=>{const i=checkedObject(x,"config.fields.items",["itemId","min","max"]);const min=checkedQuantity(i.min,"config.fields.items.min"),max=checkedQuantity(i.max,"config.fields.items.max");if(BigInt(min)>BigInt(max))throw invalid("Reversed quantity range","config.fields.items");return {itemId:checkedId(i.itemId,"config.fields.items.itemId"),min,max};}),"config.fields.items",x=>x.itemId);
    if(optionKey==="options")field.options=unique(array(f.options,"config.fields.options",200).map(x=>{const v=checkedObject(x,"config.fields.options",["value","label"]);return {value:checkedText(v.value,"config.fields.options.value"),label:checkedText(v.label,"config.fields.options.label",40)};}),"config.fields.options",x=>x.value);
    if(optionKey==="levels")field.levels=unique(array(f.levels,"config.fields.levels",100).map(x=>integer(x,"config.fields.levels")),"config.fields.levels",String);
    if(optionKey==="regions")field.regions=regions(f.regions,"config.fields.regions",200);
    if(optionKey==="categoryIds")field.categoryIds=ids(f.categoryIds,"config.fields.categoryIds",100);
    return field;
  }),"config.fields",x=>x.key);
  const sorts=unique(array(c.sorts,"config.sorts",3).map(x=>{const s=checkedObject(x,"config.sorts",["key","label","enabled","order","itemIds"]);if(!["latest","resourceTotal","coreQuantity"].includes(s.key as string)||typeof s.enabled!=="boolean")throw invalid("Unsupported sort","config.sorts");const key=s.key as ListingSort,label=checkedText(s.label,"config.sorts.label",40);if(key==="latest"&&label!=="最新发布")throw invalid("Latest must be named 最新发布","config.sorts.label");if(key!=="coreQuantity"&&s.itemIds!==undefined)throw invalid("Unsupported sort parameters","config.sorts.itemIds");return {key,label,enabled:s.enabled,order:integer(s.order,"config.sorts.order",1000),...(key==="coreQuantity"?{itemIds:ids(s.itemIds,"config.sorts.itemIds",16)}:{})};}),"config.sorts",x=>x.key);
  if(!sorts.some(s=>s.key==="latest"&&s.enabled))throw invalid("Enabled latest sort is required","config.sorts");
  return {schemaVersion:1,fields,sorts};
}
