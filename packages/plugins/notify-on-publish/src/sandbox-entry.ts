import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "onboarding@resend.dev";
const DEFAULT_API_KEY_ENV = "RESEND_API_KEY";
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
        ctx.log.info(
          `[notify-on-publish] fired collection=${event.collection} id=${event.content.id} status=${event.content.status} prev=${event.previous?.status ?? "(none)"}`,
        );

        if (event.collection !== TARGET_COLLECTION) {
          ctx.log.info(`[notify-on-publish] skip: ${event.collection} not ${TARGET_COLLECTION}`);
          return;
        }
        const nowPublished = event.content.status === "published";
        const wasPublished = event.previous?.status === "published";
        if (!nowPublished || wasPublished) {
          ctx.log.info(`[notify-on-publish] skip: not a draft->published transition`);
          return;
        }

        // Deep diagnostic logs so we can see exactly where email lives
        ctx.log.info(
          `[notify-on-publish] content keys: ${Object.keys(event.content).join(",")}`,
        );
        ctx.log.info(
          `[notify-on-publish] content.data: ${JSON.stringify(event.content.data ?? {}).slice(0, 800)}`,
        );
        ctx.log.info(
          `[notify-on-publish] content preview: ${JSON.stringify(event.content).slice(0, 1200)}`,
        );

        // Try every plausible path for the email custom field
        const recipient =
          (event.content.email as string | undefined) ??
          (event.content.data?.email as string | undefined) ??
          (event.content as any).fields?.email ??
          (event.content.data as any)?.fields?.email ??
          (event.content as any).attributes?.email ??
          (event.content as any).customFields?.email ??
          findEmailDeep(event.content);

        if (!recipient) {
          ctx.log.warn(
            `[notify-on-publish] skip: post ${event.content.id} has no email field set`,
          );
          return;
        }

        const apiKey = resolveEnv(ctx, DEFAULT_API_KEY_ENV);
        if (!apiKey) {
          ctx.log.error(`[notify-on-publish] ${DEFAULT_API_KEY_ENV} not set in worker secrets`);
          return;
        }

        const kvKey = `sent:${event.collection}:${event.content.id}`;
        if (await ctx.kv.get<boolean>(kvKey)) {
          ctx.log.info(`[notify-on-publish] already sent for ${kvKey}, skipping`);
          return;
        }

        const title = event.content.title ?? event.content.id;
        const slug = event.content.slug ?? event.content.id;
        const publishedAt = event.content.publishedAt ?? new Date().toISOString();
        const from = resolveEnv(ctx, "EMAIL_FROM") ?? DEFAULT_FROM;

        ctx.log.info(`[notify-on-publish] sending to=${recipient} from=${from}`);

        const text = `"${title}" was just published.\n\nCollection: ${event.collection}\nSlug: ${slug}\nPublished: ${publishedAt}`;
        const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;">
<h2 style="margin:0 0 16px;">Published: ${escapeHtml(title)}</h2>
<p style="font-size:14px;color:#333;line-height:1.6;">
  <strong>Collection:</strong> ${escapeHtml(event.collection)}<br/>
  <strong>Slug:</strong> <code>${escapeHtml(slug)}</code><br/>
  <strong>Published:</strong> ${escapeHtml(publishedAt)}
</p></div>`;

        try {
          const res = await fetch(RESEND_ENDPOINT, {
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

          if (!res.ok) {
            const errText = await res.text();
            ctx.log.error(`[notify-on-publish] Resend ${res.status}: ${errText.slice(0, 500)}`);
            return;
          }

          const { id } = (await res.json()) as { id?: string };
          await ctx.kv.set(kvKey, true, { ttl: 60 * 60 * 24 * 30 });
          ctx.log.info(`[notify-on-publish] SENT to ${recipient} (resend id: ${id ?? "unknown"})`);
        } catch (err) {
          ctx.log.error(
            `[notify-on-publish] send failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    },
  },
});

// Walk the content tree and return the first value that looks like an email
function findEmailDeep(obj: any, depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      // Prefer keys actually named "email"
      if (key.toLowerCase() === "email") return value;
    }
  }
  // Second pass: accept any email-looking string
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return value;
    }
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
