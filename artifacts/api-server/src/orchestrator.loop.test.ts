/**
 * Loop-accuracy guard — a CLAW that repeats the exact same call, or makes no
 * forward progress for several steps, is flailing and must be stopped so it
 * concludes with what it has instead of burning the whole step budget
 * (observed live: ~40 identical web_search/save_artifact calls on one
 * directive). Pins the escalation policy so it can't silently drift.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { mockDb } = await import("./test/dbMock");
  return { ...actual, db: mockDb };
});

import { repeatedCallAction, MAX_IDENTICAL_CALL_ATTEMPTS, MAX_NO_PROGRESS_STREAK, stableStringify, resultWasBlocked, isUnproductiveResult, TOOL_BREAKER_LIMIT, isVerifiedWin } from "./orchestrator";

describe("circuit breaker: classify unproductive tool results", () => {
  it("flags dead-search / error / empty results as unproductive", () => {
    expect(isUnproductiveResult('no web results for "anything"')).toBe(true);
    expect(isUnproductiveResult("error: Steel 500 internal error")).toBe(true);
    expect(isUnproductiveResult("https://x is bot-walled or returned no readable content")).toBe(true);
    expect(isUnproductiveResult('no relevant memory entries matched "x"')).toBe(true);
  });
  it("does NOT flag a real result as unproductive", () => {
    expect(isUnproductiveResult("✅ created src/main.py (commit c4b6515).")).toBe(false);
    expect(isUnproductiveResult('HTTP 200 {"name":"COMPOSIOFREE"}')).toBe(false);
  });
  it("trips after a small, finite number of strikes (no infinite loops)", () => {
    expect(TOOL_BREAKER_LIMIT).toBeGreaterThan(0);
    expect(TOOL_BREAKER_LIMIT).toBeLessThanOrEqual(6);
  });
});

describe("resultWasBlocked — ABBY recovers a blocked CLAW, not a real result", () => {
  it("flags the hard-failure markers a blocked directive emits", () => {
    expect(resultWasBlocked("⚠️ CRAWLER could not complete its directive (UNVERIFIED — blocked or errored): captcha wall")).toBe(true);
    expect(resultWasBlocked("error: Composio execution is disabled.")).toBe(true);
    expect(resultWasBlocked("(no result produced)")).toBe(true);
    expect(resultWasBlocked("")).toBe(true);
  });

  it("does NOT flag a real result (so a successful action isn't re-run)", () => {
    expect(resultWasBlocked("Posted to Instagram: https://instagram.com/p/abc123")).toBe(false);
    expect(resultWasBlocked("Found 3 competitors; pricing table below. The page returned a 403 for one source, noted.")).toBe(false);
    expect(resultWasBlocked("Sent the email to the team. Message id 18ab.")).toBe(false);
  });
});

describe("stableStringify — canonical keys so the dedupe/loop guards trigger", () => {
  it("produces the same string regardless of object key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("is stable for nested objects and arrays", () => {
    expect(stableStringify({ q: "x", opts: { z: 1, a: 2 } })).toBe(
      stableStringify({ opts: { a: 2, z: 1 }, q: "x" }),
    );
  });

  it("distinguishes genuinely different args", () => {
    expect(stableStringify({ url: "a" })).not.toBe(stableStringify({ url: "b" }));
  });
});

describe("repeatedCallAction — escalate identical tool calls", () => {
  it("runs the first attempt normally", () => {
    expect(repeatedCallAction(1)).toBe("run");
  });

  it("nudges on the second-to-last allowed attempt", () => {
    expect(repeatedCallAction(MAX_IDENTICAL_CALL_ATTEMPTS - 1)).toBe("nudge");
  });

  it("hard-stops once the identical call hits the attempt cap", () => {
    expect(repeatedCallAction(MAX_IDENTICAL_CALL_ATTEMPTS)).toBe("stop");
    expect(repeatedCallAction(MAX_IDENTICAL_CALL_ATTEMPTS + 5)).toBe("stop");
  });

  it("has sane, loop-bounding constants", () => {
    expect(MAX_IDENTICAL_CALL_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(MAX_IDENTICAL_CALL_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(MAX_NO_PROGRESS_STREAK).toBeGreaterThanOrEqual(2);
  });
});

describe("JUDGE: surface verified wins so success can't be reported as failure", () => {
  it("recognizes commits, posts and generated assets as wins", () => {
    expect(isVerifiedWin("github_commit_file", "✅ created src/main.py (commit c4b6515).")).toBe(true);
    expect(isVerifiedWin("instagram_post", "✅ Instagram post is LIVE\npermalink: https://instagr.am/p/x")).toBe(true);
    expect(isVerifiedWin("image_generate", "generated image. Its PUBLIC image URL: https://x/y.png")).toBe(true);
  });
  it("does NOT count memory bookkeeping as a deliverable win", () => {
    expect(isVerifiedWin("memory_write", "stored memory #611.")).toBe(false);
  });
  it("does NOT count a plain failure as a win", () => {
    expect(isVerifiedWin("web_search", "no web results for x")).toBe(false);
  });
});
