import { chromium, type ConsoleMessage } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Logged-in walk of EVERY tab at desktop + mobile. Signs in with the test operator
// password, visits each route, and records render + console errors + horizontal
// overflow + a screenshot. Evidence-only: a tab PASSES when it mounts content, has
// no page/console errors, and no horizontal overflow.
const BASE = (process.env["BASE_URL"] ?? "http://localhost:3001").replace(/\/$/, "");
const PWD = process.env["OPERATOR_PASSWORD"] ?? "test-password";
const OUT = join(process.cwd(), ".self-test", "tabs");
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  { path: "/", name: "chat" },
  { path: "/swarm", name: "swarm" },
  { path: "/tasks", name: "tasks" },
  { path: "/agents", name: "agents" },
  { path: "/cron", name: "scheduled" },
  { path: "/settings", name: "settings" },
];
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, isMobile: false },
  { name: "mobile", width: 390, height: 844, isMobile: true },
];

async function run() {
  const browser = await chromium.launch();
  const results: Record<string, unknown>[] = [];
  let anyFail = false;

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
      hasTouch: vp.isMobile,
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();

    // ── Sign in once per context ──────────────────────────────────────────────
    await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(1500);
    const pwInput = page.locator('input[type="password"]');
    if (await pwInput.count()) {
      await pwInput.fill(PWD);
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(2500); // session set + app re-render
    }
    const loggedIn = (await page.locator('input[type="password"]').count()) === 0;

    for (const route of ROUTES) {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const onConsole = (m: ConsoleMessage) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); };
      const onPageErr = (e: Error) => pageErrors.push(String(e).slice(0, 160));
      page.on("console", onConsole);
      page.on("pageerror", onPageErr);

      let bodyLen = 0, rootMounted = false, overflow = -1, heading = "";
      try {
        await page.goto(BASE + route.path, { waitUntil: "networkidle", timeout: 30_000 });
        await page.waitForTimeout(1800);
        bodyLen = ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().length;
        rootMounted = (await page.locator("#root > *").count().catch(() => 0)) > 0;
        overflow = await page.evaluate(() => {
          const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document;
          return d.documentElement.scrollWidth - d.documentElement.clientWidth;
        }).catch(() => -1);
        heading = (await page.locator("h1, h2").first().innerText().catch(() => "")).slice(0, 50);
      } catch (e) {
        pageErrors.push(`nav: ${String(e).slice(0, 120)}`);
      }

      await page.screenshot({ path: join(OUT, `${route.name}-${vp.name}.png`), fullPage: false }).catch(() => {});
      page.off("console", onConsole);
      page.off("pageerror", onPageErr);

      const pass = rootMounted && bodyLen > 20 && overflow <= 2 && consoleErrors.length === 0 && pageErrors.length === 0;
      if (!pass) anyFail = true;
      results.push({
        tab: route.name, viewport: vp.name, pass,
        rootMounted, bodyChars: bodyLen, overflowPx: overflow, heading,
        consoleErrors: consoleErrors.slice(0, 4), pageErrors: pageErrors.slice(0, 4),
        loggedIn,
      });
    }
    await ctx.close();
  }

  await browser.close();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ base: BASE, anyFail, results }, null, 2));
  if (anyFail) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exit(1); });
