import type { Principal } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";

export class RateLimitError extends Error {
  status=429;
  constructor(public action:string, public retryAfterSeconds:number){super(`Rate limit exceeded for ${action}. Retry later.`);}
}

export async function enforceRateLimit(principal:Principal,action:string,maxEvents:number,windowSeconds:number){
  if(principal.demo||!databaseConfigured())return;
  if(maxEvents<=0||windowSeconds<=0)throw new Error("Invalid rate limit configuration.");
  await withTransaction(async client=>{
    await client.query("select pg_advisory_xact_lock(hashtext($1))",[`contracttwin-rate:${principal.userId}:${action}`]);
    const count=await client.query<{count:string;oldest:Date|null}>(`select count(*)::text count,min(occurred_at) oldest from api_rate_events where actor_user_id=$1 and action=$2 and occurred_at>now()-make_interval(secs=>$3)`,[principal.userId,action,windowSeconds]);
    const current=Number(count.rows[0]?.count??0);
    if(current>=maxEvents){const oldest=count.rows[0]?.oldest?new Date(count.rows[0].oldest).getTime():Date.now();const retry=Math.max(1,Math.ceil((oldest+windowSeconds*1000-Date.now())/1000));throw new RateLimitError(action,retry);}
    await client.query("insert into api_rate_events(actor_user_id,action) values($1,$2)",[principal.userId,action]);
  });
}

export function rateLimitResponse(error:unknown){
  if(error instanceof RateLimitError)return Response.json({ok:false,error:error.message,retryAfterSeconds:error.retryAfterSeconds},{status:429,headers:{"Retry-After":String(error.retryAfterSeconds)}});
  return null;
}
