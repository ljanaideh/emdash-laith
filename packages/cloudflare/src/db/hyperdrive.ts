/**
 * Cloudflare Hyperdrive runtime adapter - RUNTIME ENTRY
 *
 * Creates a Kysely PostgresDialect backed by a module-scoped pg.Pool that
 * connects through Hyperdrive's connection proxy.
 *
 * Do NOT import this at config time — use { hyperdrive } from "@emdash-cms/cloudflare" instead.
 */

import { env } from "cloudflare:workers";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";

interface HyperdriveConfig {
	binding: string;
	pool?: { max?: number };
}

interface HyperdriveBinding {
	connectionString: string;
}

// Module-scope singleton pools keyed by binding name.
// Stored on globalThis to survive Vite SSR module duplication (see CLAUDE.md).
const POOL_KEY = Symbol.for("emdash.hyperdrive.pools");
if (!(globalThis as Record<symbol, unknown>)[POOL_KEY]) {
	(globalThis as Record<symbol, unknown>)[POOL_KEY] = new Map<string, Pool>();
}
const pools = (globalThis as Record<symbol, unknown>)[POOL_KEY] as Map<string, Pool>;

export function createDialect(config: HyperdriveConfig): PostgresDialect {
	let pool = pools.get(config.binding);
	if (!pool) {
		const binding = (env as Record<string, unknown>)[config.binding] as
			| HyperdriveBinding
			| undefined;
		if (!binding) {
			throw new Error(
				`Hyperdrive binding "${config.binding}" not found in environment. ` +
					`Add it to your wrangler.jsonc:\n\n` +
					`  "hyperdrive": [{ "binding": "${config.binding}", "id": "your-hyperdrive-config-id" }]`,
			);
		}
		pool = new Pool({
			connectionString: binding.connectionString,
			max: config.pool?.max ?? 5,
		});
		pools.set(config.binding, pool);
	}
	return new PostgresDialect({ pool });
}
