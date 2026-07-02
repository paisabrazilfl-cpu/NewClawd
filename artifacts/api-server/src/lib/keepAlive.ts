import { logger } from "./logger";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes — under Render's 15-min idle window

function resolveBaseUrl(): string | undefined {
  // Priority: explicit override → Render's auto-injected URL → operator's public
  // base → the known production URL. The final fallback guarantees the daemon ALWAYS
  // has a target in production, so it can never silently fail to keep the app awake.
  const candidates = [
    process.env["KEEP_ALIVE_URL"],
    process.env["RENDER_EXTERNAL_URL"],
    process.env["PUBLIC_BASE_URL"],
    "https://bos-aura.onrender.com",
  ];
  for (const c of candidates) {
    if (c && c.trim().length > 0 && /^https?:\/\//i.test(c.trim())) return c.trim();
  }
  return undefined;
}

function resolveIntervalMs(): number {
  const raw = process.env["KEEP_ALIVE_INTERVAL_MS"];
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn(
      { raw },
      "Invalid KEEP_ALIVE_INTERVAL_MS — falling back to default 10 minutes",
    );
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

/**
 * Periodically pings this service's own public health endpoint so that
 * Render (free/starter tier) does not spin the instance down after idle.
 * A self-ping counts as inbound HTTP traffic and resets the idle timer.
 *
 * Only active in production and only when a public URL is resolvable.
 */
export function startKeepAlive(): void {
  if (process.env["NODE_ENV"] !== "production") {
    return;
  }
  if (process.env["KEEP_ALIVE_DISABLED"] === "true") {
    logger.info("Keep-alive self-ping disabled via KEEP_ALIVE_DISABLED");
    return;
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    logger.warn(
      "Keep-alive self-ping not started — set RENDER_EXTERNAL_URL or KEEP_ALIVE_URL to enable it",
    );
    return;
  }

  const intervalMs = resolveIntervalMs();
  const target = `${baseUrl.replace(/\/$/, "")}/api/healthz`;

  const ping = async (): Promise<void> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(target, {
        method: "GET",
        signal: controller.signal,
        headers: { "user-agent": "bos-aura-keepalive" },
      });
      if (!res.ok) {
        logger.warn({ status: res.status, target }, "Keep-alive ping non-OK");
      } else {
        logger.debug({ target }, "Keep-alive ping ok");
      }
    } catch (err) {
      logger.warn({ err, target }, "Keep-alive ping failed");
    } finally {
      clearTimeout(timeout);
    }
  };

  const timer = setInterval(() => {
    void ping();
  }, intervalMs);
  // Do not keep the event loop alive solely for the keep-alive timer (the HTTP
  // server already holds it open for the life of the process).
  timer.unref();

  // Warm the very first window too — a single ping ~20s after boot, so a service
  // that started idle never reaches the 15-min cutoff before the first interval.
  const first = setTimeout(() => void ping(), 20_000);
  first.unref();

  logger.info(
    { target, intervalMs },
    "Keep-alive self-ping started — service will not idle-sleep",
  );
}
