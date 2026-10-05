import {invalid} from '../supply/supply-util';
/** Exact accounting integer shared by legacy and native wallet projections. */
export function exactCents(value:unknown):string {
 if(typeof value!=='string'||! /^-?(0|[1-9]\d{0,23})$/.test(value)||value==='-0')throw invalid('Invalid exact cents');
 return value;
}
