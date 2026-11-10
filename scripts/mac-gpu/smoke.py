#!/usr/bin/env python3
"""User-run, local-only MLX acceptance. It spends no hosted-generation credits."""
import json
import time
import urllib.request
from pathlib import Path
BASE = "http://127.0.0.1:8288"
def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.load(r)
graph = {
    "1": {"class_type":"LTX2MLXModelLoader", "inputs":{"model_dir":"dgrauet/ltx-2.3-mlx-q4", "pipeline_type":"distilled", "low_ram":False, "custom_model_dir":""}},
    "3": {"class_type":"LTX2MLXGenerate", "inputs":{"pipeline":["1",0], "prompt":"A luminous crystal floating in deep space, slowly rotating. Cinematic illustrated science fiction, coherent shape, subtle motion, fixed camera, no text.", "width":1024, "height":576, "num_frames":25, "seed":42, "cfg_scale":3.0, "frame_rate":24.0, "filename_prefix":"music-video-wizard/local-test"}}
}
info = get("/object_info")
for name in ("LTX2MLXModelLoader", "LTX2MLXGenerate"):
    if name not in info:
        raise SystemExit("Missing MLX node: " + name + ". Inspect the local ComfyUI log.")
request = urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt":graph}).encode(), headers={"Content-Type":"application/json"}, method="POST")
with urllib.request.urlopen(request, timeout=60) as response:
    submitted = json.load(response)
if submitted.get("node_errors") or not submitted.get("prompt_id"):
    raise SystemExit("ComfyUI rejected the workflow: " + json.dumps(submitted.get("node_errors", {})))
prompt_id = submitted["prompt_id"]
print("Local GPU test queued. First use downloads model weights; keep the Mac plugged in. No API credits are used.",flush=True)
start = time.monotonic()
while time.monotonic() - start < 7200:
    task = get("/history/" + prompt_id).get(prompt_id)
    if task and task.get("status",{}).get("status_str") == "error":
        raise SystemExit("GPU test failed. Inspect logs/comfyui.log; no successful inference is claimed.")
    if task and task.get("status",{}).get("completed"):
        entries = task.get("outputs",{}).get("3",{}).get("images",[])
        movies = [e for e in entries if e.get("filename","").endswith(".mp4")]
        if not movies:
            raise SystemExit("Workflow completed without an MP4.")
        root = Path(__file__).resolve().parent
        path = root / "ComfyUI" / "output" / movies[0].get("subfolder","") / movies[0]["filename"]
        print("Local AI video created:",path,flush=True)
        print("Elapsed seconds:",round(time.monotonic()-start),flush=True)
        print("Play the MP4, then report whether it looks correct. This is the hardware acceptance step.",flush=True)
        break
    time.sleep(10)
else:
    raise SystemExit("Test timed out. Inspect the local log before retrying.")
