import { definePlugin } from "emdash";
import type { ContentPublishStateChangeEvent, PluginContext } from "emdash";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "onboarding@resend.dev";
const TARGET_COLLECTION = "posts";

export default definePlugin({
  hooks: {
    "content:afterPublish": {
      handler: async (event: ContentPublishStateChangeEvent, ctx: PluginContext) => {
        const content = event.content as {
          id?: string;
          title?: string;
          slug?: string;
          publishedAt?: string;
          email?: string;
          data?: Record<string, unknown>;
          fields?: { email?: string };
          [key: string]: unknown;
        };

        try {
          ctx.log.info(
            `[notify-on-publish] fired id=${content.id ?? "(none)"} collection=${event.collection}`,
          );

          if (event.collection !== TARGET_COLLECTION) return;

          const recipient =
            (content.email as string | undefined) ??
            (content.data?.email as string | undefined) ??
            content.fields?.email ??
            findEmailDeep(content);

          if (!recipient) {
            ctx.log.warn(`[notify-on-publish] skip: no email field on post`);
            return;
          }

          const apiKey = resolveEnv(ctx, "RESEND_API_KEY");
          if (!apiKey) {
            ctx.log.error(`[notify-on-publish] RESEND_API_KEY not in ctx.env`);
            return;
          }

          const http = (ctx as { http?: { fetch: typeof fetch } }).http;
          if (!http?.fetch) {
            ctx.log.error(`[notify-on-publish] ctx.http.fetch unavailable`);
            return;
          }

          const title = content.title ?? content.id ?? "(untitled)";
          const slug = content.slug ?? content.id ?? "";
          const publishedAt =
            typeof content.publishedAt === "string"
              ? content.publishedAt
              : new Date().toISOString();
          const from = resolveEnv(ctx, "EMAIL_FROM") ?? DEFAULT_FROM;

          ctx.log.info(
            `[notify-on-publish] sending: to=${recipient} from=${from} subject="Published: ${title}"`,
          );

          const text = `"${title}" was just published.

Collection: ${event.collection}
Slug: ${slug}
Published: ${publishedAt}`;
          const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;">
<h2 style="margin:0 0 16px;">Published: ${escapeHtml(String(title))}</h2>
<p style="font-size:14px;color:#333;line-height:1.6;">
  <strong>Collection:</strong> ${escapeHtml(event.collection)}<br/>
  <strong>Slug:</strong> <code>${escapeHtml(String(slug))}</code><br/>
  <strong>Published:</strong> ${escapeHtml(String(publishedAt))}
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

          let respJson: { id?: string } = {};
          try {
            respJson = (await res.json()) as { id?: string };
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
