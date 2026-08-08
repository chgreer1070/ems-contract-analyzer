import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";
import { assertTrustedMigrationTarget, verifiedDatabaseConnectionConfig } from "./database-connection-config.mjs";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const pool = new Pool({
  ...verifiedDatabaseConnectionConfig(process.env.DATABASE_URL,"contracttwin-auth-migrator",{requireVerifiedTls:process.env.APP_ENV==="production"})
});

try {
  const targetClient=await pool.connect();
  try{await assertTrustedMigrationTarget(targetClient);}finally{targetClient.release();}
  const migrationAuth = betterAuth({ database: pool });
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(migrationAuth.options);
  console.log(`Better Auth schema: ${toBeCreated.length} tables to create, ${toBeAdded.length} fields/indexes to add.`);
  await runMigrations();
  const migratedTargetClient=await pool.connect();
  try{await assertTrustedMigrationTarget(migratedTargetClient);}finally{migratedTargetClient.release();}
  console.log("Better Auth schema migration complete.");
} finally {
  await pool.end();
}
