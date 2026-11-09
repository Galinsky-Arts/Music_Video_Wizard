# Import frames and video clips

Creators can import PNG/JPEG/WebP initial frames and H.264 MP4 or VP8/VP9 WebM video takes from the shot cards. No generation provider or provider charge is involved. Each upload creates a new immutable version with `origin: import`, the original filename, a checksum, measured dimensions/timing, and exact creative-source references. Imported media never receives a fabricated GenerationJob.

The existing pipeline asset categories hold both generated and imported candidates. The UI identifies their origin. Imported clips pin the approved initial frame and locked shot specification and must cover the planned editorial duration. Older media remains available in history; a changed upstream frame identifies downstream work for review.

Both stages must be unlocked and their prerequisites locked. Authorization and the expected wizard revision are checked before native inspection and again in the persistence transaction. Concurrent/stale imports fail without overwriting media. Active generation jobs block imports to the same stage.

Uploads are bounded while reading multipart bytes, checked by file signatures, inspected with FFprobe and fully decoded with FFmpeg. File names and MIME declarations are not trusted. Network protocols are disabled for inspection/decoding; native subprocesses have timeouts. Dimensions are limited to 8192 pixels per side, clips to five minutes and 120 fps, and the default upload limit is 50 MiB (`MAX_MEDIA_UPLOAD_BYTES`). The app serves only READY candidates.

`e2e/media-import.spec.ts` exercises the browser workflow with all paid providers disabled, verifies imported provenance and measured video duration, and checks locked-stage rejection. `src/lib/media-imports/probe.test.ts` covers file signatures and chunked multipart size bounds.
