import { useEffect, useRef } from "react";
import { toast } from "sonner";

// Which entry bundle THIS running app loaded (content-hashed, changes every build).
function currentEntry(): string | null {
  const src = [...document.querySelectorAll('script[type="module"][src]')]
    .map((el) => (el as HTMLScriptElement).src)
    .find((s) => /\/assets\/index-[\w.-]+\.js/.test(s));
  return src ? (src.match(/\/assets\/(index-[\w.-]+\.js)/)?.[1] ?? null) : null;
}

const TRIED_KEY = "abby.update.tried";

/**
 * Keeps the installed app (home-screen PWA / browser) fresh. The SPA shell is
 * served `no-store`, so fetching it always returns the LATEST build's entry
 * bundle name. We compare that to the bundle THIS session is running; when prod
 * ships a newer build, we reload once to pick it up — so the phone never gets
 * stuck on an old version. Guarded via sessionStorage so it can never loop, and
 * it only acts while the tab is visible (never yanks the page mid-keystroke off
 * screen). Checks on mount, when the app is re-foregrounded, and every 60s.
 */
export function useAppAutoUpdate(): void {
  const mineRef = useRef<string | null>(null);
  useEffect(() => {
    mineRef.current = currentEntry();
    if (!mineRef.current) return;
    let stopped = false;

    const check = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const base = import.meta.env.BASE_URL || "/";
        const res = await fetch(`${base}?_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const html = await res.text();
        const live = html.match(/\/assets\/(index-[\w.-]+\.js)/)?.[1] ?? null;
        if (!live || live === mineRef.current) return;          // already current
        if (sessionStorage.getItem(TRIED_KEY) === live) return; // already reloaded for this build → no loop
        sessionStorage.setItem(TRIED_KEY, live);
        toast("Updating to the latest version…");
        setTimeout(() => window.location.reload(), 1200);
      } catch {
        /* offline or transient — try again next tick */
      }
    };

    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => void check(), 60_000);
    void check();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, []);
}
