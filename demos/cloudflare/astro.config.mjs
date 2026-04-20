// @ts-check
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import {
	d1,
	r2,
	sandbox,
//	cloudflareCache,
} from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

import { notifyOnPublishPlugin } from "@emdash-cms/plugin-notify-on-publish";

export default defineConfig({
	output: "server",
	adapter: cloudflare({
		imageService: "cloudflare",
	}),
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "es"],
		fallback: {
			fr: "en",
			es: "en",
		},
	},
	image: {
		// Enable responsive images globally
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			// D1 database - binding name must match wrangler.jsonc
			// session: "auto" enables read replicas (nearest replica for anon,
			// bookmark-based consistency for authenticated users)
			database: d1({ binding: "DB", session: "auto" }),
			// R2 storage for media
			storage: r2({ binding: "MEDIA" }),
			// Cloudflare Access authentication
			// Reads CF_ACCESS_AUDIENCE from env (wrangler secret or .dev.vars)
			// Media providers - Cloudflare Images and Stream
			// Reads from env vars at runtime: CF_ACCOUNT_ID, CF_IMAGES_TOKEN, CF_STREAM_TOKEN
			// Or customize with accountIdEnvVar/apiTokenEnvVar options
			// Trusted plugins (run in host worker)
			plugins: [
				// Test plugin that exercises all v2 APIs
				formsPlugin(),
				notifyOnPublishPlugin({
                                recipients: ["ljanaideh@atypon.com"],
                                collections: ["posts"],
                                from: "onboarding@resend.dev",
                                siteUrl: "https://emdash-laith.laithaljanaideh.workers.dev",
                              }),
	//			notifyOnPublishPlugin({
        //                          recipients: (process.env.EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean),
        //                          collections: ["posts"],
        //                          from: process.env.EMAIL_FROM || "onboarding@resend.dev",
        //                          siteUrl: process.env.SITE_URL || "https://emdash-laith.laithaljanaideh.workers.dev",
        //                        }),
			],
			// Sandboxed plugins (run in isolated workers)
			sandboxed: [],
			// Sandbox runner for Cloudflare
			sandboxRunner: sandbox(),
			// Plugin marketplace
			marketplace: "https://marketplace.emdashcms.com",
		}),
	],
	experimental: {
	//	cache: {
	//		provider: cloudflareCache(),
	//	},
		routeRules: {
			"/": {
				maxAge: 3_600,
				swr: 864_000,
			},
			"/[...slug]": {
				maxAge: 3_600,
				swr: 864_000,
			},
		},
	},
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-sans",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
