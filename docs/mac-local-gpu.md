> **Archived operator workflow.** The wizard now provides browser GPU generation in its Narrative studio. This separate native runtime is optional and is not needed for the web app. Its 80 GB disk-space estimate applies only to the older Python/ComfyUI installation.

# Run video generation on an M2 Max Mac

This setup targets the owner's Apple M2 Max MacBook Pro, 64 GB unified memory, macOS 26.6.1. It runs ComfyUI with the community LTX-2.3 MLX nodes on Apple's Metal GPU. It uses local open-weight inference: no Comfy Cloud subscription, no five-run quota, and no generation API credits. Electricity, internet and storage are still yours. Actual Mac inference must pass the local test before claiming the worker is ready.

The starter graph uses the quantized Q4 model and distilled sampler at 1024×576, 24 fps. This exact 16:9 resolution is compatible with the model's spatial alignment. Frame counts are padded to 8n+1 and trimmed in the editor. The Mac test starts with a one-second clip; do not queue a full film until that works and runtime is measured. This is an Apple-specific MLX path, not a CUDA/FP8 workflow intended for NVIDIA cards. The custom nodes are community-maintained and currently labeled alpha by their author.

## Install once

The previous 80 GB disk-space check was conservative headroom, not a measured minimum, and has been removed. This optional native runtime still needs disk space for its dependencies, model downloads, caches and outputs. The Q4 transformer alone is approximately 12 GB; encoders and dependencies add more. Weights download when the first generation runs. Keep the Mac plugged in.

On the Mac, open Terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Galinsky-Arts/Music_Video_Wizard/main/scripts/mac-gpu/setup.sh -o /tmp/mvw-gpu-setup.sh
bash /tmp/mvw-gpu-setup.sh
```

Review [the installer](../scripts/mac-gpu/setup.sh) before running it. It installs into `~/Library/Application Support/Music Video Wizard GPU`, with an isolated Python environment and its own model cache. It does not use sudo, change system Python, buy credits or start a generation. ComfyUI, the MLX node pack, the MLX pipeline source, uv and cloudflared are pinned; distributed executable archives are checked against recorded SHA-256 digests. The helper pins one immutable wizard commit for its runtime files, so a changing branch cannot mix versions during installation.

The first invocation downloads software. If a package cannot be installed or Metal is unavailable, it stops and reports the error. It does not claim a successful GPU setup merely because downloads completed.

## Start locally and test

```bash
bash "$HOME/Library/Application Support/Music Video Wizard GPU/start.sh"
```

This starts ComfyUI on loopback port 8288 and a private-token gateway on loopback port 8289. No public tunnel runs by default. It refuses to reuse occupied ports and stops only its own child processes on Ctrl+C. Keep this Terminal open and the laptop lid open; `caffeinate` keeps the worker awake while running.

In a second Terminal, run:

```bash
"$HOME/Library/Application Support/Music Video Wizard GPU/venv/bin/python" \
  "$HOME/Library/Application Support/Music Video Wizard GPU/smoke.py"
```

The test verifies the MLX nodes exist, submits one local crystal-in-space generation, polls the real ComfyUI task and reports the MP4 path. It never calls a hosted inference service. First-use model downloads can take time. Play the output and report the elapsed time before producing the whole story. Logs are under the setup folder's `logs` directory. No GPU run has been performed from the cloud coding workspace; Linux protocol tests are separate from this Mac acceptance.

## Generate the complete narrative locally

After the one-second test works, leave the first Terminal running. In the second Terminal, generate one story shot for review:

```bash
"$HOME/Library/Application Support/Music Video Wizard GPU/venv/bin/python" \
  "$HOME/Library/Application Support/Music Video Wizard GPU/story.py" --limit 1
```

A Mac file chooser asks for the original Controlled Chaos audio file. The script checks its decoded duration against the timed plan. It then generates the first missing story shot using local **text-to-video**, so this route needs no paid image keyframes either. Play that clip before generating the whole film.

Run the same command without `--limit 1` to continue through all 35 shots. Completed clips are verified, hashed and reused; task IDs are saved for resuming interrupted requests. A different story or audio fingerprint cannot silently reuse an old production. If the ComfyUI server itself restarted and lost a task, the script stops rather than claiming completion; use `--retry-missing` only after confirming the old job is no longer running. Failed jobs require an explicit `--retry-failed` after their cause is fixed. Use `--production-name another-take` to change the story or audio without overwriting earlier takes. Re-running the installer preserves your editable `story.json`.

When all clips are ready, the helper builds a 720p visual edit and combines it with the original song. Cuts use absolute frame boundaries, avoiding accumulated timing drift across 35 shots. The final boundary rounds upward so the visual edit covers the complete decoded soundtrack, including a partial final frame. Output is fully decoded before completion is recorded. The original audio file is never overwritten. Generated clip audio is discarded. Both a watchable `Controlled_Chaos_Music_Video.mp4` and a video-only `Controlled_Chaos_Visual_Edit.mp4` are saved under `productions/controlled-chaos` in the setup folder. The latter is bitrate-bounded to fit the wizard's default import limit; use it with the original song in the web app's complete-assembly import.

This batch can take hours on a laptop. The first measured clip establishes a useful estimate. No full Mac film has been rendered from the coding workspace, and the software does not claim real footage until the local jobs succeed and their outputs pass verification.

## Connect the website after the test passes

Stop the first Terminal with Ctrl+C, then run:

```bash
MVW_GPU_TUNNEL=1 bash "$HOME/Library/Application Support/Music Video Wizard GPU/start.sh"
```

This explicitly starts a free **Cloudflare Quick Tunnel** between Render and the Mac's authenticated gateway. Prompts, approved first frames and generated clips pass through that tunnel. The ComfyUI interface and administrative routes remain inaccessible through it. Only authenticated `/prompt`, `/upload/image`, per-task `/history/:id` and validated output `/view` requests are exposed. Requests and responses have size limits; the gateway does not forward its token to ComfyUI, follow redirects or accept arbitrary upstream addresses.

The command prints a temporary HTTPS connection URL, which is safe to send in chat. It does **not** print the private GPU token. Copy the token with the command it prints and paste it directly into Render's private Environment settings as `COMFYUI_API_KEY`. Do not send the token in chat.

After the connection has been verified, configure the existing Render service:

```dotenv
VIDEO_GENERATION_PROVIDER=comfyui
COMFYUI_BASE_URL=https://the-printed-name.trycloudflare.com
COMFYUI_API_KEY=the-private-gpu-token
COMFYUI_WORKFLOW_PATH=/app/config/comfyui-mac-mlx.json
```

Do not select the provider before the worker passes its local test. The temporary URL changes when a new tunnel is started; update the Render URL then. Keep the worker running while jobs use it. Stopping the Mac stops generation; it does not delete the original finished music video.

The shipped Render-connected production graph is image-to-video and needs approved first frames. The separate local narrative batch uses text-to-video and needs no Stability credits. Stability is an optional source of those frames, charged against its own credits when explicitly enabled. The local text-to-video smoke test needs no Stability key.

## Evidence and upstream sources

Gateway transport/access tests run on Linux using a synthetic local HTTP server. They verify authorization, route allowlisting, credential isolation, output path checks, transfer bounds and redirect rejection. Shell syntax and workflow-schema checks also run in CI. They do not substitute for the Mac's real GPU test.

- [Apple-specific MLX ComfyUI nodes](https://github.com/tanis2000/comfyui-ltx2-mlx)
- [MLX video pipeline](https://github.com/dgrauet/ltx-2-mlx)
- [ComfyUI](https://github.com/Comfy-Org/ComfyUI)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
