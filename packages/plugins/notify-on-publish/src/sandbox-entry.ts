import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import type { NotifyOnPublishOptions } from "./index.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "cms@example.com";
const DEFAULT_API_KEY_ENV = "RESEND_API_KEY";

interface ContentSaveEvent {
  collection: string;
  content: {
    id: string;
    title?: string;
    slug?: string;
    status: string;
    publishedAt?: string;
  };
  previous?: { status?: string };
}

export default definePlugin({
  hooks: {
    "content:afterSave": {
      handler: async (event: ContentSaveEvent, ctx: PluginContext) => {
        const opts = ((ctx as any).options ?? {}) as NotifyOnPublishOptions;

        if (opts.collections && !opts.collections.includes(event.collection)) return;

        const nowPublished = event.content.status === "published";
        const wasPublished = event.previous?.status === "published";
        if (!nowPublished || wasPublished) return;

        const recipients = opts.recipients ?? [];
        if (recipients.length === 0) {
          ctx.log.warn("notify-on-publish: no recipients configured");
          return;
        }

        const envVar = opts.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV;
        const apiKey = resolveEnv(ctx, envVar);
        if (!apiKey) {
          ctx.log.error(
            `notify-on-publish: ${envVar} not set — add it to .dev.vars or \`wrangler secret put ${envVar}\``,
          );
          return;
        }

        const kvKey = `sent:${event.collection}:${event.content.id}`;
        if (await ctx.kv.get<boolean>(kvKey)) {
          ctx.log.info(`notify-on-publish: already sent for ${kvKey}`);
          return;
        }

        const title = event.content.title ?? event.content.id;
        const slug = event.content.slug ?? event.content.id;
        const publishedAt = event.content.publishedAt ?? new Date().toISOString();
        const previewLink = opts.siteUrl
          ? `${opts.siteUrl.replace(/\/$/, "")}/${slug}`
          : undefined;

        const textBody = [
          `"${title}" was just published.`,
          ``,
          `Collection: ${event.collection}`,
          `Slug:       ${slug}`,
          `Published:  ${publishedAt}`,
          previewLink ? `\nView:       ${previewLink}` : "",
        ].filter(Boolean).join("\n");

        const htmlBody = `
<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;">
  <h2 style="margin:0 0 16px;">Published: ${escapeHtml(title)}</h2>
  <table style="font-size:14px;line-height:1.6;color:#333;">
    <tr><td style="padding-right:12px;color:#666;">Collection</td><td>${escapeHtml(event.collection)}</td></tr>
    <tr><td style="padding-right:12px;color:#666;">Slug</td><td><code>${escapeHtml(slug)}</code></td></tr>
    <tr><td style="padding-right:12px;color:#666;">Published</td><td>${escapeHtml(publishedAt)}</td></tr>
  </table>
  ${previewLink ? `<p style="margin-top:20px;"><a href="${escapeHtml(previewLink)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block;">View content →</a></p>` : ""}
</div>`.trim();

        try {
          const res = await fetch(RESEND_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: opts.from ?? DEFAULT_FROM,
              to: recipients,
              subject: `Published: ${title}`,
              text: textBody,
              html: htmlBody,
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Resend ${res.status}: ${errText.slice(0, 500)}`);
          }

          const { id } = (await res.json()) as { id?: string };
          await ctx.kv.set(kvKey, true, { ttl: 60 * 60 * 24 * 30 });

          ctx.log.info(
            `notify-on-publish: sent to ${recipients.length} recipient(s) for ${event.collection}/${event.content.id} (resend id: ${id ?? "unknown"})`,
          );
        } catch (err) {
          ctx.log.error(
            `notify-on-publish: send failed for ${event.content.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          throw err;
        }
      },
    },
  },
});

function resolveEnv(ctx: PluginContext, name: string): string | undefined {
  const env = (ctx as any).env;
  if (env && typeof env[name] === "string") return env[name];
  const g = globalThis as any;
  if (typeof g[name] === "string") return g[name];
  if (g.process?.env?.[name]) return g.process.env[name];
  return undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
