import type {PoolClient} from 'pg';

/** Pre-0158 databases retain their original single-code contract. */
async function managedCodesInstalled(c:PoolClient){
 return (await c.query("SELECT to_regprocedure('zzsh_order.distribution_management_contract_version()') IS NOT NULL AS ready")).rows[0]?.ready===true;
}

export async function readCurrentInviteCodes(c:PoolClient,userId:string){
 const managed=await managedCodesInstalled(c);
 return (await c.query(`SELECT id,display_code,source_type FROM zzsh_order.distribution_invite_code WHERE user_id=$1${managed?' AND active':''} ORDER BY id`,[userId])).rows;
}

export async function resolveCurrentInviteCode(c:PoolClient,code:string){
 const managed=await managedCodesInstalled(c);
 return (await c.query(`SELECT * FROM zzsh_order.distribution_invite_code WHERE match_code=$1${managed?' AND active':''}`,[code.toUpperCase()])).rows[0];
}
