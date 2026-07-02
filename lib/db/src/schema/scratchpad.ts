import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// The swarm's shared SCRATCH PAD — quick reference notes any agent (or the
// operator) can jot down and recall fast. Deliberately lighter than agent_memory
// (which is durable, semantically-indexed long-term learning): the scratch pad is
// for short working notes — "remember this for next time", handy facts, gotchas —
// kept human-readable and visible in the UI.
export const scratchpadTable = pgTable("scratchpad_notes", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id"),
  agentName: text("agent_name"),
  // Optional short label/topic so notes group and scan quickly.
  topic: text("topic"),
  note: text("note").notNull(),
  tags: text("tags"),
  // Pinned notes float to the top as the "quick reference" the swarm leans on.
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertScratchpadSchema = createInsertSchema(scratchpadTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ScratchpadNote = typeof scratchpadTable.$inferSelect;
export type InsertScratchpadNote = z.infer<typeof insertScratchpadSchema>;
