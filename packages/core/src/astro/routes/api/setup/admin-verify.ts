/**
 * POST /_emdash/api/setup/admin/verify
 *
 * Complete admin creation by verifying the passkey registration
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { verifyRegistrationResponse, registerPasskey } from "@emdash-cms/auth/passkey";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { setupAdminVerifyBody } from "#api/schemas.js";
import { createChallengeStore } from "#auth/challenge-store.js";
import { getPasskeyConfig } from "#auth/passkey-config.js";
import { OptionsRepository } from "#db/repositories/options.js";
import { withTransaction } from "#db/transaction.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Read all setup-state values in a single transaction so Hyperdrive
		// bypasses its query cache and we always see the values written by the
		// preceding admin-options request in the same setup flow.
		const { setupComplete, userCount, setupState } = await withTransaction(
			emdash.db,
			async (trx) => {
				const completeRow = await trx
					.selectFrom("options")
					.select("value")
					.where("name", "=", "emdash:setup_complete")
					.executeTakeFirst();
				const sc = completeRow
					? (() => {
							try {
								return JSON.parse(completeRow.value);
							} catch {
								return null;
							}
						})()
					: null;

				const countResult = await trx
					.selectFrom("users")
					.select((eb) => eb.fn.countAll<number>().as("count"))
					.executeTakeFirst();
				const uc = countResult?.count ?? 0;

				const stateRow = await trx
					.selectFrom("options")
					.select("value")
					.where("name", "=", "emdash:setup_state")
					.executeTakeFirst();
				const ss = stateRow
					? (() => {
							try {
								return JSON.parse(stateRow.value);
							} catch {
								return null;
							}
						})()
					: null;

				return { setupComplete: sc, userCount: uc, setupState: ss };
			},
		);

		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		if (!setupState || setupState.step !== "admin") {
			return apiError("INVALID_STATE", "Invalid setup state. Please restart setup.", 400);
		}

		const adapter = createKyselyAdapter(emdash.db);
		const options = new OptionsRepository(emdash.db);

		// Parse request body
		const body = await parseBody(request, setupAdminVerifyBody);
		if (isParseError(body)) return body;

		// Get passkey config
		const url = new URL(request.url);
		const siteName = (await options.get<string>("emdash:site_title")) ?? undefined;
		const siteUrl = getPublicOrigin(url, emdash?.config);
		const passkeyConfig = getPasskeyConfig(url, siteName, siteUrl);

		// Verify the registration response
		const challengeStore = createChallengeStore(emdash.db);

		const verified = await verifyRegistrationResponse(
			passkeyConfig,
			body.credential,
			challengeStore,
		);

		// Create the admin user
		const user = await adapter.createUser({
			email: setupState.email,
			name: setupState.name,
			role: Role.ADMIN,
			emailVerified: false, // No email verification for first user
		});

		// Register the passkey
		await registerPasskey(adapter, user.id, verified, "Setup passkey");

		// Mark setup as complete
		await options.set("emdash:setup_complete", true);

		// Clean up setup state
		await options.delete("emdash:setup_state");

		return apiSuccess({
			success: true,
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
			},
		});
	} catch (error) {
		return handleError(error, "Failed to verify admin setup", "SETUP_VERIFY_ERROR");
	}
};
