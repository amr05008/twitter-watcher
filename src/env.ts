import type { D1Database } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  TRIGGER_TOKEN: string;
  TWITTERAPI_IO_KEY: string;
}
