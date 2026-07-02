import { describe, it, expect, vi } from "vitest";

// tools.ts pulls in the db via its imports; mock it like the other tool/route
// tests so importing the registry never touches a real database.
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { mockDb } = await import("./test/dbMock");
  return { ...actual, db: mockDb };
});

import { TOOL_REGISTRY, getToolNamesForAgent, isToolAllowed, buildCapabilityCard, coerceArgsObject, isStaleGhost, isRecallableMemory } from "./tools";

const ABBY = 1;
const BUZZ = 3; // social media & Composio specialist (was split across WIRE/MR.NICE)

describe("composio_action: coerce stringified arguments to an object", () => {
  it("parses a JSON string into an object", () => {
    expect(coerceArgsObject('{"name":"COMPOSIOFREE"}')).toEqual({ name: "COMPOSIOFREE" });
  });
  it("tolerates single-quoted object literals the model emits", () => {
    expect(coerceArgsObject("{'name': 'COMPOSIOFREE'}")).toEqual({ name: "COMPOSIOFREE" });
  });
  it("passes a real object through unchanged", () => {
    expect(coerceArgsObject({ name: "X" })).toEqual({ name: "X" });
  });
  it("returns an empty object for junk/empty input", () => {
    expect(coerceArgsObject("")).toEqual({});
    expect(coerceArgsObject(undefined)).toEqual({});
  });
});

describe("github_commit_file: push files without git/sandbox", () => {
  it("is registered with base64 handled server-side", () => {
    expect(TOOL_REGISTRY["github_commit_file"]).toBeTruthy();
    expect(TOOL_REGISTRY["github_commit_file"]!.description.toLowerCase()).toContain("base64");
  });
  it("is available to ABBY and FORGE", () => {
    expect(getToolNamesForAgent(ABBY)).toContain("github_commit_file");
    expect(getToolNamesForAgent(5)).toContain("github_commit_file");
  });
});

describe("Composio: agents know which apps are LIVE", () => {
  it("registers a composio_apps discovery tool", () => {
    expect(TOOL_REGISTRY["composio_apps"]).toBeTruthy();
    expect(TOOL_REGISTRY["composio_apps"]!.description.toLowerCase()).toContain("live");
  });

  it("wires composio to ABBY and BUZZ (social/Composio specialist)", () => {
    for (const id of [ABBY, BUZZ]) {
      expect(isToolAllowed(id, "composio_apps"), `agent #${id} should have composio_apps`).toBe(true);
      expect(isToolAllowed(id, "composio_action"), `agent #${id} should have composio_action`).toBe(true);
    }
  });

  it("composio_action tells the agent to check live apps first", () => {
    expect(TOOL_REGISTRY["composio_action"]!.description.toLowerCase()).toContain("composio_apps");
  });

  it("provides a deterministic instagram_post tool wired to the social/API agents", () => {
    expect(TOOL_REGISTRY["instagram_post"]).toBeTruthy();
    expect(TOOL_REGISTRY["instagram_post"]!.description.toLowerCase()).toContain("permalink");
    for (const id of [ABBY, BUZZ]) {
      expect(isToolAllowed(id, "instagram_post"), `agent #${id} should have instagram_post`).toBe(true);
    }
  });

  it("BUZZ's capability card instructs checking live Composio apps before acting", () => {
    const card = buildCapabilityCard(BUZZ);
    expect(card).toContain("composio_apps");
    expect(card.toLowerCase()).toContain("connect apps");
  });

  it("getToolNamesForAgent lists composio_apps before composio_action for BUZZ", () => {
    const names = getToolNamesForAgent(BUZZ);
    expect(names.indexOf("composio_apps")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("composio_apps")).toBeLessThan(names.indexOf("composio_action"));
  });

  it("self-learning is ON: ABBY can read AND write long-term memory", () => {
    // The self-learn loop (search memory → research → retry → store the lesson) is
    // only real if the generalist agent actually holds both memory tools. ABBY (1)
    // gets ALL_TOOLS, so she always has them.
    const names = getToolNamesForAgent(ABBY);
    expect(names, "ABBY must be able to recall lessons").toContain("memory_search");
    expect(names, "ABBY must be able to store lessons").toContain("memory_write");
  });

  it("AVVY (2) is deliberately scoped to image + video generation ONLY", () => {
    // AVVY is a specialist: ABBY orders, AVVY only makes images/videos — nothing
    // else. So she intentionally does NOT carry the general toolset.
    const names = getToolNamesForAgent(2);
    expect(names).toContain("image_generate");
    expect(names).toContain("video_generate");
    expect(names).not.toContain("composio_action");
    expect(names).not.toContain("code_exec");
  });
});

describe("memory_write quality gate: stop polluting memory with junk lessons", () => {
  const ctx = { agentId: 1, agentName: "ABBY", agentColor: "#000", channelId: 1 };
  it("rejects a bare failure note with no fix", async () => {
    const out = await TOOL_REGISTRY["memory_write"]!.run({ content: "web_search failed" }, ctx);
    expect(out.toLowerCase()).toContain("skipped");
  });
  it("rejects the self-learn spam pattern (failure + no concrete fix)", async () => {
    const out = await TOOL_REGISTRY["memory_write"]!.run(
      { content: "[SELF-LEARN] web_search failed. Before retrying, follow the protocol." },
      ctx,
    );
    expect(out.toLowerCase()).toContain("skipped");
  });
  it("rejects notes that are too thin", async () => {
    const out = await TOOL_REGISTRY["memory_write"]!.run({ content: "tried it" }, ctx);
    expect(out.toLowerCase()).toContain("skipped");
  });
});

describe("stale-memory quarantine: stop recalling phantom blockers", () => {
  it("quarantines the false ALLOW_COMPOSIO_EXECUTE / SANDBOX_GITHUB_TOKEN ghosts", () => {
    expect(isStaleGhost({ content: "operator must set ALLOW_COMPOSIO_EXECUTE=true" })).toBe(true);
    expect(isStaleGhost({ content: "git push is not enabled — set SANDBOX_GITHUB_TOKEN" })).toBe(true);
    expect(isStaleGhost({ content: "Composio execution is disabled" })).toBe(true);
  });
  it("keeps real lessons recallable", () => {
    const real = { content: "PROBLEM: web_scrape fails on github.com. FIX: use http_request against api.github.com." };
    expect(isStaleGhost(real)).toBe(false);
    expect(isRecallableMemory(real)).toBe(true);
  });
  it("a ghost lesson is not recallable", () => {
    expect(isRecallableMemory({ content: "set ALLOW_COMPOSIO_EXECUTE=true" })).toBe(false);
  });
});
