import { canonicalize } from "./content-hash";
import { legacyResourceBaseQuantity } from "./legacy-observation";
import { publicTextPrivacyIssues } from "../legacy-load/legacy-public-admission";
import { invalid, sha256Hex } from "./supply-util";

export const LEGACY_DISPLAY_SCHEMA = "legacy-listing-display-v1";
const RESOURCES = [
  ["haff", "haff_base", "哈夫币"],
  ["awm_bullet_num", "awm_round", "AWM子弹"],
  ["level6_bullet_num", "level6_round", "6级子弹"],
  ["level6_helmet_num", "level6_helmet", "6级头盔"],
  ["level6_armor_num", "level6_armor", "6级护甲"],
  ["barrett_bullet_num", "legacy_barrett_round", "巴雷特子弹"],
  ["coffee_num", "coffee", "咖啡豆"],
  ["top_insure_card_num", "legacy_insurance_day", "顶级保险体验天数"],
] as const;
export type LegacyDisplaySnapshot = {
  schema: typeof LEGACY_DISPLAY_SCHEMA;
  rentalMode: "ordinary" | "custom" | "fast" | null;
  attributes: Record<string, string | number | boolean | null>;
  resources: Array<{ field: string; code: string; name: string; quantity: string | null; unit: string }>;
  risk: { highRiskOwner: boolean | null; banRecord: boolean | null; faceIsSelf: boolean | null };
  issues: string[];
};

/** Display facts only: source quantities never create native rentable inventory. */
export function convertLegacyDisplayFields(row: Record<string, unknown>): LegacyDisplaySnapshot {
  const issues: string[] = [];
  const integer = (field: string, min: number, max: number): number | null => {
    const value = row[field];
    if (value === null || value === undefined || value === "") { issues.push(`${field}:MISSING`); return null; }
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof text !== "string" || !/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < min || Number(text) > max) { issues.push(`${field}:OUT_OF_RANGE`); return null; }
    return Number(text);
  };
  const code = (field: string, values: Record<string, string>): string | null => {
    const value = row[field];
    if (typeof value !== "string" || !Object.hasOwn(values, value)) { issues.push(`${field}:UNMAPPED`); return null; }
    return values[value]!;
  };
  const region = (field: string): string | null => {
    const value = row[field];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || !/^[\p{L}\d-]{1,60}$/u.test(value) || publicTextPrivacyIssues(value).length) { issues.push(`${field}:UNSAFE`); return null; }
    return value;
  };
  const flag = (field: string): boolean | null => {
    const value = row[field];
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
    issues.push(`${field}:UNKNOWN`); return null;
  };
  const start = integer("processing_time_start", 0, 24), end = integer("processing_time_end", 0, 24);
  // 24:00 as a start is midnight; equal endpoints do not prove a full-day window.
  const startMinute = start === null ? null : start % 24 * 60, endMinute = end === null ? null : end * 60;
  const knownWindow = startMinute !== null && endMinute !== null && start !== end && startMinute !== endMinute;
  if (!knownWindow) issues.push("processing_time:AMBIGUOUS");
  const attributes: LegacyDisplaySnapshot["attributes"] = {
    safe_box_code: code("insure_lv", { "2":"safe_box_1x2", "4":"safe_box_2x2", "6":"safe_box_2x3", "9":"safe_box_3x3" }),
    grading_code: code("grading_lv", Object.fromEntries(Array.from({length:8},(_,i)=>[String(i+1),String(i+1)]))),
    login_method_code: code("login_way", { "1":"legacy_login_qq", "2":"legacy_login_wechat", "3":"legacy_login_steam_cn", "4":"legacy_login_steam_global" }),
    vit_level: integer("vit_lv",0,7), bear_level: integer("bear_lv",0,7), dive_level: integer("dive_lv",0,3), character_level: integer("character_lv",0,60),
    region_province: region("province"), region_city: region("city"),
    secret_kd: typeof row.secret_kd === "string" && /^(0|[1-9]\d{0,3})\.\d{2}$/.test(row.secret_kd) ? row.secret_kd : null,
    service_window_start_minute: knownWindow ? startMinute : null, service_window_end_minute: knownWindow ? endMinute : null,
    service_window_timezone: knownWindow ? "Asia/Shanghai" : null, service_window_cross_midnight: knownWindow ? endMinute! < startMinute! : null,
  };
  const resources = RESOURCES.map(([field,code,name]) => {
    try {
      const converted=legacyResourceBaseQuantity(field,row[field],"DAY");
      // Restored haff is M; the existing quantity helper accepts already-base haff.
      if(field==="haff"&&converted.quantity!==null) {
        converted.quantity=(BigInt(converted.quantity)*1000000n).toString();
        if(converted.quantity.length>24) throw invalid("Historical haff quantity is out of range");
      }
      return {field,code,name,...converted};
    }
    catch { issues.push(`${field}:INVALID`); return {field,code,name,quantity:null,unit:field==="top_insure_card_num"?"DAY":legacyResourceBaseQuantity(field,null).unit}; }
  });
  const rentalMode = code("ratio_type", {default:"ordinary",custom:"custom",fast:"fast"}) as LegacyDisplaySnapshot["rentalMode"];
  return {schema:LEGACY_DISPLAY_SCHEMA,rentalMode,attributes,resources,risk:{highRiskOwner:flag("high_risk_owner"),banRecord:flag("ban_record"),faceIsSelf:flag("face_is_self")},issues};
}

