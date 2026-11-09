# Finish a local visual edit

The project setup screen links to **Import a complete visual edit**. Create a project with the finished song, then import an H.264 MP4 or VP8/VP9 WebM covering its full duration (up to five minutes and the configured media upload limit). Choose 720p or 1080p delivery. The app decodes both inputs, measures soundtrack samples, stores the imported edit, and initializes a non-destructive refinement copy. The uploaded song remains the audio master; audio in the visual edit is ignored at export.

Review the refinement, complete and lock it, prepare the render manifest, then render and download the verified MP4. Optional AI planning steps remain untouched. Imported media records retain their checksum and original filename with `origin: import` and no generation job. The first cut explicitly identifies its imported origin instead of claiming generated planning or automatic compilation.

Imports require project membership and a current wizard revision. Existing timelines, locked exports, and active jobs prevent assembly replacement. Storage is cleaned up on transaction failure. Revision claiming and timeline creation occur in one serializable transaction. The existing final-master renderer checks every decoded frame, soundtrack duration, geometry and codecs before making the download available. FFmpeg runs with bounded decode/filter/encode threads for small Render instances.

Validation: `e2e/assembly.spec.ts` exercises authenticated browser upload, preservation of optional planning status, repeat-import rejection, refinement locking, durable rendering and verified delivery with providers disabled. Existing render acceptance covers 13 real FFmpeg cases, fractional frame rates, long audio, corrupt inputs and cancellation.
