import { Link } from "wouter";
import { useGetSwarmStatus, usePauseSwarm, useResumeSwarm, getGetSwarmStatusQueryKey, resolveApiUrl } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Pause, Play, ArrowRight, OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";

/** Hard stop: abort every running agent immediately (POST /api/swarm/stop). */
export async function stopSwarm(): Promise<void> {
  try {
    await fetch(resolveApiUrl("/api/swarm/stop"), { method: "POST", credentials: "include" });
  } catch { /* best-effort */ }
}

function formatUptime(seconds?: number): string | null {
  if (!seconds || seconds < 1) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `up ${h}h ${m}m`;
  if (m > 0) return `up ${m}m`;
  return "up <1m";
}

/**
 * Persistent "what is the swarm doing right now" header for the observation-first
 * Swarm page. Everything here is derived from the real SwarmStatus payload — we
 * deliberately do NOT invent a current-goal/step field the backend doesn't have.
 * Goal-setting is handed off to Chat (the single command surface).
 */
export function SwarmStatusStrip() {
  const { data: status } = useGetSwarmStatus();
  const pauseSwarm = usePauseSwarm();
  const resumeSwarm = useResumeSwarm();
  const qc = useQueryClient();
  const hardStop = async () => {
    await stopSwarm();
    qc.invalidateQueries({ queryKey: getGetSwarmStatusQueryKey() });
  };

  const paused = status?.paused ?? false;
  const active = status?.activeAgents ?? 0;
  const running = status?.runningTasks ?? 0;
  const done = status?.completedTasks ?? 0;
  const total = status?.totalAgents ?? 0;
  const working = !paused && (active > 0 || running > 0);

  const headline = paused ? "Paused" : working ? "Working" : "Ready";
  const dot = paused ? "bg-muted-foreground" : working ? "bg-green-500" : "bg-primary";
  const uptime = formatUptime(status?.uptimeSeconds);

  const toggle = () => {
    if (paused) resumeSwarm.mutate(undefined as unknown as void);
    else pauseSwarm.mutate(undefined as unknown as void);
  };

  return (
    <div className="min-w-0 flex-1 border-b border-card-border bg-card/50 backdrop-blur px-3 sm:px-4 py-2.5 flex items-center gap-2 sm:gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        {working ? (
          /* 3D red thinking orb (blue orbit ring) while the swarm is working */
          <span className="thinking-orb-3d w-5 h-5 shrink-0" aria-hidden="true" />
        ) : (
          <span className={cn("w-2.5 h-2.5 rounded-full shrink-0 shadow-[0_0_8px_currentColor]", dot)} />
        )}
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">
            {working ? <span className="thinking-text">Swarm · Working…</span> : <span className="text-foreground">Swarm · {headline}</span>}
          </div>
          <div className="text-[11px] text-muted-foreground leading-tight truncate">
            {active} of {total} agents active · {running} running · {done} done{uptime ? ` · ${uptime}` : ""}
          </div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
        <button
          onClick={hardStop}
          aria-label="Stop everything now"
          title="Hard stop — abort every running agent immediately"
          className="flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 rounded-lg border border-destructive/50 bg-destructive/15 text-destructive text-xs font-semibold hover:bg-destructive/25 transition-colors"
        >
          <OctagonX className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Stop</span>
        </button>
        <button
          onClick={toggle}
          aria-label={paused ? "Resume swarm" : "Pause swarm"}
          className="flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 rounded-lg border border-card-border text-xs text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
        >
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{paused ? "Resume" : "Pause"}</span>
        </button>
        <Link href="/">
          <button
            aria-label="Set a goal"
            className="flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 rounded-lg bg-primary/15 border border-primary/30 text-primary text-xs font-semibold hover:bg-primary/25 transition-colors"
          >
            <span className="hidden sm:inline">Set a goal</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </Link>
      </div>
    </div>
  );
}
