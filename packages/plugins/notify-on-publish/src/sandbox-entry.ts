import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "onboarding@resend.dev";
const TARGET_COLLECTION = "posts";

// TEMPORARY: hardcoded for testing. REVERT before any real deployment.
const HARDCODED_RESEND_KEY = "re_L9za4ENE_NETaV1wTCVbsu1J7bYCeu9tX";

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
            `[notify-on-publish] fired collection=${event.collection} id=${event.content.id} status=${event.content.status} prev=${event.previous?.status ?? "(none)"}`,
          );

          if (event.collection !== TARGET_COLLECTION) {
            ctx.log.info(`[notify-on-publish] skip: wrong collection`);
            return;
          }
          const nowPublished = event.content.status === "published";
          const wasPublished = event.previous?.status === "published";
          if (!nowPublished || wasPublished) {
            ctx.log.info(`[notify-on-publish] skip: not draft->published`);
            return;
          }

          const recipient =
            (event.content.email as string | undefined) ??
            (event.content.data?.email as string | undefined) ??
            (event.content as any).fields?.email ??
            (event.content.data as any)?.fields?.email ??
            (event.content as any).attributes?.email ??
            (event.content as any).customFields?.email ??
            findEmailDeep(event.content);

          ctx.log.info(`[notify-on-publish] recipient resolved: ${recipient ?? "(none)"}`);

          if (!recipient) {
            ctx.log.warn(`[notify-on-publish] skip: no recipient`);
            return;
          }

          const apiKey = resolveEnv(ctx, "RESEND_API_KEY") ?? HARDCODED_RESEND_KEY;
          if (!apiKey || apiKey === "REPLACE_ME_WITH_YOUR_KEY") {
            ctx.log.error(`[notify-on-publish] no api key`);
            return;
          }
          ctx.log.info(`[notify-on-publish] api key source: ${resolveEnv(ctx, "RESEND_API_KEY") ? "env" : "hardcoded"}, length=${apiKey.length}`);

          // Try KV idempotency, but don't block if KV unavailable
          const kvKey = `sent:${event.collection}:${event.content.id}`;
          let alreadySent = false;
          try {
            if (ctx.kv && typeof ctx.kv.get === "function") {
              alreadySent = (await ctx.kv.get<boolean>(kvKey)) === true;
              ctx.log.info(`[notify-on-publish] kv check: already_sent=${alreadySent}`);
            } else {
              ctx.log.warn(`[notify-on-publish] kv unavailable (ctx.kv=${typeof ctx.kv}), skipping idempotency check`);
            }
          } catch (kvErr) {
            ctx.log.warn(
              `[notify-on-publish] kv.get threw: ${kvErr instanceof Error ? kvErr.message : String(kvErr)}`,
            );
          }

          if (alreadySent) {
            ctx.log.info(`[notify-on-publish] already sent, skipping`);
            return;
          }

          const title = event.content.title ?? event.content.id;
          const slug = event.content.slug ?? event.content.id;
          const publishedAt = event.content.publishedAt ?? new Date().toISOString();
          const from = resolveEnv(ctx, "EMAIL_FROM") ?? DEFAULT_FROM;

          ctx.log.info(`[notify-on-publish] about to fetch resend: to=${recipient} from=${from}`);

          const text = `"${title}" was just published.\n\nCollection: ${event.collection}\nSlug: ${slug}\nPublished: ${publishedAt}`;
          const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;">
<h2>Published: ${escapeHtml(title)}</h2>
<p><strong>Slug:</strong> ${escapeHtml(slug)}<br/><strong>Published:</strong> ${escapeHtml(publishedAt)}</p></div>`;

          let res: Response;
          try {
            res = await fetch(RESEND_ENDPOINT, {
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
            ctx.log.info(`[notify-on-publish] fetch returned status=${res.status}`);
          } catch (fetchErr) {
            ctx.log.error(
              `[notify-on-publish] fetch threw: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
            );
            return;
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => "(could not read body)");
            ctx.log.error(`[notify-on-publish] Resend ${res.status}: ${errText.slice(0, 500)}`);
            return;
          }

          let respJson: any = {};
          try {
            respJson = await res.json();
          } catch {
            /* ignore */
          }
          ctx.log.info(`[notify-on-publish] SENT to ${recipient} (resend id: ${respJson?.id ?? "unknown"})`);

          // Try to write the KV guard, but don't fail the response if it errors
          try {
            if (ctx.kv && typeof ctx.kv.set === "function") {
              await ctx.kv.set(kvKey, true, { ttl: 60 * 60 * 24 * 30 });
            }
          } catch (kvErr) {
            ctx.log.warn(
              `[notify-on-publish] kv.set threw: ${kvErr instanceof Error ? kvErr.message : String(kvErr)}`,
            );
          }
        } catch (topErr) {
          ctx.log.error(
            `[notify-on-publish] top-level error: ${topErr instanceof Error ? `${topErr.name}: ${topErr.message}\n${topErr.stack?.slice(0, 500)}` : String(topErr)}`,
          );
        }
      },
    },
  },
});

function findEmailDeep(obj: any, depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      if (key.toLowerCase() === "email") return value;
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
