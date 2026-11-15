#!/usr/bin/env bash
# Try a candidate model on the board without touching the running services.
#
#   ./experiments/board_try_model.sh                       # Qwen2.5-Coder 1.5B, Q4_K_M
#   ./experiments/board_try_model.sh <url> <sha256>        # any other GGUF
#
# On the board. It downloads the model to ~/models (needs internet, once),
# starts a second llama-server on port 8091 with the same options as the
# main one, measures how fast it reads and writes with the exact requests
# solve() sends, and stops that server again. The server on port 8081 keeps
# running, so check the RAM line before trusting the speeds: with both
# loaded, they share the four cores only while both are answering.
set -euo pipefail
cd "$(dirname "$0")/.."
source config.env

URL="${1:-https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf}"
SHA="${2:-cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046}"
PORT=8091
MODELS="${MODELS_DIR/#\~/$HOME}"
SERVER="${LLAMA_CPP_DIR/#\~/$HOME}/build/bin/llama-server"
FILE="$MODELS/$(basename "$URL")"

if [ ! -f "$FILE" ]; then
  echo "Downloading $(basename "$URL") to $MODELS ..."
  wget --continue --quiet --show-progress -O "$FILE" "$URL"
fi
echo "$SHA  $FILE" | sha256sum --check

free -m | awk 'NR==2 {printf "RAM before: %d MB available\n", $7}'
"$SERVER" -m "$FILE" --host 127.0.0.1 --port "$PORT" --threads "$LLM_THREADS" --ctx-size "$LLM_CTX" \
  --parallel 1 --cache-ram 0 --ctx-checkpoints 2 --jinja --reasoning off --reasoning-budget 0 \
  --alias candidate > /tmp/candidate-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 180); do
  curl -s -m 2 "http://127.0.0.1:$PORT/health" | grep -q ok && break
  sleep 1
done
free -m | awk 'NR==2 {printf "RAM with both models loaded: %d MB available\n", $7}'
python3 experiments/board_speed.py --port "$PORT"
