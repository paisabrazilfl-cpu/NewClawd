/**
 * Production freshness guard — proves the LIVE site is serving the LATEST commit,
 * so an old build can never silently "survive" on Render.
 *
 * It compares the entry-bundle hash in the COMMITTED dist (this checkout, i.e. the
 * branch/commit you expect to be live) against the hash the live URL actually
 * serves. They are content-addressed, so a match means the live shell is the one we
 * shipped; a mismatch means Render is serving a stale/older deploy → exit 1.
 *
 * Optional: with RENDER_API_KEY + RENDER_SERVICE_ID set, it also asserts Render's
 * active deploy status is "live".
 *
 *   PROD_URL=https://bos-aura.onrender.com pnpm --filter @workspace/scripts exec tsx src/verify-prod.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROD_URL = (process.env["PROD_URL"] ?? "https://bos-aura.onrender.com").replace(/\/$/, "");

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function bundleOf(html: string): string | null {
  // Vite content hashes can contain hyphens (e.g. index-e_nv-VFS.js), so allow
  // `-` and `.` in the hash segment — not just [A-Za-z0-9_].
  const m = html.match(/\/assets\/(index-[A-Za-z0-9_.-]+\.js)/);
  return m ? m[1] : null;
}

async function main() {
  const indexPath = join(repoRoot(), "artifacts/openclaw/dist/public/index.html");
  if (!existsSync(indexPath)) {
    console.error(`FAIL: committed index.html not found at ${indexPath}`);
    process.exit(1);
  }
  const committed = bundleOf(readFileSync(indexPath, "utf8"));
  if (!committed) {
    console.error("FAIL: could not find entry bundle in committed index.html");
    process.exit(1);
  }

  let liveHtml = "";
  try {
    const r = await fetch(PROD_URL + "/", { headers: { "cache-control": "no-cache" } });
    liveHtml = await r.text();
  } catch (e) {
    console.error(`FAIL: could not fetch ${PROD_URL} — ${String(e).slice(0, 120)}`);
    process.exit(1);
  }
  const live = bundleOf(liveHtml);

  // Optional Render deploy-status assertion.
  let renderStatus = "n/a";
  const key = process.env["RENDER_API_KEY"];
  const svc = process.env["RENDER_SERVICE_ID"];
  if (key && svc) {
    try {
      const r = await fetch(`https://api.render.com/v1/services/${svc}/deploys?limit=1`, { headers: { Authorization: `Bearer ${key}` } });
      const d = (await r.json()) as Array<{ deploy?: { status?: string } }>;
      renderStatus = d?.[0]?.deploy?.status ?? "unknown";
    } catch { renderStatus = "unreachable"; }
  }

  const match = !!live && live === committed;
  const renderOk = renderStatus === "n/a" || renderStatus === "live";
  const pass = match && renderOk;

  console.log(JSON.stringify({
    prodUrl: PROD_URL,
    committedBundle: committed,
    liveBundle: live,
    bundlesMatch: match,
    renderDeployStatus: renderStatus,
    result: pass ? "PASS — live is serving the latest committed build" : "FAIL — live is NOT the latest build",
  }, null, 2));

  if (!pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
