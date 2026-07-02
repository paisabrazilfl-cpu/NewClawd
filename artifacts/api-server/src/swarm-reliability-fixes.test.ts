/**
 * Three swarm-reliability fixes, diagnosed from a live FORGE flail:
 *  1. sandbox_repo_pr clone URL malformed by a whitespace-laden token (covered by
 *     the trim/validate logic; the network clone itself is integration-only).
 *  2. memory_write storing junk lessons whose "evidence" is a fabricated search URL.
 *  3. ABBY claiming a build is complete when no artifact was produced.
 * These pin the pure/early-return logic behind 2 and 3.
 */
import { describe, it, expect } from "vitest";
import { goalWantsArtifact, resultsHaveArtifact } from "./orchestrator";
import { TOOL_REGISTRY } from "./tools";

describe("goalWantsArtifact", () => {
  it("is true for build/code/file goals", () => {
    expect(goalWantsArtifact("Code me a 3D racing game in TypeScript")).toBe(true);
    expect(goalWantsArtifact("create a new github repository")).toBe(true);
    expect(goalWantsArtifact("write a python script and a README")).toBe(true);
    expect(goalWantsArtifact("generate a PDF report")).toBe(true);
  });
  it("is false for pure question/answer goals", () => {
    expect(goalWantsArtifact("what is the capital of France?")).toBe(false);
    expect(goalWantsArtifact("summarize the latest AI news")).toBe(false);
  });
});

describe("resultsHaveArtifact", () => {
  it("detects a real deliverable signal", () => {
    expect(resultsHaveArtifact([{ result: "✅ created README.md in paisabrazilfl-cpu/big-blue (commit a1b2c3d).\nhttps://github.com/paisabrazilfl-cpu/big-blue/blob/main/README.md" }])).toBe(true);
    expect(resultsHaveArtifact([{ result: "saved \"game.html\" — [Download](https://bos-aura.onrender.com/api/uploads/1086?download=1)" }])).toBe(true);
    expect(resultsHaveArtifact([{ result: "created repository paisabrazilfl-cpu/swarm-selftest" }])).toBe(true);
    expect(resultsHaveArtifact([{ result: "Here is the code:\n```ts\n" + "const x = 1;\n".repeat(20) + "```" }])).toBe(true);
  });
  it("returns false when the swarm only ran commands / wrote a memory note", () => {
    expect(resultsHaveArtifact([{ result: "exit 0\nstdout: /tmp/swarm\nPython 3.11.6" }])).toBe(false);
    expect(resultsHaveArtifact([{ result: "stored memory #625." }])).toBe(false);
    expect(resultsHaveArtifact([{ result: "The 3D car racing game is complete." }])).toBe(false); // claim, not artifact
  });
});

describe("memory_write — fabricated-evidence gate", () => {
  const ctx = { agentId: 5, agentName: "FORGE" } as never;
  it("rejects a lesson whose evidence is a search-engine query URL", async () => {
    const junk = "PROBLEM → SOLUTION (evidence): clone failed → install selenium. Evidence: https://duckduckgo.com/?q=clone+failed+fix. Tags: lesson";
    const r = (await TOOL_REGISTRY.memory_write!.run({ content: junk }, ctx)) as string;
    expect(r).toMatch(/search-engine QUERY URL|fabricated citation/i);
  });

  it("rejects circuit-breaker / system run-state text stored as a 'lesson'", async () => {
    const noise = "CIRCUIT OPEN — web_search has returned nothing useful 4 times this run, so it is unavailable. STOP calling web_search and use a different tool.";
    const r = (await TOOL_REGISTRY.memory_write!.run({ content: noise }, ctx)) as string;
    expect(r).toMatch(/run-state|circuit-breaker|not a durable lesson/i);
  });
  it("rejects generic 'a tool failed, use a different tool' flailing", async () => {
    const junk = "PROBLEM: web_search failed due to repeated identical calls. SOLUTION: use a different tool or retry with what you already have.";
    const r = (await TOOL_REGISTRY.memory_write!.run({ content: junk }, ctx)) as string;
    expect(r).toMatch(/generic flailing|run-state|not a durable lesson/i);
  });

  it("still rejects a bare failure with no fix", async () => {
    const r = (await TOOL_REGISTRY.memory_write!.run({ content: "the whole request errored out completely and nothing at all came back from it" }, ctx)) as string;
    expect(r).toMatch(/not a durable lesson/i);
  });
});
