#!/bin/bash
set -euo pipefail
umask 077
TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$TASK_ROOT/venv/bin:$PATH"
export HF_HOME="$TASK_ROOT/models/huggingface"
export PYTORCH_ENABLE_MPS_FALLBACK=1
mkdir -p "$TASK_ROOT/logs"
python -c 'import socket
for port in (8288,8289):
 s=socket.socket(); s.bind(("127.0.0.1",port)); s.close()' || { echo 'Ports 8288/8289 are already in use. Stop the old worker first.'; exit 1; }
PIDS=()
cleanup() { if [[ "${#PIDS[@]}" -gt 0 ]]; then kill "${PIDS[@]}" 2>/dev/null || true; fi; }
trap cleanup EXIT INT TERM
python "$TASK_ROOT/ComfyUI/main.py" --listen 127.0.0.1 --port 8288 --disable-auto-launch --preview-method none > "$TASK_ROOT/logs/comfyui.log" 2>&1 &
PIDS+=("$!")
READY=0
for ((i=0;i<90;i++)); do
  if python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8288/system_stats",timeout=1)' 2>/dev/null; then READY=1; break; fi
  if ! kill -0 "${PIDS[0]}" 2>/dev/null; then echo "ComfyUI failed to start. See $TASK_ROOT/logs/comfyui.log"; exit 1; fi
  sleep 2
done
if [[ "$READY" != 1 ]]; then echo "ComfyUI startup timed out. See $TASK_ROOT/logs/comfyui.log"; exit 1; fi
python "$TASK_ROOT/gateway.py" --token-file "$TASK_ROOT/gpu-token" > "$TASK_ROOT/logs/gateway.log" 2>&1 &
PIDS+=("$!")
/usr/bin/caffeinate -dims -w "${PIDS[0]}" &
PIDS+=("$!")
echo 'Local GPU worker started. Keep this Terminal open; Ctrl+C stops the worker.'
printf '\nRun a one-second LOCAL test in a second Terminal with:\n  %q %q\n' "$TASK_ROOT/venv/bin/python" "$TASK_ROOT/smoke.py"
if [[ "${MVW_GPU_TUNNEL:-0}" != 1 ]]; then
  echo 'Local-only mode: no public tunnel is running.'
  echo 'After the test passes, restart with MVW_GPU_TUNNEL=1 to connect the Render app through an authenticated Cloudflare tunnel.'
  wait "${PIDS[0]}"
  exit $?
fi
"$TASK_ROOT/bin/cloudflared" tunnel --url http://127.0.0.1:8289 --no-autoupdate > "$TASK_ROOT/logs/tunnel.log" 2>&1 &
PIDS+=("$!")
echo 'Starting the opt-in Cloudflare tunnel. Only the authenticated GPU API is exposed; the ComfyUI interface stays on loopback.'
URL=''
for ((i=0;i<60;i++)); do
  URL="$(python -c 'import re,sys; s=open(sys.argv[1]).read(); m=re.search(r"https://[a-z0-9-]+\.trycloudflare\.com",s); print(m.group(0) if m else "")' "$TASK_ROOT/logs/tunnel.log")"
  if [[ -n "$URL" ]]; then break; fi
  sleep 1
done
if [[ -z "$URL" ]]; then echo "Could not obtain a tunnel URL. See $TASK_ROOT/logs/tunnel.log"; exit 1; fi
printf '\nConnection URL (safe to share here): %s\n' "$URL"
echo 'Copy the private GPU token to the clipboard with:'
printf '  pbcopy < %q\n' "$TASK_ROOT/gpu-token"
echo 'Paste it into Render as COMFYUI_API_KEY; do not paste it in chat.'
printf '\nRun a one-second LOCAL test in a second Terminal with:\n  %q %q\n' "$TASK_ROOT/venv/bin/python" "$TASK_ROOT/smoke.py"
wait "${PIDS[0]}"
