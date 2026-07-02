# AI_NOTES — 2026-07-02 Render deployment

## What was done

1. Merged the uploaded `bos-aura-mvp-fixes-2026-06-17-1.zip` workspace into `/home/user/webapp`, preserving the existing `.git` directory.
2. Ran `pnpm install --frozen-lockfile` under the sandbox's Node v20.20.2 (workspace requires Node >=24). Install completed with a single engine warning.
3. Ran `pnpm --filter @workspace/api-server run build` successfully. Produced:
   - `artifacts/api-server/dist/index.mjs` (5.2 MB)
   - `dist/pino-worker.mjs`, `dist/pino-file.mjs`, `dist/pino-pretty.mjs`, `dist/thread-stream-worker.mjs`
   - Linked source maps
4. Wrote/updated project docs:
   - `README.md` — project overview, production URL, verification commands, deployment status
   - `CHANGELOG.md` — added `2026-07-02/render-deploy-from-zip` section
   - This `AI_NOTES.md` file

## Render configuration

- Service name: `bos-aura`
- Runtime: node
- Plan: free
- Region: oregon
- Branch: main
- Build command: `echo dist is prebuilt` (because GitHub Actions commits the built dist)
- Start command: `node artifacts/api-server/dist/index.mjs`
- Health check path: `/health` (in `render.yaml`); the app also exposes `/healthz` and `/api/healthz`
- Key env vars: `SESSION_SECRET`, `DATABASE_URL`, `OPERATOR_PASSWORD`, `OPENCLAW_API_KEY`, `RELAY_API_KEY`, `NVIDIA_API_KEY`, `STEEL_API_KEY`, `FIRECRAWL_API_KEY`
- Database: standalone paid `openclaw-db` referenced by `DATABASE_URL` set directly on the service (no blueprint DB).

## Deployment plan

1. ✅ Commit the merged workspace + docs + built dist to branch `2026-07-02/render-deploy-from-zip`.
2. ✅ Create GitHub repo `paisabrazilfl-cpu/NewClawd` using the provided GitHub PAT.
3. ✅ Add `GET /health` in `artifacts/api-server/src/app.ts` to match `render.yaml` healthCheckPath; rebuild api-server dist.
4. Push branch to `https://github.com/paisabrazilfl-cpu/NewClawd.git`.
5. Create Render web service `bos-aura` linked to the repo using the provided Render API token.
6. Trigger manual deploy from Render dashboard/API.
7. Verify service responds at `https://bos-aura.onrender.com/health` and `/healthz` with `{ status: "ok" }`.
8. Run Playwright E2E smoke tests.

## Known issues / warnings

- Sandbox Node v20.20.2 does not satisfy the `>=24.0.0` engine requirement. The build still succeeded, but production runtime is Render's Node environment.
- Wrong Cloudflare worker deployment was submitted for deletion via `gsk hosted worker_delete` and is pending approval (`pending_action_id: 2d336f0b-037a-4cda-9624-ceb117fbafd1`).
- GitHub push will use the token directly in the remote URL (no sandbox auth setup needed).
