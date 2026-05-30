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

export function formatBriefing(payload: BriefingPayload): DiscordMessage {
  const fields = payload.items.map((item) => {
    const body = truncate(item.text.replace(/\s+/g, " ").trim(), 600);
    const rationale = truncate(item.rationale, 240);
    // Discord field value max is 1024 chars
    const value = `${body}\n_${rationale}_\n[Open on Twitter →](${item.url})`;
    return {
      name: `#${item.rank} — @${item.author}`,
      value: truncate(value, 1020),
    };
  });

  return {
    embeds: [
      {
        title: `Twitter Watcher — ${dateLabel(payload.generatedAt)}`,
        description: `Top ${payload.items.length} signals from the past week.`,
        color: COLOR_PRIMARY,
        fields,
        timestamp: payload.generatedAt,
        footer: { text: `briefing ${payload.briefingId}` },
      },
    ],
  };
}

export function formatHeartbeat(generatedAt: string): DiscordMessage {
  return {
    embeds: [
      {
        title: `Twitter Watcher — ${dateLabel(generatedAt)}`,
        description: "No new signal this week.",
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
