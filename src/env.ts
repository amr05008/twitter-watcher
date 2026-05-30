import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  TRIGGER_TOKEN: string;
  APIFY_WEBHOOK_SECRET: string;
  APIFY_TOKEN: string;
  APIFY_ACTOR_ID: string;
}
