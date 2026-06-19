# Releasing

Releases are **version-driven and fully automated**. You never create a tag, a GitHub
Release, or a deploy by hand — you bump one number and merge.

## The single source of truth

`package.json` `version` is the only place a version lives. The git tag is always
`v<version>` (e.g. `version: 1.2.0` → tag `v1.2.0`). Use [semver](https://semver.org):

- **patch** (`1.0.0 → 1.0.1`) — bug fixes, no behavior change.
- **minor** (`1.0.0 → 1.1.0`) — backwards-compatible features.
- **major** (`1.0.0 → 2.0.0`) — breaking changes to config, the wire protocol, or the
  plugin/skill contract.

## Cutting a release

1. Open a PR that bumps `version` in `package.json` (alongside whatever changes ship).
2. Get it green and merge to `main`.
3. That's it. On the push to `main`, `release.yml` automatically:
   - runs the full gate (lint, typecheck, test, build),
   - rebuilds and commits the canonical bundle (`dist/daemon/mcp-server.js`) if it changed,
   - sees the new `version` has no `v<version>` tag yet, so it **creates the tag + a GitHub
     Release** (notes auto-generated from merged PRs/commits), and
   - **deploys the Cloudflare bridge** by calling the `deploy-worker` workflow.

If you merge to `main` **without** bumping `version`, no release is cut — `release.yml` just
refreshes the committed bundle. So routine merges are safe; only a version bump ships.

## What runs when (CI/CD map)

| Workflow             | Trigger                          | Does                                                            |
| -------------------- | -------------------------------- | -------------------------------------------------------------- |
| `ci.yml`             | every pull request               | lint · typecheck · test · build (the gate)                     |
| `release.yml`        | push to `main`                   | gate → refresh bundle → if version is new: tag + Release + deploy |
| `deploy-worker.yml`  | called by `release.yml`, or manual `workflow_dispatch` | deploy the Cloudflare bridge (`worker/`)      |

### Why this shape

- **No hand-tagging** keeps versions and tags consistent — the tag can't drift from
  `package.json`, and you can't forget to deploy.
- The release **calls** `deploy-worker` as a reusable workflow rather than relying on a
  tag-push trigger, because a tag pushed by the built-in `GITHUB_TOKEN` does **not** start a
  new tag-triggered run. Calling it directly sidesteps that and needs no personal access token.
- The bundle commit is marked `[skip ci]` so the bot's own commit doesn't loop the pipeline.

## Manual / out-of-band actions

- **Redeploy the bridge** without a version bump (e.g. a Cloudflare config change): run the
  **deploy-worker** workflow from the Actions tab (`workflow_dispatch`).
- **Re-cut a release** at the same version: delete the `v<version>` tag and its GitHub
  Release, then re-run `release.yml` (or push an empty commit to `main`). Prefer bumping the
  version instead — re-releasing the same version is rarely what you want.

## One-time setup (already done for this repo)

- Repo secrets `CLOUDFLARE_API_TOKEN` (Workers + Durable Objects edit) and
  `CLOUDFLARE_ACCOUNT_ID` — used by `deploy-worker.yml`.
- Actions must be allowed to write to the repo (Settings → Actions → Workflow permissions →
  *Read and write*), so `release.yml` can push the bundle commit and create tags/Releases.
