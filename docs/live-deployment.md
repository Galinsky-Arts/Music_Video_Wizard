# Galinsky Arts deployment

The Music Video Wizard was deployed on November 9, 2026, using directly managed Render configuration and a separate Neon project.

- Web: https://music-video-wizard-galinsky-arts.onrender.com
- Render service: `srv-dbp4p27f3r2c73f2mjfg`, Virginia, free plan.
- Neon project: `quiet-mud-27176927`, AWS us-east-1.
- Production branch: `br-solitary-lake-bb1adzzp`.
- Private media bucket: `music-video-wizard-media`.

All twelve Prisma migrations applied at startup. `/api/ready` returned configuration and database checks `ok`.

The approved deployment uses the existing authenticated bounded-drain route in the same Render service. `JOB_EXECUTOR_URL` points to the web origin. On-demand enqueue wakes this route with a private server-only secret; no separate executor service was created. The reference two-service `render.yaml` is not managing these directly created resources and must be reconciled deliberately before using a Blueprint. No scheduled Neon recovery function has been provisioned.

Database credentials, scoped storage credentials and generated authentication/job secrets are private Render environment variables. They are not stored here. Text/image/video providers are disabled to honor free/local-only generation. Local analysis, imported media, assembly and FFmpeg rendering do not require paid provider APIs.

The readiness workflow defaults to the deployed web origin and still allows `MVW_PRODUCTION_URL` to override it. This source configuration is used because the GitHub connector cannot set repository Actions variables (HTTP 403). Private media storage passed a signed write/read/delete round trip.

Live paid-provider acceptance and a finished video for the user's soundtrack are separate from infrastructure readiness. Do not mark them complete from this document.