export function parseLegacyDisplaySnapshot(value: unknown): LegacyDisplaySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid legacy display snapshot");
  const x = value as LegacyDisplaySnapshot;
  if (Object.keys(x).sort().join(",") !== "attributes,issues,rentalMode,resources,risk,schema" || x.schema !== LEGACY_DISPLAY_SCHEMA || ![null,"ordinary","custom","fast"].includes(x.rentalMode)
    || !x.attributes || typeof x.attributes !== "object" || Array.isArray(x.attributes) || !x.risk || typeof x.risk !== "object" || Array.isArray(x.risk)
    || Object.keys(x.risk).sort().join(",") !== "banRecord,faceIsSelf,highRiskOwner" || Object.values(x.risk).some(v=>v!==null&&typeof v!=="boolean")
    || !Array.isArray(x.issues) || x.issues.some(v=>typeof v!=="string"||!/^\w+:[A-Z_]+$/.test(v)) || !Array.isArray(x.resources) || x.resources.length!==RESOURCES.length) throw invalid("Invalid legacy display facts");
  const allowed = ["safe_box_code","grading_code","login_method_code","vit_level","bear_level","dive_level","character_level","region_province","region_city","secret_kd","service_window_start_minute","service_window_end_minute","service_window_timezone","service_window_cross_midnight"];
  if (Object.keys(x.attributes).sort().join(",")!==allowed.sort().join(",")) throw invalid("Unexpected legacy display attribute");
  for (const [key,v] of Object.entries(x.attributes)) {
    if (v !== null && !["string","number","boolean"].includes(typeof v) || typeof v==="number"&&!Number.isSafeInteger(v)) throw invalid("Invalid display attribute",key);
    if (typeof v==="string" && (v.length>60 || key.startsWith("region_")&&(!/^[\p{L}\d-]{1,60}$/u.test(v)||publicTextPrivacyIssues(v).length))) throw invalid("Unsafe display attribute",key);
  }
  for(const [key,values] of Object.entries({safe_box_code:["safe_box_1x2","safe_box_2x2","safe_box_2x3","safe_box_3x3"],grading_code:["1","2","3","4","5","6","7","8"],login_method_code:["legacy_login_qq","legacy_login_wechat","legacy_login_steam_cn","legacy_login_steam_global"]})) {
    if(x.attributes[key]!==null&&!values.includes(x.attributes[key] as string)) throw invalid("Unmapped display code",key);
  }
  for(const [key,max] of [["vit_level",7],["bear_level",7],["dive_level",3],["character_level",60],["service_window_start_minute",1439],["service_window_end_minute",1440]] as const) {
    const v=x.attributes[key]; if(v!==null&&(typeof v!=="number"||v<0||v>max)) throw invalid("Invalid display level or window",key);
  }
  if(x.attributes.secret_kd!==null&&(typeof x.attributes.secret_kd!=="string"||!/^(0|[1-9]\d{0,3})\.\d{2}$/.test(x.attributes.secret_kd))) throw invalid("Invalid historical KD");
  const {service_window_start_minute:s,service_window_end_minute:e,service_window_timezone:tz,service_window_cross_midnight:cross}=x.attributes;
  if(s===null||e===null ? [s,e,tz,cross].some(v=>v!==null) : tz!=="Asia/Shanghai"||typeof cross!=="boolean"||s===e||cross!==(Number(e)<Number(s))) throw invalid("Ambiguous display window");
  for (let i=0;i<RESOURCES.length;i++) {
    const r=x.resources[i]!, [field,code,name]=RESOURCES[i]!, unit=legacyResourceBaseQuantity(field,null,"DAY").unit;
    if (!r || Object.keys(r).sort().join(",")!=="code,field,name,quantity,unit" || r.field!==field || r.code!==code || r.name!==name || r.unit!==unit || r.quantity!==null&&(typeof r.quantity!=="string"||!/^(0|[1-9]\d{0,23})$/.test(r.quantity))) throw invalid("Invalid display resource");
  }
  return JSON.parse(JSON.stringify(x)) as LegacyDisplaySnapshot;
}

export type LegacyDisplayInput = {
  observationVersionId: string; baseSourceDigest: string; extractSha256: string;
  sourceUpdatedAt: string; evidenceRef: string; snapshot: LegacyDisplaySnapshot;
};
export function legacyDisplayDigest(accountId: string, input: LegacyDisplayInput): string {
  return sha256Hex(canonicalize({accountId,...input,snapshot:parseLegacyDisplaySnapshot(input.snapshot)}));
}
