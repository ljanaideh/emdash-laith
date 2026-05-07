/**
 * Cloudflare Hyperdrive runtime adapter - RUNTIME ENTRY
 *
 * Creates a Kysely PostgresDialect that establishes a fresh pg.Client for
 * every query. Hyperdrive handles connection pooling to the real database on
 * the Cloudflare network; the Worker only needs an ephemeral connection to
 * Hyperdrive's local proxy per query.
 *
 * WHY NOT a module-scoped Pool?
 *   Hyperdrive may provide a different connectionString per Worker request
 *   (or per isolate startup). A cached Pool bakes in the first request's CS;
 *   subsequent connect() calls on the stale Pool hang indefinitely in the
 *   Workers Node.js compat layer when the endpoint has changed or the idle
 *   connection was closed server-side. Creating a fresh Client per query
 *   re-reads env.HYPERDRIVE.connectionString every time, which is always
 *   current regardless of when the isolate started.
 *
 * Do NOT import this at config time — use { hyperdrive } from "@emdash-cms/cloudflare" instead.
 */

import { env } from "cloudflare:workers";
import { PostgresDialect } from "kysely";
import { Client, type Pool } from "pg";

interface HyperdriveConfig {
	binding: string;
	pool?: { max?: number };
}

interface HyperdriveBinding {
	connectionString: string;
}

// How long to wait for a Hyperdrive TCP connect before giving up.
const CONNECT_TIMEOUT_MS = 8_000;

function getBinding(bindingName: string): HyperdriveBinding {
	const binding = (env as Record<string, unknown>)[bindingName] as HyperdriveBinding | undefined;
	if (!binding) {
		throw new Error(
			`Hyperdrive binding "${bindingName}" not found in environment. ` +
				`Add it to your wrangler.jsonc:\n\n` +
				`  "hyperdrive": [{ "binding": "${bindingName}", "id": "your-hyperdrive-config-id" }]`,
		);
	}
	return binding;
}

export function createDialect(config: HyperdriveConfig): PostgresDialect {
	// Validate the binding exists at dialect creation time.
	getBinding(config.binding);

	// Fake pool: Kysely only needs connect() + end().
	// We re-read env.HYPERDRIVE.connectionString on every connect() so we
	// always use the current CS, even if it changes between requests.
	const fakePool = {
		connect: async (): Promise<Client & { release: (destroy?: boolean) => Promise<void> }> => {
			const binding = getBinding(config.binding);
			const cs = binding.connectionString;

			const connectPromise = (async () => {
				const client = new Client({
					connectionString: cs,
					// Hyperdrive handles TLS to the database; the Worker connects
					// to Hyperdrive's local proxy without TLS.
					ssl: false,
				});
				await client.connect();
				// Kysely calls release() when it's done with the connection.
				// We close the Client rather than returning it to a pool.
				(client as Client & { release: (destroy?: boolean) => Promise<void> }).release = async (
					_destroy?: boolean,
				) => {
					await client.end().catch(() => {});
				};
				return client as Client & { release: (destroy?: boolean) => Promise<void> };
			})();

			return Promise.race([
				connectPromise,
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
		},
		// Called by Kysely.destroy() — nothing to clean up.
		end: async (): Promise<void> => {},
	};

	// Cast: Kysely only uses connect() + end() at runtime; the full Pool type
	// is not required.
	return new PostgresDialect({ pool: fakePool as unknown as Pool });
}
