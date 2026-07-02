import { Router } from "express";
import { db } from "@workspace/db";
import { agentsTable, insertAgentSchema } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAllToolNames, setAgentToolOverride } from "../tools";

const router = Router();

const VALID_STATUSES = ["idle", "thinking", "executing", "waiting", "stalled", "hitl"] as const;

// The full universe of real, toggleable tools — the Inspector matrix uses this to
// know which chips are live (toggleable) vs decorative.
router.get("/registry/tools", (_req, res) => {
  res.json({ tools: getAllToolNames() });
});

router.get("/", async (req, res) => {
  try {
    const agents = await db.select().from(agentsTable).orderBy(agentsTable.id);
    res.json(agents.map(a => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to list agents");
    res.status(500).json({ error: "Failed to list agents" });
  }
});

router.post("/", async (req, res) => {
  const parse = insertAgentSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid agent data" });
  }
  try {
    const [agent] = await db.insert(agentsTable).values(parse.data).returning();
    return res.status(201).json({ ...agent, createdAt: agent.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to create agent");
    return res.status(500).json({ error: "Failed to create agent" });
  }
});

router.get("/:agentId", async (req, res) => {
  const id = parseInt(req.params.agentId);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  try {
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    return res.json({ ...agent, createdAt: agent.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to get agent");
    return res.status(500).json({ error: "Failed to get agent" });
  }
});

// Toggle a single tool on/off for an agent (the Inspector matrix). Activating a
// tool makes it glow and grants the agent real access; deactivating removes both.
// Once toggled, the agent is "customized" so defaults stop auto-resyncing.
router.patch("/:agentId/tools", async (req, res) => {
  const id = parseInt(req.params.agentId);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const { tool, enabled } = req.body as { tool?: string; enabled?: boolean };
  if (!tool || typeof tool !== "string") return res.status(400).json({ error: "tool is required" });
  if (!getAllToolNames().includes(tool)) return res.status(400).json({ error: "Unknown tool" });
  try {
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const current = new Set((agent.capabilities as string[]) ?? []);
    if (enabled) current.add(tool);
    else current.delete(tool);
    const next = [...current];
    const [updated] = await db
      .update(agentsTable)
      .set({ capabilities: next, toolsCustomized: true })
      .where(eq(agentsTable.id, id))
      .returning();
    // Apply to the live execution gate immediately.
    setAgentToolOverride(id, next);
    return res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle agent tool");
    return res.status(500).json({ error: "Failed to toggle agent tool" });
  }
});

router.patch("/:agentId", async (req, res) => {
  const id = parseInt(req.params.agentId);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
  const { status, description, model, contextUsed } = req.body as {
    status?: string;
    description?: string;
    model?: string;
    contextUsed?: number;
  };
  if (status && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const updates: Record<string, unknown> = {};
  if (status) updates.status = status;
  if (description !== undefined) updates.description = description;
  if (model !== undefined) updates.model = model;
  if (contextUsed !== undefined) updates.contextUsed = contextUsed;
  try {
    const [agent] = await db.update(agentsTable).set(updates).where(eq(agentsTable.id, id)).returning();
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    return res.json({ ...agent, createdAt: agent.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to update agent");
    return res.status(500).json({ error: "Failed to update agent" });
  }
});

export default router;
