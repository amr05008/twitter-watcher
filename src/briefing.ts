import type { Env } from "./env";
import {
  getLastBriefing,
  getUnsummarized,
  insertBriefing,
  markSummarized,
  type BriefingRow,
  type PostRow,
} from "./db";
import { selectTopSignal, type AnthropicPostInput } from "./anthropic";
import { formatBriefing, formatHealthPing, postToDiscord } from "./discord";

export type BriefingResult =
  | { briefingId: string; postCount: number }
  | { skipped: true; briefingId: string }
  | { healthPing: true; briefingId: string };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONDAY = 1; // Date.getUTCDay()
const WINDOW_FLOOR_MS = 72 * HOUR_MS; // reach back ≥72h (covers the weekend on Mondays)
const WINDOW_CAP_MS = 7 * 24 * HOUR_MS; // never look back more than 7 days

function newBriefingId(trigger: "cron" | "manual"): string {
  if (trigger === "cron") return new Date().toISOString().slice(0, 10);
  return `manual-${Date.now().toString(36)}`;
}

/**
 * Lower bound on posted_at for the daily cron's candidate batch. Defaults to
 * the last posted briefing's time, clamped to [now−7d, now−72h]. Because quiet
 * days skip without inserting a briefing, this self-heals: the window stretches
 * back to the last *posted* briefing, so nothing accumulated over quiet days is
 * dropped — bounded at 7 days so a long-dark watcher doesn't pull a huge batch.
 */
function windowCutoff(generatedAt: string, lastBriefingAt: string | null): string {
  const now = new Date(generatedAt).getTime();
  const floor = now - WINDOW_FLOOR_MS;
  const cap = now - WINDOW_CAP_MS;
  const candidate = lastBriefingAt ? new Date(lastBriefingAt).getTime() : floor;
  const cutoff = Math.max(Math.min(candidate, floor), cap);
  return new Date(cutoff).toISOString();
}

export async function runBriefing(
  env: Env,
  trigger: "cron" | "manual",
  systemPrompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BriefingResult> {
  const briefingId = newBriefingId(trigger);
  const generatedAt = new Date().toISOString();

  // Cron scopes to a recent window; manual flushes the full backlog.
  let opts = {};
  let last: BriefingRow | null = null;
  if (trigger === "cron") {
    last = await getLastBriefing(env.DB);
    opts = { sincePostedAt: windowCutoff(generatedAt, last?.generated_at ?? null) };
  }

  // Quiet outcome (no candidates, or nothing clears the bar): stay silent —
  // except on a Monday cron, where we post a one-line liveness ping so a dead
  // cron is distinguishable from a stretch of genuinely quiet days. The ping is
  // not a briefing: no row, no marking, so the window keeps anchoring on the
  // last *real* briefing and "days since" stays honest.
  const quiet = async (): Promise<BriefingResult> => {
    if (trigger === "cron" && new Date(generatedAt).getUTCDay() === MONDAY) {
      const days = last
        ? Math.max(
            0,
            Math.round(
              (new Date(generatedAt).getTime() - new Date(last.generated_at).getTime()) / DAY_MS,
            ),
          )
        : null;
      await postToDiscord(
        env.DISCORD_WEBHOOK_URL,
        formatHealthPing(generatedAt, days),
        fetchImpl,
      );
      return { healthPing: true, briefingId };
    }
    return { skipped: true, briefingId };
  };

  const unsummarized: PostRow[] = await getUnsummarized(env.DB, opts);

  if (unsummarized.length === 0) {
    return quiet();
  }

  const postsForClaude: AnthropicPostInput[] = unsummarized.map((p, i) => ({
    index: i + 1,
    source: p.source,
    author: p.author,
    timestamp: p.posted_at,
    text: p.text,
    url: p.url,
  }));

  const { lead, picks } = await selectTopSignal(
    postsForClaude,
    env,
    systemPrompt,
    fetchImpl,
  );

  // Quality gate: Claude found nothing worth surfacing. Stay quiet rather than
  // padding — don't mark posts (they get one more look next run) or write a row.
  if (picks.length === 0) {
    return quiet();
  }

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

  const discordMsg = formatBriefing({ briefingId, generatedAt, lead, items });
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
