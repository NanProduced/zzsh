import {invalid} from '../supply/supply-util';
/** Exact accounting integer shared by legacy and native wallet projections. */
export function exactCents(value:unknown):string {
 if(typeof value!=='string'||! /^-?(0|[1-9]\d{0,23})$/.test(value)||value==='-0')throw invalid('Invalid exact cents');
 return value;
}
export function sourceYuanToCents(value:unknown):string {
 if(typeof value!=="string" || !/^(0|[1-9]\d{0,21})\.\d{2}$/.test(value))throw invalid("Invalid source amount");
 return BigInt(value.replace(".","")).toString();
}
export function sourceSignedYuanToCents(value:unknown):string {
 if(typeof value!=="string"||! /^-?(0|[1-9]\d{0,21})\.\d{2}$/.test(value)||value==='-0.00')throw invalid('Invalid signed source amount');
 return BigInt(value.replace('.','')).toString();
}
