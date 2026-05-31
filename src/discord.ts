export interface BriefingItem {
  rank: number;
  author: string;
  text: string;
  url: string;
  rationale: string;
  source: string;
  sourceId: string;
}

export interface BriefingPayload {
  briefingId: string;
  generatedAt: string;
  /** One-sentence summary of the day's signal, shown at the top of the digest. */
  lead?: string;
  items: BriefingItem[];
}

export interface DiscordMessage {
  content?: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: { text: string };
    timestamp?: string;
  }>;
}

const COLOR_PRIMARY = 0x5865f2; // Discord blurple-ish; rendered as the left bar of the embed

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function dateLabel(iso: string): string {
  return iso.slice(0, 10);
}

// A single tweet's headline line: "<rationale> — @author [↗](url)". The
// rationale is the standalone headline (full tweet text is no longer rendered).
function headlineLine(item: BriefingItem): string {
  const headline = truncate(item.rationale.replace(/\s+/g, " ").trim(), 200);
  return `${headline} — @${item.author} [↗](${item.url})`;
}

/**
 * Tiered digest: a one-line lead, then a numbered "Don't miss" list (ranks 1–3)
 * and an optional "Also worth a look" list (ranks 4+, heavy days only). Rendered
 * in the embed description rather than per-tweet fields, so it scans top-to-bottom.
 */
export function formatBriefing(payload: BriefingPayload): DiscordMessage {
  const sorted = [...payload.items].sort((a, b) => a.rank - b.rank);
  const dontMiss = sorted.filter((i) => i.rank <= 3);
  const alsoLook = sorted.filter((i) => i.rank > 3);

  const blocks: string[] = [];
  if (payload.lead) blocks.push(payload.lead.trim());

  if (dontMiss.length > 0) {
    const lines = dontMiss.map((i, idx) => `${idx + 1}. ${headlineLine(i)}`);
    blocks.push(`📌 **Don't miss**\n${lines.join("\n")}`);
  }
  if (alsoLook.length > 0) {
    const lines = alsoLook.map((i) => `• ${headlineLine(i)}`);
    blocks.push(`**Also worth a look**\n${lines.join("\n")}`);
  }

  // Discord embed description max is 4096 chars.
  const description = truncate(blocks.join("\n\n"), 4096);

  return {
    embeds: [
      {
        title: `Twitter Watcher — ${dateLabel(payload.generatedAt)}`,
        description,
        color: COLOR_PRIMARY,
        timestamp: payload.generatedAt,
        footer: { text: `briefing ${payload.briefingId}` },
      },
    ],
  };
}

/**
 * Weekly liveness ping. Posted on a quiet Monday (when the run would otherwise
 * skip silently) so a dead cron is distinguishable from a run of quiet days —
 * silent-skip on its own makes those two cases look identical. Tue–Fri stay silent.
 */
export function formatHealthPing(
  generatedAt: string,
  daysSinceLast: number | null,
): DiscordMessage {
  const since =
    daysSinceLast == null
      ? "No signal surfaced yet."
      : daysSinceLast <= 1
        ? "No new signal since the last briefing."
        : `No new signal in the last ${daysSinceLast} days.`;
  return {
    embeds: [
      {
        title: `Twitter Watcher — ${dateLabel(generatedAt)}`,
        description: `${since} Watcher's alive — back to it this week.`,
        color: COLOR_PRIMARY,
        timestamp: generatedAt,
      },
    ],
  };
}

const COLOR_ERROR = 0xed4245; // Discord red — used for failure alerts

/**
 * Failure alert posted when the scheduled run throws. Keeps a weekly tool from
 * silently going dark: if the cron fails, you hear about it in the same channel.
 */
export function formatError(generatedAt: string, message: string): DiscordMessage {
  return {
    embeds: [
      {
        title: `Twitter Watcher — briefing failed`,
        description: truncate(message, 1500),
        color: COLOR_ERROR,
        timestamp: generatedAt,
      },
    ],
  };
}

export async function postToDiscord(
  webhookUrl: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`Discord webhook ${res.status}: ${body}`);
  }
}
