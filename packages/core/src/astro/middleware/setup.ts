/**
 * Setup detection middleware
 *
 * Redirects to setup wizard if the site hasn't been set up yet.
 * Checks both "emdash:setup_complete" option AND user existence.
 *
 * Detection logic (in order):
 * 1. Does options table exist? No → setup needed
 * 2. Is setup_complete true? No → setup needed
 * 3. In passkey mode: Are there any users? No → setup needed
 *    In Access mode: Skip user check (first user created on first login)
 * 4. Proceed to admin
 */

import { defineMiddleware } from "astro:middleware";

import { getAuthMode } from "../../auth/mode.js";
import { withTransaction } from "../../database/transaction.js";

export const onRequest = defineMiddleware(async (context, next) => {
	// Only check setup on admin routes (but not the setup page itself)
	const isAdminRoute = context.url.pathname.startsWith("/_emdash/admin");
	const isSetupRoute = context.url.pathname.startsWith("/_emdash/admin/setup");

	if (isAdminRoute && !isSetupRoute) {
		// Check if setup is complete
		const { emdash } = context.locals;

		if (!emdash?.db) {
			// No database configured - let the admin handle this error
			return next();
		}

		try {
			// Read setup_complete and user count in a single transaction so
			// Hyperdrive bypasses its query cache and we always see the values
			// written by the preceding setup/admin-verify request.
			const { isComplete, userCount } = await withTransaction(emdash.db, async (trx) => {
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

				return { isComplete: complete, userCount: Number(countResult?.count ?? 0) };
			});

			if (!isComplete) {
				return context.redirect("/_emdash/admin/setup");
			}

			const authMode = getAuthMode(emdash.config);

			if (authMode.type === "passkey" && userCount === 0) {
				return context.redirect("/_emdash/admin/setup");
			}
		} catch (error) {
			// If the options table doesn't exist yet, redirect to setup
			// This handles fresh installations where migrations haven't run
			if (
				error instanceof Error &&
				(error.message.includes("no such table") || error.message.includes("does not exist"))
			) {
				return context.redirect("/_emdash/admin/setup");
			}

			// Other errors - let the admin handle them
			console.error("Setup middleware error:", error);
		}
	}

	return next();
});
