// Offline eval harness for the briefing selection prompt.
//
// WHAT THIS IS: a non-destructive way to see what prompts/briefing.md would pick
// for a frozen batch of real posts. It calls the SAME selectTopSignal() the cron
// uses, but skips every side effect runBriefing() wraps around it — no Discord
// post, no markSummarized(), no D1 write. Edit the prompt, re-run, eyeball the
// picks. Repeatable because the batch is frozen, so you can A/B two prompt versions
// against identical input (the live /trigger path can never do that).
//
// HOW TO RUN (real Anthropic call — spends a little, ~1 cached Sonnet request):
//   RUN_EVAL=1 npx vitest run tests/eval-briefing.test.ts
//   # or:  npm run eval:briefing
// Needs ANTHROPIC_API_KEY in the environment or in .dev.vars (gitignored).
//
// WHY IT SELF-SKIPS: without RUN_EVAL set it is skipped instantly, so `npm test`
// and CI stay green and never touch the network or spend tokens.
//
// NOT DETERMINISTIC: it's a real model call, so picks can vary slightly run to run.
// This is an eyeball/judgment tool, not a pass/fail assertion.
//
// RE-SNAPSHOT THE BATCH (when you want a fresh bench):
//   npx wrangler d1 execute twitter-watcher --remote --json --command \
//     "SELECT source, source_id, author, posted_at, text, url FROM posts WHERE summarized_in IS NULL ORDER BY posted_at DESC;" \
//   then map [0].results into { posts: [...] } in tests/fixtures/briefing-batch.json.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  selectTopSignal,
  type AnthropicPostInput,
} from "../src/anthropic";
import briefingBatch from "./fixtures/briefing-batch.json";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal dotenv-style reader, mirroring scripts/seed-handles.mjs — used only as a
// fallback so you can keep the key in .dev.vars instead of exporting it each run.
async function devVar(name: string): Promise<string | undefined> {
  if (process.env[name]) return process.env[name];
  try {
    const raw = await readFile(join(root, ".dev.vars"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq !== -1 && t.slice(0, eq).trim() === name) return t.slice(eq + 1).trim();
    }
  } catch {
    /* no .dev.vars — fall through */
  }
  return undefined;
}

interface FixturePost {
  source: string;
  source_id: string;
  author: string;
  posted_at: string;
  text: string;
  url: string;
}

describe("briefing prompt eval (frozen batch)", () => {
  it.skipIf(!process.env.RUN_EVAL)(
    "shows what the current prompt picks",
    { timeout: 60_000 },
    async () => {
      const apiKey = await devVar("ANTHROPIC_API_KEY");
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY not set — add it to .dev.vars or export it before running the eval.",
        );
      }

      // Read the prompt off disk, exactly as the worker bundles it — your edits to
      // prompts/briefing.md are picked up on every run, no rebuild.
      const systemPrompt = await readFile(join(root, "prompts/briefing.md"), "utf8");

      const fixture = briefingBatch.posts as FixturePost[];
      // Same mapping runBriefing() does (src/briefing.ts) — post rows -> model input.
      const posts: AnthropicPostInput[] = fixture.map((p, i) => ({
        index: i + 1,
        source: p.source,
        author: p.author,
        timestamp: p.posted_at,
        text: p.text,
        url: p.url,
      }));

      const { lead, picks } = await selectTopSignal(posts, { ANTHROPIC_API_KEY: apiKey }, systemPrompt);

      const lines: string[] = [];
      lines.push("");
      lines.push("════════════════════════════════════════════════════════");
      lines.push(`  BRIEFING EVAL — ${posts.length} candidate posts`);
      lines.push("════════════════════════════════════════════════════════");
      lines.push(`  lead:  ${lead ?? "(none)"}`);
      lines.push(`  picks: ${picks.length}`);
      lines.push("");
      if (picks.length === 0) {
        lines.push("  (quiet day — nothing cleared the bar)");
      }
      for (const pick of [...picks].sort((a, b) => a.rank - b.rank)) {
        const post = posts[pick.postIndex - 1];
        const tier = pick.rank <= 3 ? "DON'T MISS" : "also worth a look";
        lines.push(`  #${pick.rank} [${tier}]  @${post?.author ?? "?"}`);
        lines.push(`     ${pick.rationale}`);
        lines.push(`     ${post?.url ?? ""}`);
        lines.push("");
      }
      // Passed-over view: how thin the signal was, and who got nothing through.
      const pickedAuthors = new Set(picks.map((p) => posts[p.postIndex - 1]?.author));
      const allAuthors = [...new Set(posts.map((p) => p.author))];
      lines.push(
        `  passed over: ${posts.length - picks.length} posts; ` +
          `authors with no pick: ${allAuthors.filter((a) => !pickedAuthors.has(a)).join(", ") || "(none)"}`,
      );
      lines.push("════════════════════════════════════════════════════════");
      // eslint-disable-next-line no-console
      console.log(lines.join("\n"));

      // Sanity only — the value is the printed output above, not this assertion.
      expect(Array.isArray(picks)).toBe(true);
    },
  );
});
