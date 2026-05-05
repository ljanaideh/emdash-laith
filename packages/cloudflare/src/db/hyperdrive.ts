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

// How long (ms) to wait for a Hyperdrive TCP connect before giving up.
// pg-pool's built-in connectionTimeoutMillis relies on stream.destroy(), which
// does not terminate pending connections in the Workers Node.js compat layer —
// so we enforce the deadline ourselves via Promise.race.
const CONNECT_TIMEOUT_MS = 8_000;

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
		const cs = binding.connectionString;
		console.log(`[hyperdrive] init binding=${config.binding} cs_prefix=${cs.slice(0, 30)}...`);
		pool = new Pool({
			connectionString: cs,
			max: config.pool?.max ?? 5,
			// Hyperdrive handles TLS termination; disable pg's SSL layer to avoid
			// TLS-within-TLS in the Workers runtime.
			ssl: false,
		});

		// pg-pool's connectionTimeoutMillis fires a timer then calls
		// stream.destroy() to abort the in-flight TCP connect. stream.destroy()
		// is a no-op in the Workers Node.js compat layer, so the connect callback
		// is never called and the Worker hangs. We override pool.connect() with a
		// Promise.race to enforce the deadline reliably.
		const _origConnect = pool.connect.bind(pool);
		// eslint-disable-next-line typescript-eslint(no-explicit-any) -- duck-type override on pg Pool
		(pool as any).connect = () =>
			Promise.race([
				_origConnect(),
				new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error(
									`[hyperdrive] connect timeout after ${CONNECT_TIMEOUT_MS}ms — ` +
										`check Hyperdrive binding "${config.binding}" and RDS reachability`,
								),
							),
						CONNECT_TIMEOUT_MS,
					),
				),
			]);

		pools.set(config.binding, pool);
	}
	return new PostgresDialect({ pool });
}
