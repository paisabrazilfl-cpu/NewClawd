import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const agentsTable = pgTable("agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  description: text("description"),
  status: text("status").notNull().default("idle"),
  color: text("color").notNull(),
  avatarInitials: text("avatar_initials"),
  model: text("model"),
  contextUsed: integer("context_used").notNull().default(0),
  contextMax: integer("context_max").notNull().default(128000),
  // The operator-controlled ENABLED tool set (drives the Inspector glow AND, when
  // customized, real execution access). Defaults are kept in sync with each
  // agent's base toolset until the operator toggles one (then toolsCustomized).
  capabilities: text("capabilities").array().notNull().default([]),
  // Once the operator hand-tunes an agent's tools, stop auto-resyncing defaults.
  toolsCustomized: boolean("tools_customized").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAgentSchema = createInsertSchema(agentsTable).omit({ id: true, createdAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;
