# AI video with your own GPU

The Video Clips stage supports `VIDEO_GENERATION_PROVIDER=comfyui` as well as Runway. ComfyUI executes a real image-to-video graph on an operator-owned GPU. No GPU inference runs on the free Render web instance, and enabling the adapter does not provision hardware or download model weights. A GPU worker and an installed, working video workflow are required before real generations can run.

## Configure a tested workflow

1. Install ComfyUI and an image-to-video model/workflow supported by your GPU, such as a Wan or LTX image-to-video workflow. Generate a short MP4 successfully in ComfyUI first. Model weights and custom nodes must be installed there.
2. Export that working graph using ComfyUI's **Save (API Format)** / **Export (API)** option. Keep the real model-loader names, connections, sampler settings and output node. The adapter deliberately does not invent graph nodes or silently substitute procedural animation.
3. Wrap the exported node dictionary in the configuration below. Set `outputNodeId` to the node producing the MP4. Its history output must expose `gifs` (VideoHelperSuite) , `videos`, or native SaveVideo `images`, with a `.mp4` filename. Non-video image entries are rejected. Keep the workflow file server-side; it is trusted operator configuration, never uploaded executable graph content from app users.
4. Replace the existing input image filename with the exact string `{{FIRST_FRAME}}`, positive prompt with `{{PROMPT}}`, and video length/frame count with `{{FRAME_COUNT}}`. Optional exact-value placeholders: `{{NEGATIVE_PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{FPS}}`, `{{SEED}}`. Values are replaced as typed JSON values, so arbitrary quoted prompt text cannot change the graph.

Configuration structure (the `nodes` field must contain your real exported graph, not the explanatory string shown here):

```json
{
  "modelId": "my-installed-i2v-workflow-v1",
  "width": 768,
  "height": 432,
  "frameRate": 16,
  "frameMultiple": 4,
  "frameOffset": 1,
  "maxDurationMs": 9000,
  "aspectRatio": "16:9",
  "outputNodeId": "42",
  "nodes": "REPLACE WITH YOUR WORKING API GRAPH OBJECT"
}
```

Use your workflow's actual resolution, frame rate, duration limit and frame-count constraint. `frameMultiple=4, frameOffset=1` pads frame counts to 4n+1. The padded generation duration is recorded separately from editorial timing; the edit trims it to the original song. Change `modelId` when changing graph behavior, especially its output node. Preserve a workflow version while its jobs are queued or running.

Render environment fields:

```dotenv
VIDEO_GENERATION_PROVIDER=comfyui
COMFYUI_BASE_URL=https://your-authenticated-gpu-worker.example
COMFYUI_WORKFLOW_PATH=/app/config/my-i2v-workflow.json
COMFYUI_API_KEY=your-private-worker-bearer-token
```

For a wholly local app, `http://127.0.0.1:8188` works without a key. On Render, localhost is the Render container, not your computer. Use a reachable authenticated HTTPS gateway or a private network to your worker. Do not expose an unauthenticated ComfyUI instance publicly. The gateway must support `/upload/image`, `/prompt`, `/history/:id` and `/view`. Keep authentication in private environment variables and never embed it in graph JSON or first-frame URLs.

Approved first frames are uploaded to the worker. Prompt IDs and request graphs are persisted by the existing durable Video Clips handler so retries can resume known tasks. Only the configured output node is read. Output paths are validated, each transfer is time-bounded, generated MP4s are capped at 50 MiB and copied into the app's own storage. The worker token is not included in provider snapshots, returned media URLs or project records. Image-to-video requires approved first frames; importing those frames remains available without an image API key.

Unit tests exercise protocol translation, typed prompt insertion, frame padding, private output retrieval, failure states, invalid paths and transfer bounds. These are transport tests, not proof of a real GPU inference run. Real generation remains pending until a GPU worker is configured and a real first-frame-to-MP4 acceptance run passes.

## Runway alternative

The existing Runway integration remains available with `VIDEO_GENERATION_PROVIDER=runway` and a private `RUNWAY_API_SECRET`. It uses paid credits. Do not enable or dispatch paid generations until the user authorizes the budget. Configuring ComfyUI never falls back to Runway.

Protocol reference: ComfyUI [`SaveVideo`](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_video.py) uses [`PreviewVideo`](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_api/latest/_ui.py), which serializes completed MP4 entries under `images`; VideoHelperSuite uses `gifs`. Both output shapes are covered by adapter tests.
