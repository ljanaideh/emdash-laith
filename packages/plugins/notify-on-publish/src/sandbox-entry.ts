import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

const WEBHOOK_URL = "https://webhook.site/a2ef48e6-d6e5-4127-baf4-efba1924bcf0";
const TARGET_COLLECTION = "posts";

interface ContentSaveEvent {
  collection: string;
  content: {
    id: string;
    title?: string;
    status: string;
    [key: string]: any;
  };
  previous?: { status?: string };
}

export default definePlugin({
  hooks: {
    "content:afterSave": {
      handler: async (event: ContentSaveEvent, ctx: PluginContext) => {
        try {
          ctx.log.info(`[notify-test] fired id=${event.content.id} status=${event.content.status}`);

          if (event.collection !== TARGET_COLLECTION) return;
          if (event.content.status !== "published") return;

          // Check ctx.http is available (capability: network:fetch)
          if (!(ctx as any).http || typeof (ctx as any).http.fetch !== "function") {
            ctx.log.error(
              `[notify-test] ctx.http unavailable. ctx keys: ${Object.keys(ctx).join(",")}`,
            );
            return;
          }

          ctx.log.info(`[notify-test] passed filters, about to ctx.http.fetch ${WEBHOOK_URL}`);

          const t0 = Date.now();
          let res: Response;
          try {
            res = await (ctx as any).http.fetch(WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: event.content.id,
                title: event.content.title ?? "(no title)",
                status: event.content.status,
                timestamp: new Date().toISOString(),
              }),
            });
            ctx.log.info(
              `[notify-test] ctx.http.fetch returned status=${res.status} elapsed_ms=${Date.now() - t0}`,
            );
          } catch (fetchErr) {
            ctx.log.error(
              `[notify-test] ctx.http.fetch threw after ${Date.now() - t0}ms: ${fetchErr instanceof Error ? `${fetchErr.name}: ${fetchErr.message}` : String(fetchErr)}`,
            );
            return;
          }

          ctx.log.info(`[notify-test] done successfully`);
        } catch (topErr) {
          ctx.log.error(
            `[notify-test] top error: ${topErr instanceof Error ? `${topErr.name}: ${topErr.message}` : String(topErr)}`,
          );
        }
      },
    },
  },
});
