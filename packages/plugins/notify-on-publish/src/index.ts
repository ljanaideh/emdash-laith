import type { PluginDescriptor } from "emdash";

export interface NotifyOnPublishOptions {
  /** Recipients for publish notifications */
  recipients: string[];
  /** Only notify for these collections. Omit to notify for all. */
  collections?: string[];
  /** From address — must be a verified Resend sender */
  from?: string;
  /** Public site URL, used to build preview links */
  siteUrl?: string;
  /** Env var name for Resend API key (default: RESEND_API_KEY) */
  apiKeyEnvVar?: string;
}

export function notifyOnPublishPlugin(
  options: NotifyOnPublishOptions,
): PluginDescriptor {
  return {
    id: "notify-on-publish",
    version: "1.0.0",
    format: "standard",
    entrypoint: "@emdash-cms/plugin-notify-on-publish/sandbox",
    capabilities: ["read:content", "network:fetch"],
    allowedHosts: ["api.resend.com"],
    options,
  };
}
