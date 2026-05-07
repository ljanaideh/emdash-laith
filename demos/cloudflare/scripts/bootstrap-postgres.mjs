/**
 * Bootstrap script — runs EmDash migrations against a PostgreSQL database.
 *
 * Run as part of the deploy command, or manually:
 *
 *   DATABASE_URL="postgres://user:pass@host:5432/db" node scripts/bootstrap-postgres.mjs
 */

import { runMigrations } from "emdash/db";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	console.error("Error: DATABASE_URL environment variable is required.");
	process.exit(1);
}

console.log("Connecting to PostgreSQL...");
const ssl = process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString, max: 1, ssl });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

try {
	console.log("Running migrations...");
	const { applied } = await runMigrations(db);

	if (applied.length === 0) {
		console.log("No new migrations — database is already up to date.");
	} else {
		console.log(`Applied ${applied.length} migration(s):`);
		for (const m of applied) {
			console.log(`  ✓ ${m}`);
		}
	}
} finally {
	await pool.end();
}
