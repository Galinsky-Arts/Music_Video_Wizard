#!/bin/bash
set -euo pipefail
umask 077
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This helper requires a native Apple-silicon Mac Terminal (macOS arm64).'
  exit 1
fi
TASK_ROOT="${MVW_GPU_HOME:-$HOME/Library/Application Support/Music Video Wizard GPU}"
mkdir -p "$TASK_ROOT/bin" "$TASK_ROOT/cache" "$TASK_ROOT/logs"
FREE_KB="$(df -Pk "$TASK_ROOT" | awk 'NR==2 {print $4}')"
if [[ "$FREE_KB" -lt 83886080 ]]; then
  echo 'Please free at least 80 GB of disk space before installing the local video runtime and model cache.'
  exit 1
fi
SOURCE_COMMIT="${MVW_GPU_SOURCE_COMMIT:-}"
COMFY_COMMIT=61e524bdba7a4e193b45c2697f1af83c1beb86d6
PLUGIN_COMMIT=d38b63abfffc32520cb31dd8b8471ba7bba52991
MLX_COMMIT=747b30ef10e92a011e85b2aa0f6c4ee86ced5218
fetch() { /usr/bin/curl --fail --location --silent --show-error --retry 2 "$1" -o "$2"; }
archive() {
  local url="$1" destination="$2" archive_path="$TASK_ROOT/cache/source.tar.gz"
  if [[ ! -d "$destination" ]]; then
    fetch "$url" "$archive_path"
    local staging
    staging="$(mktemp -d "$TASK_ROOT/cache/source.XXXXXX")"
    if ! tar -xzf "$archive_path" --strip-components=1 -C "$staging"; then
      rm -rf "$staging"
      return 1
    fi
    mv "$staging" "$destination"
    rm -f "$archive_path"
  fi
}
echo 'Installing the private local runtime. No paid generation service is used.'
if [[ ! -x "$TASK_ROOT/bin/uv" ]]; then
  fetch 'https://github.com/astral-sh/uv/releases/download/0.9.11/uv-aarch64-apple-darwin.tar.gz' "$TASK_ROOT/cache/uv.tar.gz"
  echo "594d9f4cfbd21d5a2f34b0352bf423066a9dab1733c90b5d40e3e227506deb03  $TASK_ROOT/cache/uv.tar.gz" | /usr/bin/shasum -a 256 -c -
  tar -xzf "$TASK_ROOT/cache/uv.tar.gz" --strip-components=1 -C "$TASK_ROOT/bin" uv-aarch64-apple-darwin/uv
fi
export UV_CACHE_DIR="$TASK_ROOT/cache/uv"
export UV_PYTHON_INSTALL_DIR="$TASK_ROOT/python"
"$TASK_ROOT/bin/uv" python install 3.12
if [[ ! -x "$TASK_ROOT/venv/bin/python" ]]; then "$TASK_ROOT/bin/uv" venv --python 3.12 "$TASK_ROOT/venv"; fi
if [[ -z "$SOURCE_COMMIT" ]]; then
  fetch 'https://api.github.com/repos/Galinsky-Arts/Music_Video_Wizard/commits/main' "$TASK_ROOT/cache/wizard-commit.json"
  SOURCE_COMMIT="$("$TASK_ROOT/venv/bin/python" -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha"])' "$TASK_ROOT/cache/wizard-commit.json")"
fi
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then echo 'Invalid wizard source revision.'; exit 1; fi
archive "https://github.com/Comfy-Org/ComfyUI/archive/$COMFY_COMMIT.tar.gz" "$TASK_ROOT/ComfyUI"
archive "https://github.com/tanis2000/comfyui-ltx2-mlx/archive/$PLUGIN_COMMIT.tar.gz" "$TASK_ROOT/ComfyUI/custom_nodes/comfyui-ltx2-mlx"
"$TASK_ROOT/bin/uv" pip install --python "$TASK_ROOT/venv/bin/python" -r "$TASK_ROOT/ComfyUI/requirements.txt"
"$TASK_ROOT/bin/uv" pip install --python "$TASK_ROOT/venv/bin/python" 'mlx>=0.20.0' soundfile huggingface_hub imageio-ffmpeg \
  "ltx-core-mlx @ https://github.com/dgrauet/ltx-2-mlx/archive/$MLX_COMMIT.zip#subdirectory=packages/ltx-core-mlx" \
  "ltx-pipelines-mlx @ https://github.com/dgrauet/ltx-2-mlx/archive/$MLX_COMMIT.zip#subdirectory=packages/ltx-pipelines-mlx"
"$TASK_ROOT/venv/bin/python" -c 'import mlx.core as mx; assert mx.metal.is_available(), "Apple Metal GPU is unavailable"; print("Apple Metal GPU detected")'
FFMPEG_BIN="$("$TASK_ROOT/venv/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
ln -sf "$FFMPEG_BIN" "$TASK_ROOT/venv/bin/ffmpeg"
if [[ ! -x "$TASK_ROOT/bin/cloudflared" ]]; then
  fetch 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-darwin-arm64.tgz' "$TASK_ROOT/cache/cloudflared.tgz"
  echo "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd  $TASK_ROOT/cache/cloudflared.tgz" | /usr/bin/shasum -a 256 -c -
  tar -xzf "$TASK_ROOT/cache/cloudflared.tgz" -C "$TASK_ROOT/bin" cloudflared
fi
for file in gateway.py start.sh smoke.py story.py; do
  fetch "https://raw.githubusercontent.com/Galinsky-Arts/Music_Video_Wizard/$SOURCE_COMMIT/scripts/mac-gpu/$file" "$TASK_ROOT/$file"
done
fetch "https://raw.githubusercontent.com/Galinsky-Arts/Music_Video_Wizard/$SOURCE_COMMIT/config/controlled-chaos-story.json" "$TASK_ROOT/story-template.json"
if [[ ! -e "$TASK_ROOT/story.json" ]]; then cp "$TASK_ROOT/story-template.json" "$TASK_ROOT/story.json"; fi
chmod 700 "$TASK_ROOT/start.sh"
if [[ ! -f "$TASK_ROOT/gpu-token" ]]; then
  "$TASK_ROOT/venv/bin/python" -c 'import secrets; print(secrets.token_urlsafe(48))' > "$TASK_ROOT/gpu-token"
fi
chmod 600 "$TASK_ROOT/gpu-token"
echo
echo 'Setup complete. Model weights download on the first test run (many gigabytes).'
printf 'Start the local worker with:\n  bash %q\n' "$TASK_ROOT/start.sh"
echo 'Keep the gateway token private. The start command prints connection instructions without printing the token.'
