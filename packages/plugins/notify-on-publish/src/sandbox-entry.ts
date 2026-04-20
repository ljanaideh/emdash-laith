import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "onboarding@resend.dev";
const TARGET_COLLECTION = "posts";

interface ContentSaveEvent {
  collection: string;
  content: {
    id: string;
    title?: string;
    slug?: string;
    status: string;
    publishedAt?: string;
    email?: string;
    data?: Record<string, any>;
    [key: string]: any;
  };
  previous?: { status?: string };
}

export default definePlugin({
  hooks: {
    "content:afterSave": {
      handler: async (event: ContentSaveEvent, ctx: PluginContext) => {
        try {
          ctx.log.info(
            `[notify-on-publish] fired id=${event.content.id} status=${event.content.status} prev=${event.previous?.status ?? "(none)"}`,
          );

          if (event.collection !== TARGET_COLLECTION) return;
          if (event.content.status !== "published") return;

          const recipient =
            (event.content.email as string | undefined) ??
            (event.content.data?.email as string | undefined) ??
            (event.content as any).fields?.email ??
            findEmailDeep(event.content);

          if (!recipient) {
            ctx.log.warn(`[notify-on-publish] skip: no email field on post`);
            return;
          }

          const apiKey = resolveEnv(ctx, "RESEND_API_KEY");
          if (!apiKey) {
            ctx.log.error(`[notify-on-publish] RESEND_API_KEY not in ctx.env`);
            return;
          }

          const http = (ctx as any).http;
          if (!http?.fetch) {
            ctx.log.error(`[notify-on-publish] ctx.http.fetch unavailable`);
            return;
          }

          const title = event.content.title ?? event.content.id;
          const slug = event.content.slug ?? event.content.id;
          const publishedAt = event.content.publishedAt ?? new Date().toISOString();
          const from = resolveEnv(ctx, "EMAIL_FROM") ?? DEFAULT_FROM;

          ctx.log.info(
            `[notify-on-publish] sending: to=${recipient} from=${from} subject="Published: ${title}"`,
          );

          const text = `"${title}" was just published or updated.

Collection: ${event.collection}
Slug: ${slug}
Last published: ${publishedAt}`;
          const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;">
<h2 style="margin:0 0 16px;">Published: ${escapeHtml(title)}</h2>
<p style="font-size:14px;color:#333;line-height:1.6;">
  <strong>Collection:</strong> ${escapeHtml(event.collection)}<br/>
  <strong>Slug:</strong> <code>${escapeHtml(slug)}</code><br/>
  <strong>Last published:</strong> ${escapeHtml(publishedAt)}
</p></div>`;

          const t0 = Date.now();
          let res: Response;
          try {
            res = await http.fetch(RESEND_ENDPOINT, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from,
                to: [recipient],
                subject: `Published: ${title}`,
                text,
                html,
              }),
            });
            ctx.log.info(
              `[notify-on-publish] Resend status=${res.status} elapsed_ms=${Date.now() - t0}`,
            );
          } catch (fetchErr) {
            ctx.log.error(
              `[notify-on-publish] fetch threw: ${fetchErr instanceof Error ? `${fetchErr.name}: ${fetchErr.message}` : String(fetchErr)}`,
            );
            return;
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => "(body unreadable)");
            ctx.log.error(
              `[notify-on-publish] Resend ${res.status}: ${errText.slice(0, 500)}`,
            );
            return;
          }

          let respJson: any = {};
          try {
            respJson = await res.json();
          } catch {
            /* ignore */
          }
          ctx.log.info(
            `[notify-on-publish] SENT to=${recipient} resend_id=${respJson?.id ?? "unknown"}`,
          );
        } catch (topErr) {
          ctx.log.error(
            `[notify-on-publish] top error: ${topErr instanceof Error ? `${topErr.name}: ${topErr.message}\n${topErr.stack?.slice(0, 400)}` : String(topErr)}`,
          );
        }
      },
    },
  },
});

function findEmailDeep(obj: any, depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === "string" &&
      key.toLowerCase() === "email" &&
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
    ) {
      return value;
    }
  }
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return value;
    if (value && typeof value === "object") {
      const nested = findEmailDeep(value, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function resolveEnv(ctx: PluginContext, name: string): string | undefined {
  const env = (ctx as any).env;
  if (env && typeof env[name] === "string") return env[name];
  const g = globalThis as any;
  if (typeof g[name] === "string") return g[name];
  if (g.process?.env?.[name]) return g.process.env[name];
  return undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
