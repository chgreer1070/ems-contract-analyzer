import type { ClientConfig } from "pg";

// Omitting pg_catalog keeps PostgreSQL's implicit catalog-first lookup while
// leaving public as the first explicit (and therefore object-creation) schema.
export const SAFE_DATABASE_STARTUP_OPTIONS="-c search_path=public,pg_temp";
type VerifiedDatabaseClientConfig=ClientConfig&{enableChannelBinding:true};

export function verifiedDatabaseConnectionConfig(
  connectionString:string,
  applicationName:string,
  requireVerifiedTls=process.env.APP_ENV==="production"||process.env.VERCEL_ENV==="production"
):VerifiedDatabaseClientConfig{
  let parsed:URL;
  try{parsed=new URL(connectionString);}catch{throw new Error("Database connection URL is invalid.");}
  if(!["postgres:","postgresql:"].includes(parsed.protocol))throw new Error("Database connection URL must use PostgreSQL.");
  if(parsed.searchParams.has("options"))throw new Error("Database connection URL may not override the controlled startup search path.");
  if(requireVerifiedTls){
    if(process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined||process.env.PGOPTIONS!==undefined||process.env.PGSSLMODE!==undefined){
      throw new Error("Production database connections reject inherited TLS or PostgreSQL option overrides.");
    }
    const sslModes=parsed.searchParams.getAll("sslmode").map(value=>value.toLowerCase());
    if(sslModes.length!==1||sslModes[0]!=="verify-full"){
      throw new Error("Production database connections require sslmode=verify-full.");
    }
  }
  return {
    connectionString,
    application_name:applicationName,
    options:SAFE_DATABASE_STARTUP_OPTIONS,
    enableChannelBinding:true
  };
}
