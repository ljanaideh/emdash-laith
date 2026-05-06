import type { PluginDescriptor } from "emdash";

export function notifyPostmarkPlugin(): PluginDescriptor {
	return {
		id: "notify-postmark",
		version: "1.0.0",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-notify-postmark/sandbox",
		capabilities: ["read:content", "network:fetch"],
		allowedHosts: ["api.postmarkapp.com"],
		options: {},
	};
}
