import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = resolve(repoRoot, "skills/twitter-watcher");

describe("twitter-watcher Agent Skill", () => {
  it("has standard frontmatter with a name matching its directory", async () => {
    const text = await readFile(resolve(skillDir, "SKILL.md"), "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const frontmatter = match?.[1] ?? "";
    expect(frontmatter).toMatch(/^name: twitter-watcher$/m);
    expect(frontmatter).toMatch(/^description: \S.+$/m);
    expect(frontmatter).not.toMatch(/^argument-hint:/m);
  });

  it("ships executable CLI and installer launchers", async () => {
    const launcher = resolve(skillDir, "scripts/twitter-watcher");
    const installer = resolve(repoRoot, "scripts/install-skill-links.sh");
    await access(launcher, constants.X_OK);
    await access(installer, constants.X_OK);
    expect((await stat(launcher)).mode & 0o111).not.toBe(0);
    expect((await stat(installer)).mode & 0o111).not.toBe(0);
  });

  it("documents the side-effect confirmation flow", async () => {
    const text = await readFile(resolve(skillDir, "SKILL.md"), "utf8");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--yes");
    expect(text).toContain("TWITTER_WATCHER_TRIGGER_TOKEN");
  });
});
