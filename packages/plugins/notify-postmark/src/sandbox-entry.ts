import { definePlugin } from "emdash";
import type { ContentPublishStateChangeEvent, PluginContext } from "emdash";

const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";
/** Postmark requires a verified sender signature or domain */
const DEFAULT_FROM = "notifications@example.com";

export default definePlugin({
  hooks: {
    "content:afterPublish": {
      handler: async (event: ContentPublishStateChangeEvent, ctx: PluginContext) => {
        const content = event.content as {
          id?: string;
          title?: string;
          slug?: string;
          publishedAt?: string;
          email?: string | string[];
          data?: Record<string, unknown>;
          fields?: { email?: string };
          [key: string]: unknown;
        };

        try {
          ctx.log.info(
            `[notify-postmark] fired collection=${event.collection} id=${content.id ?? "(no-id)"}`,
          );

          const rawRecipient =
            content.email ??
            content.data?.email ??
            content.fields?.email ??
            findEmailDeep(content);

          const recipients = normalizeRecipients(rawRecipient);
          if (recipients.length === 0) {
            ctx.log.info(
              `[notify-postmark] skip: ${event.collection}/${content.id ?? "(no-id)"} has no email field (opt-in)`,
            );
            return;
          }

          const apiKey = resolveEnv(ctx, "POSTMARK_SERVER_TOKEN");
          if (!apiKey) {
            ctx.log.error(`[notify-postmark] POSTMARK_SERVER_TOKEN not in ctx.env`);
            return;
          }

          const http = (ctx as { http?: { fetch: typeof fetch } }).http;
          if (!http?.fetch) {
            ctx.log.error(`[notify-postmark] ctx.http.fetch unavailable`);
            return;
          }

          const title = String(content.title ?? content.id ?? "(untitled)");
          const slug = String(content.slug ?? content.id ?? "");
          const publishedAt =
            typeof content.publishedAt === "string"
              ? content.publishedAt
              : new Date().toISOString();
          const from = resolveEnv(ctx, "POSTMARK_FROM") ?? DEFAULT_FROM;
          const collectionLabel = capitalize(event.collection);

          ctx.log.info(
            `[notify-postmark] sending: collection=${event.collection} to=[${recipients.join(", ")}] from=${from}`,
          );

          const text = `"${title}" was just published.

Collection: ${event.collection}
Slug: ${slug}
Published: ${publishedAt}`;
          const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;">
<h2 style="margin:0 0 16px;">${escapeHtml(collectionLabel)} published: ${escapeHtml(title)}</h2>
<p style="font-size:14px;color:#333;line-height:1.6;">
  <strong>Collection:</strong> ${escapeHtml(event.collection)}<br/>
  <strong>Slug:</strong> <code>${escapeHtml(slug)}</code><br/>
  <strong>Published:</strong> ${escapeHtml(publishedAt)}
</p></div>`;

          const t0 = Date.now();
          let res: Response;
          try {
            res = await http.fetch(POSTMARK_ENDPOINT, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-Postmark-Server-Token": apiKey,
              },
              body: JSON.stringify({
                From: from,
                To: recipients.join(", "),
                Subject: `${collectionLabel} published: ${title}`,
                TextBody: text,
                HtmlBody: html,
                MessageStream: "outbound",
              }),
            });
            ctx.log.info(
              `[notify-postmark] Postmark status=${res.status} elapsed_ms=${Date.now() - t0}`,
            );
          } catch (fetchErr) {
            ctx.log.error(
              `[notify-postmark] fetch threw: ${fetchErr instanceof Error ? `${fetchErr.name}: ${fetchErr.message}` : String(fetchErr)}`,
            );
            return;
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => "(body unreadable)");
            ctx.log.error(
              `[notify-postmark] Postmark ${res.status}: ${errText.slice(0, 500)}`,
            );
            return;
          }

          let respJson: { MessageID?: string } = {};
          try {
            respJson = (await res.json()) as { MessageID?: string };
          } catch {
            /* ignore */
          }
          ctx.log.info(
            `[notify-postmark] SENT to=[${recipients.join(", ")}] MessageID=${respJson?.MessageID ?? "unknown"}`,
          );
        } catch (topErr) {
          ctx.log.error(
            `[notify-postmark] top error: ${topErr instanceof Error ? `${topErr.name}: ${topErr.message}\n${topErr.stack?.slice(0, 400)}` : String(topErr)}`,
          );
        }
      },
    },
  },
});

const EMAIL_REGEX = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

function normalizeRecipients(raw: unknown): string[] {
  if (!raw) return [];
  const candidates: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") candidates.push(...splitList(item));
    }
  } else if (typeof raw === "string") {
    candidates.push(...splitList(raw));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed || !EMAIL_REGEX.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function splitList(s: string): string[] {
  return s.split(/[,;\s]+/).filter(Boolean);
}

function findEmailDeep(obj: unknown, depth = 0): string | string[] | undefined {
  if (!obj || typeof obj !== "object" || depth > 4) return undefined;
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const k = key.toLowerCase();
    if (k === "email" || k === "emails") {
      if (typeof value === "string" && normalizeRecipients(value).length > 0) {
        return value;
      }
      if (Array.isArray(value) && normalizeRecipients(value).length > 0) {
        return value as string[];
      }
    }
  }
  for (const value of Object.values(record)) {
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

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
