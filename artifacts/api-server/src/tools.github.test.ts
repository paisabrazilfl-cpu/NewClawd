/**
 * github_create_repo + github_commit_file hardening.
 *
 * Diagnosed from a real swarm loop where the model could WRITE three.js code but
 * failed the tool MECHANICS: it passed an invalid repo name ("Big blue"), a
 * placeholder owner ("operator"), or empty args, and never created the repo. These
 * tests prove the tools now self-correct instead of looping:
 *   - github_create_repo normalizes a spaced name and creates under the auth user
 *   - github_create_repo rejects an empty name with guidance
 *   - github_commit_file rejects a bare shell command passed as a "file"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOOL_REGISTRY } from "./tools";

const ctx = { agentId: 5, agentName: "FORGE" } as never;

describe("github_create_repo", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token_not_real");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects an empty name with actionable guidance", async () => {
    const r = (await TOOL_REGISTRY.github_create_repo!.run({ name: "   " }, ctx)) as string;
    expect(r).toMatch(/name is required/i);
  });

  it("normalizes a spaced name and creates the repo under the authenticated user", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === "https://api.github.com/user") {
        return { ok: true, status: 200, json: async () => ({ login: "paisabrazilfl-cpu" }) } as Response;
      }
      if (url === "https://api.github.com/user/repos") {
        return { ok: true, status: 201, json: async () => ({ full_name: "paisabrazilfl-cpu/Big-blue", html_url: "https://github.com/paisabrazilfl-cpu/Big-blue", default_branch: "main" }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));

    const r = (await TOOL_REGISTRY.github_create_repo!.run({ name: "Big blue" }, ctx)) as string;
    expect(r).toMatch(/created repository paisabrazilfl-cpu\/Big-blue/);
    // The POST body must carry the NORMALIZED name and auto_init.
    const post = calls.find((c) => c.url === "https://api.github.com/user/repos");
    expect(post).toBeTruthy();
    expect((post!.body as { name: string }).name).toBe("Big-blue");
    expect((post!.body as { auto_init: boolean }).auto_init).toBe(true);
  });
});

describe("github_commit_file — content guards", () => {
  beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "ghp_test_token_not_real"));
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("refuses prompt/context scaffolding dumped as file content", async () => {
    // Observed live: a README whose body was the context-injection block.
    const scaffold = 'RECENT CONVERSATION (resolve "that file"/"the brief"/"it" from here):\nOperator: make a repo';
    const r = (await TOOL_REGISTRY.github_commit_file!.run(
      { repo: "swarm-selftest-2026-06-17", path: "README.md", content: scaffold },
      ctx,
    )) as string;
    expect(r).toMatch(/internal prompt\/orchestration scaffolding/i);
  });
});

describe("save_artifact — shell-command guard", () => {
  it("refuses a bare shell command passed as content", async () => {
    // No db mock needed: the guard fires before any storage call.
    const r = (await TOOL_REGISTRY.save_artifact!.run(
      { filename: "game.tar.gz", content: "base64 -w0 /tmp/racing_game.tar.gz" },
      ctx,
    )) as string;
    expect(r).toMatch(/looks like a SHELL COMMAND/i);
  });
});

describe("github_commit_file — desktop-GUI block", () => {
  const ctx = { agentId: 5, agentName: "FORGE" } as never;
  beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "ghp_test_token_not_real"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a pygame/desktop-GUI game file (can't be played from a link)", async () => {
    const r = (await TOOL_REGISTRY.github_commit_file!.run(
      { repo: "racing-game", path: "game.py", content: "import pygame\npygame.init()\nscreen = pygame.display.set_mode((800,600))" },
      ctx,
    )) as string;
    expect(r).toMatch(/browser game|can't run in this swarm|index\.html/i);
  });
});
