import { describe, it, expect } from "vitest";
import {
  formatBriefing,
  formatHeartbeat,
  type BriefingPayload,
} from "../src/discord";

const samplePayload: BriefingPayload = {
  briefingId: "2026-05-27",
  generatedAt: "2026-05-27T11:00:00.000Z",
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
  it("returns a single embed with title, description, fields", () => {
    const msg = formatBriefing(samplePayload);
    expect(msg.embeds).toBeInstanceOf(Array);
    expect(msg.embeds!.length).toBe(1);
    const e = msg.embeds![0]!;
    expect(e.title).toContain("Twitter Watcher");
    expect(e.title).toContain("2026-05-27");
    expect(e.description).toContain("Top 3");
    expect(e.description).toContain("past week");
  });

  it("renders each item as a field with rank + author + body + rationale + link", () => {
    const msg = formatBriefing(samplePayload);
    const fields = msg.embeds![0]!.fields!;
    expect(fields.length).toBe(3);
    expect(fields[0]!.name).toContain("#1");
    expect(fields[0]!.name).toContain("@karpathy");
    expect(fields[0]!.value).toContain("New paper");
    expect(fields[0]!.value).toContain("first benchmark");
    expect(fields[0]!.value).toContain("https://x.com/karpathy/status/123");
  });

  it("respects Discord's 1024-char per-field-value limit", () => {
    const longText = "x".repeat(2000);
    const payload: BriefingPayload = {
      ...samplePayload,
      items: [
        { ...samplePayload.items[0]!, text: longText, rationale: longText },
      ],
    };
    const msg = formatBriefing(payload);
    expect(msg.embeds![0]!.fields![0]!.value.length).toBeLessThanOrEqual(1024);
  });

  it("includes a footer with the briefing id and a timestamp", () => {
    const msg = formatBriefing(samplePayload);
    const e = msg.embeds![0]!;
    expect(e.footer?.text).toContain("2026-05-27");
    expect(e.timestamp).toBe("2026-05-27T11:00:00.000Z");
  });
});

describe("discord.formatHeartbeat", () => {
  it("returns an embed saying no new signal", () => {
    const msg = formatHeartbeat("2026-05-27T11:00:00.000Z");
    expect(msg.embeds![0]!.description?.toLowerCase()).toContain(
      "no new signal",
    );
    expect(msg.embeds![0]!.title).toContain("2026-05-27");
  });
});
