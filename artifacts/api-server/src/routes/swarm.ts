import { Router } from "express";
import { db } from "@workspace/db";
import { agentsTable, tasksTable, messagesTable, agentCommandsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { senseActive } from "../lib/pheromones";

const router = Router();

let swarmPaused = false;
const startTime = Date.now();

export function isSwarmPaused(): boolean {
  return swarmPaused;
}

// HARD STOP — an abort "generation" counter. Every in-flight agent/orchestrator
// loop captures the current generation when it starts and bails the instant the
// generation changes. Pressing Stop bumps it, so EVERYTHING running aborts at its
// next checkpoint (within one step), while work started AFTER the stop is
// unaffected — so the operator isn't locked out and doesn't need to "resume".
let abortGeneration = 0;
export function swarmAbortGeneration(): number {
  return abortGeneration;
}
export function requestSwarmStop(): void {
  abortGeneration++;
}

router.get("/status", async (req, res) => {
  try {
    const [agentStats] = await db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status != 'idle')::int`,
    }).from(agentsTable);

    const [taskStats] = await db.select({
      running: sql<number>`count(*) filter (where status = 'running')::int`,
      completed: sql<number>`count(*) filter (where status = 'completed')::int`,
    }).from(tasksTable);

    const [msgStats] = await db.select({
      total: sql<number>`count(*)::int`,
    }).from(messagesTable);

    res.json({
      paused: swarmPaused,
      activeAgents: agentStats?.active ?? 0,
      totalAgents: agentStats?.total ?? 0,
      runningTasks: taskStats?.running ?? 0,
      completedTasks: taskStats?.completed ?? 0,
      totalMessages: msgStats?.total ?? 0,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      // Stigmergy: decayed "who's working on what" view (anti-collision signal).
      activeWork: senseActive(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get swarm status");
    res.status(500).json({ error: "Failed to get swarm status" });
  }
});

// Read-only pheromone field — the swarm's live "who is working on what" trails,
// decayed and pruned. Powers anti-collision and the operator's coordination view.
router.get("/pheromones", async (_req, res) => {
  res.json({ active: senseActive() });
});

router.post("/pause", async (req, res) => {
  try {
    swarmPaused = true;
    await db.update(agentsTable)
      .set({ status: "idle" })
      .where(eq(agentsTable.status, "thinking"));
    await db.update(agentsTable)
      .set({ status: "idle" })
      .where(eq(agentsTable.status, "executing"));

    const [agentStats] = await db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status != 'idle')::int`,
    }).from(agentsTable);

    const [taskStats] = await db.select({
      running: sql<number>`count(*) filter (where status = 'running')::int`,
      completed: sql<number>`count(*) filter (where status = 'completed')::int`,
    }).from(tasksTable);

    const [msgStats] = await db.select({ total: sql<number>`count(*)::int` }).from(messagesTable);

    res.json({
      paused: swarmPaused,
      activeAgents: agentStats?.active ?? 0,
      totalAgents: agentStats?.total ?? 0,
      runningTasks: taskStats?.running ?? 0,
      completedTasks: taskStats?.completed ?? 0,
      totalMessages: msgStats?.total ?? 0,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to pause swarm");
    res.status(500).json({ error: "Failed to pause swarm" });
  }
});

router.post("/resume", async (req, res) => {
  try {
    swarmPaused = false;

    const [agentStats] = await db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status != 'idle')::int`,
    }).from(agentsTable);

    const [taskStats] = await db.select({
      running: sql<number>`count(*) filter (where status = 'running')::int`,
      completed: sql<number>`count(*) filter (where status = 'completed')::int`,
    }).from(tasksTable);

    const [msgStats] = await db.select({ total: sql<number>`count(*)::int` }).from(messagesTable);

    res.json({
      paused: swarmPaused,
      activeAgents: agentStats?.active ?? 0,
      totalAgents: agentStats?.total ?? 0,
      runningTasks: taskStats?.running ?? 0,
      completedTasks: taskStats?.completed ?? 0,
      totalMessages: msgStats?.total ?? 0,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to resume swarm");
    res.status(500).json({ error: "Failed to resume swarm" });
  }
});

// HARD STOP: abort every in-flight agent loop immediately, idle all agents, and
// mark running work as stopped. Does NOT pause future dispatches (so the operator
// can start fresh right away) — it just kills what's running now.
router.post("/stop", async (req, res) => {
  try {
    requestSwarmStop();
    await db.update(agentsTable).set({ status: "idle" }).where(sql`status != 'idle'`);
    await db.update(tasksTable)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(tasksTable.status, "running"));
    await db.update(agentCommandsTable)
      .set({ status: "interrupted", result: "⛔ Stopped by operator.", completedAt: new Date() })
      .where(eq(agentCommandsTable.status, "running"));
    res.json({ stopped: true });
  } catch (err) {
    req.log.error({ err }, "Failed to stop swarm");
    res.status(500).json({ error: "Failed to stop swarm" });
  }
});

export default router;