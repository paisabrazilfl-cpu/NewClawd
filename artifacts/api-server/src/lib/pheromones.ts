/**
 * PheromoneField — lightweight stigmergic coordination for the swarm.
 *
 * Stigmergy = agents leave traces in a shared environment; the environment then
 * influences other agents, so they coordinate WITHOUT direct messaging. Here it
 * buys two concrete things the live swarm was missing:
 *
 *  1. Anti-collision: when an agent starts a directive that closely overlaps work
 *     ANOTHER agent is already doing (e.g. SCOUT re-searching GitHub while FORGE
 *     is already building the repo — observed live), the second agent's prompt
 *     gets an advisory to build on / defer to the first instead of duplicating.
 *  2. "Who's working on what" — a decayed, read-only view of in-flight work for
 *     the operator dashboard and routing.
 *
 * Design choices that fit THIS codebase (not the textbook continuous tick loop):
 *  - One active pheromone per agent (an agent runs exactly one directive at a
 *    time in executeAgentCommand), stored in a Map and replaced on each deposit.
 *  - Lazy time-decay + TTL expiry evaluated on READ — no setInterval timer to
 *    leak or shut down, and trivially testable with an injectable `now`.
 *  - The influence is ADVISORY only (a prompt note), never a hard block: we just
 *    spent a lot of effort killing loops/stalls, and a hard "someone else has
 *    this" gate could deadlock the swarm. Nudge, don't fence.
 */

export interface Pheromone {
  agentId: number;
  agentName: string;
  /** Short human-readable topic (the directive, trimmed) for the dashboard. */
  topic: string;
  /** Significant tokens used for overlap detection. */
  tokens: string[];
  /** Intensity at deposit time (always 1.0 today; kept for future amplification). */
  intensity0: number;
  depositedAt: number;
  ttlMs: number;
}

const HALFLIFE_MS = 90_000; // intensity halves every 90s of inactivity
const TTL_MS = 5 * 60_000; // a trace can't outlive ~5 min (a stuck directive)
const MIN_INTENSITY = 0.05; // below this a trace is treated as gone
const JACCARD_THRESHOLD = 0.45; // token-set overlap that counts as "same work"

// One active pheromone per agent. Module-level (single-process) state, same shape
// as isSwarmPaused()/swarmAbortGeneration() — the swarm runs in one API process.
const field = new Map<number, Pheromone>();

const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "you", "that", "this", "from", "into",
  "then", "via", "are", "was", "will", "should", "must", "they", "them", "their",
  "have", "has", "had", "not", "but", "all", "any", "can", "use", "using", "used",
  "its", "it's", "a", "an", "to", "of", "in", "on", "is", "be", "as", "at", "or",
  "by", "if", "do", "so", "we", "i", "me", "my", "our", "out", "up", "per", "etc",
]);

/** Lowercase → significant token set (drops stopwords + tokens shorter than 3). */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}

/** Current decayed intensity of a trace, or 0 if expired. */
function liveIntensity(p: Pheromone, now: number): number {
  const age = now - p.depositedAt;
  if (age > p.ttlMs) return 0;
  const v = p.intensity0 * Math.pow(0.5, age / HALFLIFE_MS);
  return v < MIN_INTENSITY ? 0 : v;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of a) if (setB.has(t)) inter++;
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

/** An agent begins a directive — deposit (replacing its previous trace). */
export function depositDirective(agentId: number, agentName: string, directive: string, now = Date.now()): void {
  const topic = directive.replace(/\s+/g, " ").trim().slice(0, 120);
  field.set(agentId, {
    agentId,
    agentName,
    topic,
    tokens: tokenize(directive),
    intensity0: 1.0,
    depositedAt: now,
    ttlMs: TTL_MS,
  });
}

/** An agent finished (success or failure) — remove its trace. */
export function clearAgent(agentId: number): void {
  field.delete(agentId);
}

/** Read-only "who's working on what", decayed and pruned. Strongest first. */
export function senseActive(now = Date.now()): Array<{ agentId: number; agentName: string; topic: string; intensity: number }> {
  const out: Array<{ agentId: number; agentName: string; topic: string; intensity: number }> = [];
  for (const [id, p] of field) {
    const intensity = liveIntensity(p, now);
    if (intensity <= 0) { field.delete(id); continue; } // lazy evaporation
    out.push({ agentId: id, agentName: p.agentName, topic: p.topic, intensity: Number(intensity.toFixed(3)) });
  }
  return out.sort((a, b) => b.intensity - a.intensity);
}

/** Is another active agent already doing closely-overlapping work? */
export function findCollision(
  directive: string,
  excludeAgentId: number,
  now = Date.now(),
): { agentName: string; topic: string; overlap: number; intensity: number } | null {
  const tokens = tokenize(directive);
  if (tokens.length === 0) return null;
  let best: { agentName: string; topic: string; overlap: number; intensity: number } | null = null;
  for (const [id, p] of field) {
    if (id === excludeAgentId) continue;
    const intensity = liveIntensity(p, now);
    if (intensity <= 0) { field.delete(id); continue; }
    const overlap = jaccard(tokens, p.tokens);
    if (overlap >= JACCARD_THRESHOLD && (!best || overlap > best.overlap)) {
      best = { agentName: p.agentName, topic: p.topic, overlap: Number(overlap.toFixed(2)), intensity: Number(intensity.toFixed(3)) };
    }
  }
  return best;
}

/**
 * Advisory line to inject into an agent's prompt when it collides with in-flight
 * work — "" when there's no collision. Advisory only: it nudges the agent to
 * build on / defer, never hard-blocks (that could deadlock the swarm).
 */
export function pheromoneAdvisory(directive: string, excludeAgentId: number, now = Date.now()): string {
  const c = findCollision(directive, excludeAgentId, now);
  if (!c) return "";
  return (
    `\n\n🐜 SWARM SIGNAL (stigmergy): ${c.agentName} is ALREADY working on a closely related task ("${c.topic}"). ` +
    `Do NOT duplicate their effort — check the shared state / their result first and BUILD ON it or defer to it. ` +
    `Only redo their work if you have concrete evidence it failed.`
  );
}

/** Test helper — wipe the field. */
export function _resetPheromones(): void {
  field.clear();
}
