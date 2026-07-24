import { describe, it, expect } from "vitest";
import {
  formatBriefing,
  formatHealthPing,
  type BriefingPayload,
} from "../src/discord";

const samplePayload: BriefingPayload = {
  briefingId: "2026-05-27",
  generatedAt: "2026-05-27T11:00:00.000Z",
  lead: "New paper, a Claude tool-use change, and a Datasette plugin.",
  items: [
    {
      rank: 1,
      author: "karpathy",
      text: "New paper shows X beats Y on agentic benchmarks.",
      url: "https://x.com/karpathy/status/123",
      rationale: "first benchmark comparing the two on real coding tasks",
      source: "twitter",
      sourceId: "123",
    },
    {
      rank: 2,
      author: "swyx",
      text: "Thread on the new Claude tool-use changes.",
      url: "https://x.com/swyx/status/456",
      rationale: "summarizes the API delta most teams will hit first",
      source: "twitter",
      sourceId: "456",
    },
    {
      rank: 3,
      author: "simonw",
      text: "Datasette plugin for X.",
      url: "https://x.com/simonw/status/789",
      rationale: "first end-to-end open-source impl of the pattern",
      source: "twitter",
      sourceId: "789",
    },
  ],
};

describe("discord.formatBriefing", () => {
  it("returns a single embed with title, lead, and a Don't miss list", () => {
    const msg = formatBriefing(samplePayload);
    expect(msg.embeds).toBeInstanceOf(Array);
    expect(msg.embeds!.length).toBe(1);
    const e = msg.embeds![0]!;
    expect(e.title).toContain("Twitter Watcher");
    expect(e.title).toContain("2026-05-27");
    // Lead renders at the top of the description.
    expect(e.description).toContain("New paper, a Claude tool-use change");
    expect(e.description).toContain("Don't miss");
  });

  it("renders the rationale as the headline, not the full tweet body", () => {
    const e = formatBriefing(samplePayload).embeds![0]!;
    // Headlines + author + link are present...
    expect(e.description).toContain("first benchmark comparing the two on real coding tasks");
    // The whole "@author ↗" is the link text (a bare arrow is too small to tap on mobile).
    expect(e.description).toContain("[@karpathy ↗](https://x.com/karpathy/status/123)");
    expect(e.description).toContain("1. "); // numbered "Don't miss" list
    // ...but the raw tweet body is not.
    expect(e.description).not.toContain("New paper shows X beats Y");
  });

  it("only shows 'Also worth a look' when there are ranks beyond 3", () => {
    const withoutOverflow = formatBriefing(samplePayload).embeds![0]!;
    expect(withoutOverflow.description).not.toContain("Also worth a look");

    const heavy: BriefingPayload = {
      ...samplePayload,
      items: [
        ...samplePayload.items,
        {
          rank: 4,
          author: "gdb",
          text: "Extra item on a busy day.",
          url: "https://x.com/gdb/status/999",
          rationale: "secondary but still notable launch",
          source: "twitter",
          sourceId: "999",
        },
      ],
    };
    const e = formatBriefing(heavy).embeds![0]!;
    expect(e.description).toContain("Also worth a look");
    expect(e.description).toContain("secondary but still notable launch");
  });

  it("works without a lead", () => {
    const { lead, ...noLead } = samplePayload;
    const e = formatBriefing(noLead).embeds![0]!;
    expect(e.description).toContain("Don't miss");
    expect(e.description).not.toContain("undefined");
  });

  it("respects Discord's 4096-char description limit", () => {
    const long = "x".repeat(6000);
    const payload: BriefingPayload = {
      ...samplePayload,
      lead: long,
      items: [{ ...samplePayload.items[0]!, rationale: long }],
    };
    const e = formatBriefing(payload).embeds![0]!;
    expect(e.description!.length).toBeLessThanOrEqual(4096);
  });

  it("includes a footer with the briefing id and a timestamp", () => {
    const e = formatBriefing(samplePayload).embeds![0]!;
    expect(e.footer?.text).toContain("2026-05-27");
    expect(e.timestamp).toBe("2026-05-27T11:00:00.000Z");
  });
});

describe("discord.formatHealthPing", () => {
  it("reports days since the last briefing", () => {
    const e = formatHealthPing("2026-06-01T11:00:00.000Z", 7).embeds![0]!;
    expect(e.description).toContain("last 7 days");
    expect(e.description?.toLowerCase()).toContain("alive");
    expect(e.title).toContain("2026-06-01");
  });

  it("handles the no-prior-briefing case", () => {
    const e = formatHealthPing("2026-06-01T11:00:00.000Z", null).embeds![0]!;
    expect(e.description?.toLowerCase()).toContain("no signal surfaced yet");
    expect(e.description).not.toContain("null");
  });
});
