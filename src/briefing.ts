import type { Env } from "./env";
import {
  getUnsummarized,
  insertBriefing,
  markSummarized,
  type PostRow,
} from "./db";
import { selectTopSignal, type AnthropicPostInput } from "./anthropic";
import { formatBriefing, formatHeartbeat, postToDiscord } from "./discord";

export type BriefingResult =
  | { briefingId: string; postCount: number }
  | { heartbeat: true; briefingId: string };

function newBriefingId(trigger: "cron" | "manual"): string {
  if (trigger === "cron") return new Date().toISOString().slice(0, 10);
  return `manual-${Date.now().toString(36)}`;
}

export async function runBriefing(
  env: Env,
  trigger: "cron" | "manual",
  systemPrompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BriefingResult> {
  const briefingId = newBriefingId(trigger);
  const generatedAt = new Date().toISOString();

  const unsummarized: PostRow[] = await getUnsummarized(env.DB);

  if (unsummarized.length === 0) {
    const msg = formatHeartbeat(generatedAt);
    await postToDiscord(env.DISCORD_WEBHOOK_URL, msg, fetchImpl);
    return { heartbeat: true, briefingId };
  }

  const postsForClaude: AnthropicPostInput[] = unsummarized.map((p, i) => ({
    index: i + 1,
    source: p.source,
    author: p.author,
    timestamp: p.posted_at,
    text: p.text,
    url: p.url,
  }));

  const picks = await selectTopSignal(postsForClaude, env, systemPrompt, fetchImpl);

  const items = picks.map((pick) => {
    const post = unsummarized[pick.postIndex - 1];
    if (!post) {
      throw new Error(
        `selectTopSignal returned postIndex ${pick.postIndex} out of range (1..${unsummarized.length})`,
      );
    }
    return {
      rank: pick.rank,
      author: post.author,
      text: post.text,
      url: post.url,
      rationale: pick.rationale,
      source: post.source,
      sourceId: post.source_id,
    };
  });

  const discordMsg = formatBriefing({ briefingId, generatedAt, items });
  await postToDiscord(env.DISCORD_WEBHOOK_URL, discordMsg, fetchImpl);

  const summarizedIds = picks
    .map((p) => unsummarized[p.postIndex - 1]?.id)
    .filter((id): id is string => typeof id === "string");
  await markSummarized(env.DB, summarizedIds, briefingId);

  await insertBriefing(env.DB, {
    id: briefingId,
    generatedAt,
    postCount: items.length,
    output: JSON.stringify(items),
    trigger,
  });

  return { briefingId, postCount: items.length };
}
