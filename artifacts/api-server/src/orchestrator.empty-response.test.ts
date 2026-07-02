/**
 * Empty-LLM-response reliability fix.
 *
 * Two failure modes the user is hitting live:
 *  1. completeChat() used to return the LITERAL STRING "(no response)" when the
 *     NIM call succeeded with an empty/missing `choices[0].message.content`.
 *     That string then leaked into parseDirectives(), into the synthesis pass,
 *     and into the operator's final briefing — it looks like a real answer
 *     ("here is your plan: (no response)"). Downstream code had no signal that
 *     the LLM actually said nothing, so the swarm's recovery loop and the
 *     solution gate both treated the empty LLM as a substantive CLAW report.
 *     The fix: an empty LLM content from a successful HTTP 200 is a real,
 *     recoverable error — surface it as a thrown error so the caller knows
 *     the LLM produced nothing (and can retry, fall back, or block the run).
 *
 *  2. executeAgentCommand() used to persist the literal string
 *     "(no result produced)" as the agent's `finalText` when the CLAW loop
 *     exited with no text. resultWasBlocked() already recognizes that string
 *     as a blocked-marker (orchestrator.loop.test.ts), so the orchestrator's
 *     recovery loop correctly TRIES to recover — but the marker is too soft:
 *     it provides no signal WHY the result was empty (LLM dead? NIM credit
 *     exhausted? provider 5xx?). The fix: when a CLAW loop ends with no text
 *     AND no verified tool wins, persist a clearly-flagged blocked-marker
 *     that names the failure mode, so an operator reading the agent feed
 *     understands the agent didn't actually do anything.
 *
 * Together these stop the "looks done, says nonsense, never actually worked"
 * pattern the user described.
 */
import { describe, it, expect } from "vitest";
import { resultWasBlocked } from "./orchestrator";

describe("empty LLM response — must be a hard error, not a successful string", () => {
  it("treats '(no response)' as a blocked marker (regression: was a real-looking answer)", () => {
    // The old behavior returned "(no response)" as a successful LLM string,
    // which parseDirectives() accepted as a real directive, which the agent
    // loop accepted as a real result, which the synthesis LLM accepted as
    // real evidence. The recovery layer already detects it as blocked —
    // verify that contract still holds so the fix is layered.
    expect(resultWasBlocked("(no response)")).toBe(true);
  });

  it("treats an explicit empty-result marker as blocked", () => {
    expect(resultWasBlocked("(no result produced)")).toBe(true);
  });

  it("treats a clearly-flagged empty-LLM-response marker as blocked", () => {
    // The new marker this fix introduces for executeAgentCommand's empty
    // finalText path. Must be detectable by the same recovery path so
    // ABBY's solve loop re-dispatches the directive to a different agent /
    // tool instead of accepting an empty answer as a result.
    const emptyMarker =
      "⚠️ CLAW loop completed without producing a final answer and without " +
      "a verified tool result (UNVERIFIED — empty LLM response, no tool succeeded).";
    expect(resultWasBlocked(emptyMarker)).toBe(true);
  });
});

describe("empty LLM response — does NOT mis-flag real results", () => {
  it("a real agent reply with a real answer is not blocked", () => {
    expect(resultWasBlocked("Done. Posted to Instagram: https://instagram.com/p/abc123")).toBe(false);
  });

  it("a long substantive agent answer is not blocked", () => {
    const real =
      "I found 3 competitors in the Brazilian fintech market. " +
      "1. Nubank — pricing: freemium, 0.5% on credit interchange. " +
      "2. Inter — premium tier at R$29.90/month. " +
      "3. C6 Bank — yields 102% CDI on the savings account.";
    expect(resultWasBlocked(real)).toBe(false);
  });
});

describe("empty LLM response — fix layered end-to-end", () => {
  // The fix is layered: completeChat now throws on empty content (instead of
  // returning the literal "(no response)" string), executeAgentCommand emits a
  // flagged blocked marker on empty finalText, and resultWasBlocked recognizes
  // every flavor of empty-response so the orchestrator's recovery loop treats
  // them all as "this CLAW did not actually do anything" — not as a successful
  // result the synthesis pass can hallucinate a completion on top of.
  //
  // These tests pin the recognition contract: every empty-response flavor the
  // LLM can produce (or that the agent loop emits) is now detectable as
  // blocked. If a future change adds a new failure mode, this contract fails
  // first and forces the author to extend the recovery net.

  it("every flavor of empty-response is detectable as blocked", () => {
    // Direct empty
    expect(resultWasBlocked("")).toBe(true);
    expect(resultWasBlocked("   ")).toBe(true);
    // Old placeholder strings
    expect(resultWasBlocked("(no response)")).toBe(true);
    expect(resultWasBlocked("(no result produced)")).toBe(true);
    // New flagged marker
    expect(resultWasBlocked(
      "⚠️ CLAW loop completed without producing a final answer and without a verified tool result (UNVERIFIED — empty LLM response, no tool succeeded).",
    )).toBe(true);
    // error: prefix (also handled)
    expect(resultWasBlocked("error: NIM 429: rate limited")).toBe(true);
    // legacy "could not complete" markers
    expect(resultWasBlocked("⚠️ CRAWLER could not complete its directive (UNVERIFIED — blocked or errored): captcha wall")).toBe(true);
  });
});
