# Delivery formats, editor interchange and performance tools

Page: `/app/projects/:id/delivery` (editors and owners). Requires a locked
Refinement timeline.

## Alternate formats (plan PR 26)

`src/lib/delivery/presets.ts` derives a variant manifest from the current
locked render manifest: same edit, music and titles; new output size and CRF.
Presets: vertical 1080×1920, square 1080×1080, portrait 1080×1350, landscape
1080p (CRF 17) and 720p web (CRF 24). "Reframe" crops each shot using its
Refinement crop/reframe focus (per-shot horizontal focus can be overridden);
"Letterbox" fits the whole frame. Renders reuse the master pipeline
(`handleDeliveryVariantRender`): FFmpeg with one thread, verified dimensions,
frame count and audio, stored as `DELIVERY_VARIANT` assets with lineage edges.
Only one render runs per project at a time.

## Interchange (plan PR 26)

`GET /api/projects/:id/interchange?format=fcpxml|edl|manifest`:

- FCPXML 1.9: one spine asset-clip per shot with frame-accurate rational
  times (NTSC rates use 1001-based durations), the music master as a connected
  clip on lane −1, media referenced as `media/<file>`.
- CMX3600 EDL: NDF timecode from 01:00:00:00, one V event per shot (reel
  `S0001`…) with `FROM CLIP NAME`, plus an AA event for the music.
- Media manifest (JSON): every referenced file with path, checksum, duration
  and a 24-hour signed download link.

Transitions are exported as cuts with a note/comment. Structural validity is
tested (`src/lib/delivery/interchange.test.ts`, `e2e/final-export.spec.ts`);
import into a real editor has not yet been demonstrated, so interoperability
is not advertised beyond that.

## Beat-synced cut and choreography markers (plan PR 25, local)

`src/lib/performance/beat-markers.ts` turns Music Analysis beats, 4/4 bar
candidates, sections and drops into cut markers on a chosen grid (beat … 4
bars, with a minimum shot length; section boundaries and drops always cut) and
dance 8-counts. View on the page or download CSV.

## Lip-sync / performance sync (plan PR 25, provider)

`src/lib/performance/providers.ts` is a provider-neutral adapter that is OFF
until `PERFORMANCE_SYNC_PROVIDER`, `PERFORMANCE_SYNC_API_BASE` (https) and
`PERFORMANCE_SYNC_API_KEY` are set. Its neutral contract must be mapped to the
chosen provider's documented API; results return through Media Import. No
provider has been integrated or demonstrated.
