import type { PluginDescriptor } from "emdash";

export function notifyOnPublishPlugin(): PluginDescriptor {
  return {
    id: "notify-on-publish",
    version: "1.0.0",
    format: "standard",
    entrypoint: "@emdash-cms/plugin-notify-on-publish/sandbox",
    capabilities: ["read:content", "network:fetch"],
    allowedHosts: ["api.resend.com", "webhook.site"],
    options: {},
  };
}
