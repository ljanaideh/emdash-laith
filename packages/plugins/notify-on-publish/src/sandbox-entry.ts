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
    data?: Record<string, unknown>;
    [key: string]: unknown;
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
            (event.content as { fields?: { email?: string } }).fields?.email ??
            findEmailDeep(event.content);

          if (!recipient) {
            ctx.log.warn(`[notify-on-publish] skip: no email field on post`);
            return;
          }

          const apiKey = resolveEnv(ctx, "RESEND_API_KEY");
          if (!apiKey) {
            ctx.log.error(
              `[notify-on-publish] missing RESEND_API_KEY — set Worker secret`,
            );
            return;
          }
          ctx.log.info(
            `[notify-on-publish] recipient=${recipient} key_source=env length=${apiKey.length}`,
          );

          const http = (ctx as { http?: { fetch: typeof fetch } }).http;
          if (!http?.fetch) {
            ctx.log.error(`[notify-on-publish] ctx.http.fetch unavailable`);
            return;
          }

          const kvKey = `sent:${event.collection}:${event.content.id}`;
          let alreadySent = false;
          try {
            const v = await ctx.kv.get(kvKey);
            alreadySent = v === true || v === "true";
          } catch {
            /* KV not available — proceed */
          }
          if (alreadySent) {
            ctx.log.info(`[notify-on-publish] already sent (kv=${kvKey}), skipping`);
            return;
          }

          const title = String(event.content.title ?? event.content.id);
          const slug = String(event.content.slug ?? event.content.id);
          const publishedAt = String(
            event.content.publishedAt ?? new Date().toISOString(),
          );
          const from = resolveEnv(ctx, "EMAIL_FROM") ?? DEFAULT_FROM;

          ctx.log.info(
            `[notify-on-publish] sending via Resend: to=${recipient} from=${from}`,
          );

          const text = `"${title}" was just published.\n\nCollection: ${event.collection}\nSlug: ${slug}\nPublished: ${publishedAt}`;
          const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;">
<h2 style="margin:0 0 16px;">Published: ${escapeHtml(title)}</h2>
<p style="font-size:14px;color:#333;line-height:1.6;">
  <strong>Collection:</strong> ${escapeHtml(event.collection)}<br/>
  <strong>Slug:</strong> <code>${escapeHtml(slug)}</code><br/>
  <strong>Published:</strong> ${escapeHtml(publishedAt)}
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
              `[notify-on-publish] fetch threw: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
            );
            return;
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => "(unreadable)");
            ctx.log.error(
              `[notify-on-publish] Resend ${res.status}: ${errText.slice(0, 500)}`,
            );
            return;
          }

          let respJson: { id?: string } = {};
          try {
            respJson = (await res.json()) as { id?: string };
          } catch {
            /* ignore */
          }
          ctx.log.info(
            `[notify-on-publish] SENT to=${recipient} resend_id=${respJson?.id ?? "unknown"}`,
          );

          try {
            await ctx.kv.set(kvKey, true);
          } catch {
            /* ignore */
          }
        } catch (topErr) {
          ctx.log.error(
            `[notify-on-publish] top error: ${topErr instanceof Error ? topErr.message : String(topErr)}`,
          );
        }
      },
    },
  },
});

function findEmailDeep(obj: unknown, depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (
      typeof value === "string" &&
      key.toLowerCase() === "email" &&
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
    ) {
      return value;
    }
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))
      return value;
    if (value && typeof value === "object") {
      const nested = findEmailDeep(value, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function resolveEnv(ctx: PluginContext, name: string): string | undefined {
  const env = (ctx as { env?: Record<string, unknown> }).env;
  if (env && typeof env[name] === "string") return env[name] as string;
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g[name] === "string") return g[name] as string;
  const proc = g.process as { env?: Record<string, string> } | undefined;
  if (proc?.env?.[name]) return proc.env[name];
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
