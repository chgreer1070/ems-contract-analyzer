import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import pg from "pg";

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: "contracttwin-auth-migrator"
});

try {
  const migrationAuth = betterAuth({ database: pool });
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(migrationAuth.options);
  console.log(`Better Auth schema: ${toBeCreated.length} tables to create, ${toBeAdded.length} fields/indexes to add.`);
  await runMigrations();
  console.log("Better Auth schema migration complete.");
} finally {
  await pool.end();
}
