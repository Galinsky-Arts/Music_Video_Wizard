# Durable FFmpeg final-master renderer

PR 41 turns the prepared Finish & Export manifest into a durable final-master render job.

## Queue boundary

Rendering is allowed only when:

- Refinement remains locked;
- the current render manifest still matches the locked source timeline and ProjectVersion delivery settings;
- the Finish & Export step has already prepared that exact manifest;
- no other final-master render job is active.

The durable `RENDER` GenerationJob records the exact timeline node, audio-master node, and every clip node as inputs.

## Storage streaming

AssetStorage now supports immutable file-based uploads in addition to in-memory byte uploads.

- Local storage copies the completed file with exclusive-create semantics.
- S3 storage streams the file through `PutObject` with an explicit content length.

The final master therefore does not need to be loaded into Node memory.

## Isolated render workspace

Each render attempt receives a unique temporary directory.

The worker materializes only the exact manifest sources into that directory, renders the master there, verifies it, uploads it, and then removes the directory.

FFmpeg is spawned with an argument array rather than a shell command.

## FFmpeg plan

Every source clip is normalized to the ProjectVersion delivery geometry, frame rate, square pixel aspect, and yuv420p.

Each item is trimmed to:

- its exact editorial source range;
- plus only the outgoing transition tail required by the next explicit transition.

Zero-duration edits use hard concatenation.

Non-zero transitions use FFmpeg `xfade` beginning at the exact locked editorial cut boundary. Common timeline transition kinds map to compatible FFmpeg transitions without changing the stored editorial timeline.

The immutable audio master is trimmed from zero to the manifest duration and encoded separately.

The initial delivery master is:

- MP4;
- H.264 / libx264;
- CRF 18;
- medium preset;
- yuv420p;
- project frame rate;
- AAC 320 kbps;
- fast-start enabled.

## Verification

A successful encode is followed by a second FFmpeg pass that demuxes the complete output and requires both video and audio streams.

The worker also requires a non-empty output file and computes SHA-256 over the completed master before persistence.

## Retry and crash behavior

The GenerationJob UUID is the Render Master AssetVersion ID and appears in its deterministic storage key.

If a prior attempt crashed after object upload but before the database transaction committed, a retry removes that orphaned exact storage key before uploading the newly verified render.

If a durable generation output already exists, the handler reuses it and does not render again.

## Versioned master asset

All successful masters belong to one logical `RENDER_MASTER` asset.

Every render creates a later immutable AssetVersion containing:

- storage key;
- byte size;
- SHA-256;
- width and height;
- duration;
- frame rate;
- exact manifest fingerprint;
- exact Refinement TimelineVersion/node;
- exact audio-master version;
- GenerationJob ID;
- render delivery settings.

The render node records `RENDERED_FROM` dependency edges from the exact timeline, audio master, and every clip node.

## Wizard completion

Persisting the verified master automatically completes Finish & Export using the same manifest fingerprint that was prepared before rendering.

The stage is not silently locked. The review/download UI can inspect the completed master before the final project-stage lock.

## Measured output and browser acceptance

See [final export acceptance](final-export-acceptance.md) for output verification, atomic submission, downloads, and the real media/browser checks.
