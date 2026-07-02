import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { mockDb } = await import("./test/dbMock");
  return { ...actual, db: mockDb };
});

import { requestsConnectedAccountAction, requestsCodeWork } from "./routes/ai";

// The router forces a goal onto BUZZ's single-agent social path only when it's a
// connected-account ACTION AND not a build/code task: (connected && !code).
const forcedToSocialAgent = (m: string) =>
  requestsConnectedAccountAction(m) && !requestsCodeWork(m);

describe("router: build tasks that mention a connected service must NOT be hijacked to the social agent", () => {
  it("'look in my GitHub and build me a free version of composio' → decomposition, NOT BUZZ", () => {
    const m = "Look in my GitHub for COMPOSIOFREE and build me a free version of the app composio, break it down by steps then build those steps";
    expect(requestsCodeWork(m)).toBe(true);
    expect(forcedToSocialAgent(m)).toBe(false);
  });
  it("a real social action still routes to the connected-account path", () => {
    const m = "post this image to my Instagram";
    expect(forcedToSocialAgent(m)).toBe(true);
  });
  it("'check my Gmail' still routes to the connected-account path", () => {
    expect(forcedToSocialAgent("check my Gmail for new messages")).toBe(true);
  });
});

import { buildDecompositionStrategy } from "./routes/ai";

describe("every agent — not just the coder — has a decomposition strategy", () => {
  it("all six roles get a non-empty, role-specific decomposition playbook", () => {
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const s = buildDecompositionStrategy(id);
      expect(s, `agent #${id} must have a decomposition strategy`).toContain("DECOMPOSITION STRATEGY");
      expect(s.length, `agent #${id} strategy must be substantive`).toBeGreaterThan(80);
    }
  });
  it("the strategies are domain-specific (research vs build vs social vs asset vs docs)", () => {
    expect(buildDecompositionStrategy(4).toLowerCase()).toContain("research");
    expect(buildDecompositionStrategy(5).toLowerCase()).toContain("build");
    expect(buildDecompositionStrategy(3).toLowerCase()).toContain("connected-account");
    expect(buildDecompositionStrategy(2).toLowerCase()).toContain("asset");
    expect(buildDecompositionStrategy(6).toLowerCase()).toContain("document");
  });
});
