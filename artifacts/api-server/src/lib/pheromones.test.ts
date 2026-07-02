/**
 * PheromoneField — stigmergic coordination. These tests pin the behaviour the
 * swarm relies on: deposit/sense, time-decay + TTL evaporation, anti-collision
 * detection via token overlap, and the advisory injection (which must stay
 * advisory — present on collision, empty otherwise).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  tokenize, depositDirective, clearAgent, senseActive, findCollision, pheromoneAdvisory, _resetPheromones,
} from "./pheromones";

beforeEach(() => _resetPheromones());

describe("tokenize", () => {
  it("keeps significant tokens and drops stopwords / short tokens", () => {
    const t = tokenize("Create a new GitHub repository and commit the README");
    expect(t).toContain("create");
    expect(t).toContain("github");
    expect(t).toContain("repository");
    expect(t).toContain("readme");
    expect(t).not.toContain("the");
    expect(t).not.toContain("a");
  });
});

describe("deposit / sense", () => {
  it("reports who is working on what, one trace per agent", () => {
    depositDirective(5, "FORGE", "Build the 3D racing game repo");
    depositDirective(4, "SCOUT", "Research racing game references");
    const active = senseActive();
    expect(active.map((a) => a.agentName).sort()).toEqual(["FORGE", "SCOUT"]);
    expect(active.every((a) => a.intensity > 0)).toBe(true);
  });

  it("a new deposit replaces the agent's previous trace", () => {
    depositDirective(5, "FORGE", "first task");
    depositDirective(5, "FORGE", "second task");
    const active = senseActive();
    expect(active).toHaveLength(1);
    expect(active[0].topic).toContain("second task");
  });

  it("clearAgent evaporates the trace immediately", () => {
    depositDirective(5, "FORGE", "build something");
    clearAgent(5);
    expect(senseActive()).toHaveLength(0);
  });
});

describe("decay + TTL", () => {
  it("intensity halves after one half-life and expires past the TTL", () => {
    const t0 = 1_000_000;
    depositDirective(5, "FORGE", "build the repo now", t0);
    const half = senseActive(t0 + 90_000)[0];
    expect(half.intensity).toBeGreaterThan(0.45);
    expect(half.intensity).toBeLessThan(0.55);
    // Past the 5-min TTL → gone (and lazily pruned).
    expect(senseActive(t0 + 5 * 60_000 + 1)).toHaveLength(0);
  });
});

describe("anti-collision", () => {
  it("detects another agent already on closely-overlapping work", () => {
    depositDirective(5, "FORGE", "create a new github repository and commit the readme");
    const c = findCollision("create a new github repository, then commit a readme file", 4);
    expect(c).not.toBeNull();
    expect(c!.agentName).toBe("FORGE");
    expect(c!.overlap).toBeGreaterThanOrEqual(0.45);
  });

  it("does NOT flag unrelated work, and never collides with self", () => {
    depositDirective(5, "FORGE", "create a new github repository and commit the readme");
    expect(findCollision("post the quarterly marketing image to instagram", 4)).toBeNull();
    expect(findCollision("create a new github repository and commit the readme", 5)).toBeNull(); // self excluded
  });

  it("the advisory is present on collision and empty otherwise", () => {
    depositDirective(5, "FORGE", "build the three.js racing game and deploy it");
    expect(pheromoneAdvisory("build the three.js racing game now", 4)).toMatch(/SWARM SIGNAL/);
    expect(pheromoneAdvisory("write a haiku about the sea", 4)).toBe("");
  });
});
