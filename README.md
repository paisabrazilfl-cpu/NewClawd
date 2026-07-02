# BOS-AURA / OPENCLAW OMEGA

A pnpm workspace monorepo running an Express API server (`@workspace/api-server`) and a frontend (`@workspace/openclaw`).

## Production

- **Render service:** https://bos-aura.onrender.com
- **Health check:** `GET /healthz` (also `GET /api/healthz`)
- **Render blueprint:** `render.yaml` (no managed database — `DATABASE_URL` set directly on the service)
- **Deployment flow:** GitHub Actions → builds `artifacts/api-server/dist/index.mjs` → commits dist → triggers Render deploy

## Quick start

Requires `pnpm` and Node >= 24 (project runs on Render; sandbox here uses Node 20 with warnings).

```bash
pnpm install
pnpm --filter @workspace/api-server run build
```

To start the API locally you need a valid `DATABASE_URL` and the secrets listed in `.env.example`. The Render service is configured via `render.yaml` and expects the prebuilt `dist`.

## Workspace layout

```
artifacts/api-server   API server (Express + esbuild bundle)
artifacts/openclaw     Frontend app
lib/*                  Shared workspace libraries
scripts                Dev/CI scripts and self-test harness
```

## Verification commands

```bash
pnpm run typecheck            # Full workspace typecheck
pnpm --filter @workspace/api-server run build   # API bundle
pnpm run test                 # Workspace tests
pnpm --filter @workspace/scripts run self-test  # CI-style self-test
```

## Secrets policy

Never commit secrets. See `.env.example` for required keys. Production secrets are set directly in the Render dashboard or in the in-app vault. `SESSION_SECRET` is auto-generated once by Render and must never be regenerated, or stored vault entries become unreadable.

## Current deployment status

- **Merged workspace:** `bos-aura-mvp-fixes-2026-06-17-1.zip` applied to `/home/user/webapp` on 2026-07-02.
- **API build:** `artifacts/api-server/dist/index.mjs` (5.2 MB) generated successfully.
- **Next:** branch committed and pushed to GitHub, then Render deploy triggered via the `rnd_` key.

## Branch policy

Create dated branches per change: `YYYY-MM-DD/short-summary`. This deployment work is tracked on branch `2026-07-02/render-deploy-from-zip`.
