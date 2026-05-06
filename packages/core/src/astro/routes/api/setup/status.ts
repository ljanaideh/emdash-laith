/**
 * GET /_emdash/api/setup/status
 *
 * Returns setup status and seed file information
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { getAuthMode } from "#auth/mode.js";
import { withTransaction } from "#db/transaction.js";
import { loadUserSeed } from "#seed/load.js";

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Read all setup-state values in a single transaction so Hyperdrive
		// bypasses its query cache and we always see the latest written values.
		const { isComplete, hasUsers, setupState } = await withTransaction(emdash.db, async (trx) => {
			const completeRow = await trx
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:setup_complete")
				.executeTakeFirst();

			const complete =
				completeRow &&
				(() => {
					try {
						const parsed = JSON.parse(completeRow.value);
						return parsed === true || parsed === "true";
					} catch {
						return false;
					}
				})();

			const countResult = await trx
				.selectFrom("users")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.executeTakeFirst();
			const foundUsers = Number(countResult?.count ?? 0) > 0;

			const stateRow = await trx
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:setup_state")
				.executeTakeFirst();
			const state = stateRow
				? (() => {
						try {
							return JSON.parse(stateRow.value);
						} catch {
							return null;
						}
					})()
				: null;

			return { isComplete: complete, hasUsers: foundUsers, setupState: state };
		});

		// Setup is complete only if flag is set AND users exist
		if (isComplete && hasUsers) {
			return apiSuccess({
				needsSetup: false,
			});
		}

		// Determine current step
		// step: "start" | "site" | "admin" | "complete"
		let step: "start" | "site" | "admin" = "start";

		if (setupState) {
			if (setupState.step === "admin") {
				step = "admin";
			} else if (setupState.step === "site") {
				step = "site";
			}
		}

		// If setup_complete but no users, jump to admin step
		if (isComplete && !hasUsers) {
			step = "admin";
		}

		// Check auth mode
		const authMode = getAuthMode(emdash.config);
		const useExternalAuth = authMode.type === "external";

		// In external auth mode, setup is complete if flag is set (no users required initially)
		if (useExternalAuth && isComplete) {
			return apiSuccess({
				needsSetup: false,
			});
		}

		// Setup needed - try to load seed file info
		const seed = await loadUserSeed();
		const seedInfo = seed
			? {
					name: seed.meta?.name || "Unknown Template",
					description: seed.meta?.description || "",
					collections: seed.collections?.length || 0,
					hasContent: !!(seed.content && Object.keys(seed.content).length > 0),
				}
			: null;

		return apiSuccess({
			needsSetup: true,
			step,
			seedInfo,
			// Tell the wizard which auth mode is active
			authMode: useExternalAuth ? authMode.providerType : "passkey",
		});
	} catch (error) {
		return handleError(error, "Failed to check setup status", "SETUP_STATUS_ERROR");
	}
};
