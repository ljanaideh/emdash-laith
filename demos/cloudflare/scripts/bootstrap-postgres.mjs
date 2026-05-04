/**
 * Bootstrap script — runs EmDash migrations against a PostgreSQL database.
 *
 * Run once from your local machine before the first Cloudflare deployment:
 *
 *   DATABASE_URL="postgres://emdash_app:<password>@<host>:5432/emdash_dev" \
 *     node scripts/bootstrap-postgres.mjs
 */

import { Kysely } from "kysely";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { runMigrations } from "emdash/db";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
	console.error("Error: DATABASE_URL environment variable is required.");
	console.error(
		'  Example: DATABASE_URL="postgres://user:pass@host:5432/db" node scripts/bootstrap-postgres.mjs',
	);
	process.exit(1);
}

console.log("Connecting to PostgreSQL...");
const pool = new Pool({ connectionString, max: 1 });

const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

try {
	console.log("Running migrations...");
	const { applied } = await runMigrations(db);

	if (applied.length === 0) {
		console.log("No new migrations to apply — database is already up to date.");
	} else {
		console.log(`Applied ${applied.length} migration(s):`);
		for (const m of applied) {
			console.log(`  ✓ ${m}`);
		}
	}
} finally {
	await pool.end();
}
