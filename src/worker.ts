import type { Env } from "./env";
import { handleRequest, type RouteHandlers } from "./router";
import { runBriefing } from "./briefing";
import { runDiscover } from "./discover";
import {
  deleteWatchTarget,
  listWatchTargets,
  prunePosts,
  upsertWatchTarget,
} from "./db";
import { refreshHandleIngest } from "./ingest";
import { getAccountFollowing, getAccountTweets, searchTweets } from "./explore";
import { formatError, postToDiscord } from "./discord";

import briefingPrompt from "../prompts/briefing.md";
import discoverPrompt from "../prompts/discover.md";

const handlers: RouteHandlers = {
  runBriefing: (env, trigger) => runBriefing(env, trigger, briefingPrompt),
  runDiscover: (env, body) => runDiscover(env, body, discoverPrompt),
  runPromote: async (env, body) =>
    upsertWatchTarget(env.DB, {
      source: body.source,
      kind: "handle",
      handle: body.handle,
    }),
  listWatchTargets: async (env) => {
    const targets = await listWatchTargets(env.DB);
    return { targets };
  },
  deleteWatchTarget: (env, body) =>
    deleteWatchTarget(env.DB, { source: body.source, handle: body.handle }),
  refreshHandleIngest: (env) => refreshHandleIngest(env),
  searchTweets: (env, body) => searchTweets(env, body),
  getAccountTweets: (env, body) => getAccountTweets(env, body),
  getAccountFollowing: (env, body) => getAccountFollowing(env, body),
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env, handlers);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      // Refresh first so the briefing sees fresh tweets, then brief.
      // Refresh failure must NOT block the briefing — older unsummarized posts
      // may still be in D1 and worth surfacing. But a *total* refresh failure
      // (refreshHandleIngest throws only when every handle failed) means the
      // data source is down — post a loud alert so it doesn't go quiet, then
      // still continue to the briefing.
      try {
        const result = await refreshHandleIngest(env);
        console.log("scheduled refresh:", JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("scheduled refresh failed (continuing to briefing):", message);
        try {
          await postToDiscord(
            env.DISCORD_WEBHOOK_URL,
            formatError(new Date().toISOString(), `refresh failed: ${message}`),
          );
        } catch (alertErr) {
          console.error(
            "failed to post refresh failure alert to Discord:",
            alertErr instanceof Error ? alertErr.message : String(alertErr),
          );
        }
      }

      await runBriefing(env, "cron", briefingPrompt);

      // Keep D1 lean: drop summarized posts older than 30 days. Best-effort —
      // a prune failure should not mask a successful briefing.
      try {
        const removed = await prunePosts(env.DB, 30);
        console.log("scheduled prune removed", removed, "posts");
      } catch (err) {
        console.error(
          "scheduled prune failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    } catch (err) {
      // The briefing itself failed (Claude, Discord, or D1). Surface it to the
      // same Discord channel so the watcher never silently goes dark, then
      // rethrow so Cloudflare logs and surfaces the cron failure too.
      const message = err instanceof Error ? err.message : String(err);
      console.error("scheduled briefing failed:", message);
      try {
        await postToDiscord(
          env.DISCORD_WEBHOOK_URL,
          formatError(new Date().toISOString(), message),
        );
      } catch (alertErr) {
        console.error(
          "failed to post failure alert to Discord:",
          alertErr instanceof Error ? alertErr.message : String(alertErr),
        );
      }
      throw err;
    }
  },
};
