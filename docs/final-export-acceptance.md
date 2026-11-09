# Final export acceptance

The final delivery path now checks the actual produced master before marking it READY. It fully decodes the H.264/AAC output and probes its container, stream count, pixel format, dimensions, frame rate, frame count, stream start times, video duration and soundtrack duration. Persisted dimensions and timing come from these measurements, with the measurements retained in render provenance.

`VIDEO_RENDER_FFPROBE` defaults to `ffprobe`; `VIDEO_RENDER_FFMPEG` defaults to `ffmpeg`. Both are supplied by the existing Docker image's FFmpeg package. Production preflight checks both binaries. Failed verification leaves no READY master or completed delivery stage.

Render submission claims the expected wizard revision in the same transaction as the GenerationJob and pg-boss job. A duplicate or stale submission rolls back; changed or locked sources are rechecked at this boundary. Render attempts use distinct storage objects, so a late/recovered attempt cannot overwrite or delete another attempt's persisted master.

MP4 downloads carry a signed Content-Disposition attachment header, including on S3-compatible storage. Playback keeps its separate inline URL. Historical master versions have download links. Local download filenames are bound to the URL signature. Failed status refreshes surface a retry message, and Refresh status lets a creator reconcile an uncertain action before retrying it.

## Repeatable checks

- `npm run test:render` runs real FFmpeg and FFprobe for 12 combinations of hard cuts/dissolves, mixed source sizes/rates, nonzero trims, reused media and 24/23.976/29.97 fps. It additionally verifies a full 180-second soundtrack at 29.97 fps with reused footage and dissolves, and rejects mismatched delivery duration and corrupt media and checks pre-cancelled process handling.
- `npm run test:e2e` includes a synthetic pre-render fixture. The browser prepares the manifest, races two queue submissions, reconnects the durable queue before execution, observes the completed master, downloads and hashes it, locks delivery, reloads it, and checks unauthenticated and other-account access. A handler replay must reuse the persisted master. It uses the real database, queue, storage and FFmpeg handler; it does not mock those boundaries.
- Unit tests reject incorrect output geometry, codecs, pixel format, frame rate, frame count, video/audio timing and missing audio, and verify download signature/header handling.

These tests intentionally use synthetic media and no paid generation requests. They do not establish live OpenAI/Runway acceptance, production storage access, backup restoration, artistic quality, or completion of the entire original development plan. The pre-render browser fixture does not verify the upstream creative planning and paid-provider screens. Those require separate evidence.
