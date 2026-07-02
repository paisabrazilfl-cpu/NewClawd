import { useGetSwarmStatus, useListAgents, getListAgentsQueryKey } from "@workspace/api-client-react";
import { agentState } from "@/lib/agentState";
import { cn } from "@/lib/utils";

/**
 * "What is the swarm doing right now" indicator — a 3D red orb that spins (with a
 * blue orbit ring) while the swarm is working, next to a red↔blue shimmering
 * status label derived from the real active agents (name + state). Like Gemini's
 * live "Creating your image…" cue. Renders nothing when the swarm is idle/paused,
 * so it never nags a calm swarm.
 *
 * `force` lets a caller (e.g. the Chat composer while ABBY streams) show it even
 * before the agent-status poll catches up; `label` overrides the derived text.
 */
export function SwarmThinking({
  size = "md",
  force = false,
  label,
  className,
}: {
  size?: "sm" | "md";
  force?: boolean;
  label?: string;
  className?: string;
}) {
  const { data: status } = useGetSwarmStatus();
  const { data: agents = [] } = useListAgents({
    query: { refetchInterval: 2500, queryKey: getListAgentsQueryKey() },
  });

  const paused = status?.paused ?? false;
  const working = !paused && ((status?.activeAgents ?? 0) > 0 || (status?.runningTasks ?? 0) > 0);
  if (!working && !force) return null;

  const activeAgents = agents.filter((a) => agentState(a.status).active);
  const lead = activeAgents[0];
  const derived = lead
    ? `${lead.name} is ${agentState(lead.status).label.toLowerCase()}`
    : "Swarm is working";
  const extra = activeAgents.length > 1 ? ` · +${activeAgents.length - 1} more` : "";
  const text = label ?? `${derived}${extra}`;

  const orb = size === "sm" ? "w-3.5 h-3.5" : "w-5 h-5";

  return (
    <div className={cn("flex items-center gap-2.5 min-w-0", className)} role="status" aria-live="polite">
      <span className={cn("thinking-orb-3d shrink-0", orb)} aria-hidden="true" />
      <span className={cn("thinking-text font-semibold truncate", size === "sm" ? "text-xs" : "text-sm")}>
        {text}
        <span className="thinking-dots">…</span>
      </span>
    </div>
  );
}
