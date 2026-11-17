# Music Video Wizard

**Complete original development plan:** [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Music Video Wizard is a production web application for taking a creator from finished music through creative direction, storyboard, generated shots, a fully compiled first cut, iterative refinement, and final render.

## Product rule

The application is built around a **creative specification**, not a pile of generated assets. Approved creative decisions become structured, versioned data that downstream generation and timeline compilation consume.

The audio master is immutable: this application does not edit music.

## Foundation

PR 1 establishes the production application foundation:

- Next.js + React + strict TypeScript
- PostgreSQL boundary through Prisma
- provider-neutral media storage contract
- runtime environment validation
- health endpoint
- Vitest
- CI for type checking, linting, tests, and production build
- local PostgreSQL through Docker Compose

Product-domain models deliberately begin in PR 2 so the domain architecture receives its own review rather than being accidentally frozen inside setup work.

## Local development

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL: `docker compose up -d`.
3. Install dependencies: `npm install`.
4. Generate the Prisma client: `npm run db:generate`.
5. Start the app: `npm run dev`.

## Quality gates

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Every pull request is expected to pass the same commands in CI.

## Architecture rules

- Product code must not bind directly to a specific image/video generation provider.
- Product code must not bind directly to a specific object-storage SDK.
- Persisted creative decisions and derived assets must retain provenance and version identity.
- Downstream invalidation/recompilation must be dependency-aware.
- The automatic first cut is a core product capability, not a manual editing shortcut.
- Temporary mocks must never silently masquerade as completed production capability.

## Final delivery verification

Run `npm run test:render` for real FFmpeg/FFprobe delivery checks and `npm run test:e2e` for browser acceptance. The browser suite requires migrated PostgreSQL, local asset storage, Chromium, FFmpeg and FFprobe. See [final export acceptance](docs/final-export-acceptance.md) for what these checks prove and the live-provider acceptance still required.

Creators can also [import their own frames and clips](docs/media-imports.md) without paid generation providers. Current Galinsky Arts infrastructure is recorded in [live deployment](docs/live-deployment.md).

## Release status (2026-11-17)

- Development plan PRs 1–23 (the first-release path: music map through final
  render, package export/restore, usage and operator controls) are implemented;
  see `registry/prs.json` and `docs/`.
- PR 24 collaboration is implemented: project sharing with editor/reviewer/
  viewer roles, single-use expiring invite links, timecoded threaded comments on
  shots and cuts, approval requests with optimistic-concurrency conflict
  handling, and access expiry. See [collaboration](docs/collaboration.md).
  Invites are copied links; no email is sent.
- PR 26 (no-provider parts) is implemented: alternate-format renders of the
  locked edit (vertical 9:16, square 1:1, portrait 4:5, 1080p high quality,
  720p web) using each shot's crop/reframe focus or letterbox, through the same
  verified FFmpeg queue (one render at a time for the 512 MB limit); and
  editing interchange export (FCPXML 1.9, CMX3600 EDL, media manifest with
  24-hour download links). Files are validated structurally in tests and the
  browser E2E; an actual import into Final Cut/Resolve/Premiere has not been
  demonstrated yet, so transitions export as cuts with notes. See
  [delivery](docs/delivery-and-performance.md).
- PR 25: free local beat-synced cut and dance 8-count markers from Music
  Analysis (on screen and CSV). Lip-sync/choreography generation has a
  provider-neutral adapter that is OFF until `PERFORMANCE_SYNC_PROVIDER`,
  `PERFORMANCE_SYNC_API_BASE` and `PERFORMANCE_SYNC_API_KEY` are set; no
  provider is integrated or validated.
- Live AI generation needs provider keys (see
  [generation provider strategy](docs/generation-provider-strategy.md)); without
  them, creators import their own frames and clips.
