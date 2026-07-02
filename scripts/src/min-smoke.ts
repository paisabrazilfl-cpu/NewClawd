import { chromium, type ConsoleMessage } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Smoke test for the dashboard minimize buttons: sign in, open /swarm, click the
// canvas + panel minimize buttons, and confirm each collapses (and the SwarmCanvas
// unmounts when the canvas is minimized). Captures console errors + screenshots.
const BASE = (process.env["BASE_URL"] ?? "http://localhost:3001").replace(/\/$/, "");
const PWD = process.env["OPERATOR_PASSWORD"] ?? "test-password";
const OUT = join(process.cwd(), ".self-test", "min");
mkdirSync(OUT, { recursive: true });

async function run() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.locator('input[type="password"]').fill(PWD);
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(2500);
  await page.goto(BASE + "/swarm", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  const out: Record<string, unknown> = {};
  // Buttons present?
  const canvasBtn = page.locator('button[aria-label="Minimize swarm canvas"]');
  const panelBtn = page.locator('button[aria-label="Minimize panel"]');
  out["canvasBtnPresent"] = (await canvasBtn.count()) > 0;
  out["panelBtnPresent"] = (await panelBtn.count()) > 0;
  out["canvasMountedBefore"] = (await page.locator('[data-testid^="canvas-node-"]').count()) > 0;
  await page.screenshot({ path: join(OUT, "1-before.png") });

  // Minimize the canvas → its orbs should unmount, button flips to "Expand".
  if (out["canvasBtnPresent"]) {
    await canvasBtn.click();
    await page.waitForTimeout(700);
    out["canvasMountedAfterMin"] = (await page.locator('[data-testid^="canvas-node-"]').count()) > 0;
    out["canvasExpandBtnNow"] = (await page.locator('button[aria-label="Expand swarm canvas"]').count()) > 0;
    await page.screenshot({ path: join(OUT, "2-canvas-min.png") });
  }
  // Minimize the bottom panel too.
  if (out["panelBtnPresent"]) {
    await panelBtn.click();
    await page.waitForTimeout(600);
    out["panelExpandBtnNow"] = (await page.locator('button[aria-label="Expand panel"]').count()) > 0;
    await page.screenshot({ path: join(OUT, "3-panel-min.png") });
  }
  // Restore both.
  await page.locator('button[aria-label="Expand swarm canvas"]').click().catch(() => {});
  await page.waitForTimeout(500);
  out["canvasMountedAfterRestore"] = (await page.locator('[data-testid^="canvas-node-"]').count()) > 0;
  await page.screenshot({ path: join(OUT, "4-restored.png") });

  const overflow = await page.evaluate(() => {
    const d = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document;
    return d.documentElement.scrollWidth - d.documentElement.clientWidth;
  }).catch(() => -1);

  const pass = out["canvasBtnPresent"] === true && out["panelBtnPresent"] === true
    && out["canvasMountedBefore"] === true && out["canvasMountedAfterMin"] === false
    && out["canvasExpandBtnNow"] === true && out["panelExpandBtnNow"] === true
    && out["canvasMountedAfterRestore"] === true
    && errors.length === 0 && overflow <= 2;

  await browser.close();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ pass, overflowPx: overflow, errors, checks: out }, null, 2));
  if (!pass) process.exitCode = 1;
}
run().catch((e) => { console.error(e); process.exit(1); });
