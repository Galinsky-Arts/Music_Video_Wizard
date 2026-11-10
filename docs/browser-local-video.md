# Browser-local narrative video implementation

The existing authenticated Narrative studio contains the generator. It needs no
native helper, installer, tunnel, cloud GPU, or provider key. No model request runs
on page load. The user initiates generation after seeing the model's download size.

FastWan 2.2 TI2V-5B's browser ONNX export is pinned to revision
`be5c3e118918b31a600c2e055f33050f904689b1`. Its manifest contains exact byte counts
and SHA-256 checksums (about 11.5 decimal GB total). A streamed size limit and complete
checksum verification precede each cache write. Completed files survive retries;
partial files do not. Cache controls remove only this app's model namespace.

Prompt embedding, three text-encoder stages, denoising, and video decoding each run
in a separate worker, releasing GPU allocations between stages. Inference uses
WebGPU with shader-f16; the UI checks support before enabling generation. The
worker's real inference follows the upstream Jean implementation with its MIT
notice retained. Models download directly from Hugging Face without credentials;
prompts remain on the device. Provider credentials never enter browser bundles.

Generated H.264 takes are checkpointed in IndexedDB under project, audio-version,
story-content, and model-revision keys. Web Locks prevent competing tabs from using
the GPU or deleting active caches. Cancellation terminates the current worker;
completed takes remain. Story/audio changes cannot reuse mismatched takes.

Movie assembly uses WebCodecs and Mediabunny. An in-browser WASM AAC encoder handles
browsers without native AAC encoding. Each five-second take is explicitly retimed
to its planned shot length; a single 24 fps frame grid covers the whole song without
accumulating rounding errors. The original decoded soundtrack is neither stretched
nor looped. The authenticated same-origin audio route checks workspace membership,
the current exact audio version, READY status, and a 50 MB input bound. It does not
publish the original audio or relax bucket CORS. Existing locked edits stay intact.

Local results are previewed and downloaded as MP4. They do not manufacture server
generation jobs, READY assets, wizard completion, or provider acceptance evidence.
The exported narrative and the finished video remain distinct artifacts.

Verification covers model manifest and tensor layout contracts, rejected corrupt
downloads, frame-grid timing, endpoint ownership and audio immutability, and real
browser H.264/AAC assembly and full FFmpeg decoding using synthetic inference clips.
The browser test deliberately mocks AI inference to avoid downloading 11.5 GB in CI.
The cloud test environment does not provide a shader-f16 hardware GPU. Full-model
generation and timing on the user's M2 Max therefore remain runtime acceptance,
not claimed test results. Identity continuity between independently generated shots
is guided by prompts and is not guaranteed.
