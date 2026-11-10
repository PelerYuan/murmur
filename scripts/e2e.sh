#!/usr/bin/env bash
# End-to-end smoke test without a microphone or a real LLM:
#   recorder (file source) -> core -> asr (real models) -> utterances / speakers / summary / to-dos.
# Needs the venvs of core/, asr/ and recorder/ and a WAV (default: ~/murmur-testdata/room_family_zh.wav,
# built by asr/scripts/build_testdata.py). Leaves everything in $WORK (default /tmp/murmur-e2e).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WAV="${1:-$HOME/murmur-testdata/room_family_zh.wav}"
WORK="${WORK:-/tmp/murmur-e2e}"
PW=secret123
rm -rf "$WORK"; mkdir -p "$WORK"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

(cd "$ROOT/asr" && exec .venv/bin/python -m murmur_asr >"$WORK/asr.log" 2>&1) & pids+=($!)
python3 "$ROOT/scripts/mock_llm.py" --port 8200 >"$WORK/llm.log" 2>&1 & pids+=($!)
(cd "$ROOT/core" && MURMUR_DATA_DIR="$WORK/data" MURMUR_ASR_URL=http://127.0.0.1:8100 \
  MURMUR_LLM_BASE_URL=http://127.0.0.1:8200/v1 MURMUR_LLM_API_KEY=x MURMUR_LLM_MODEL=mock \
  exec .venv/bin/murmur-core serve >"$WORK/core.log" 2>&1) & pids+=($!)

for url in http://127.0.0.1:8100/health http://127.0.0.1:8000/healthz; do
  for _ in $(seq 60); do curl -sf "$url" >/dev/null && break; sleep 1; done
  curl -sf "$url" >/dev/null || { echo "service not ready: $url"; exit 1; }
done

API=http://127.0.0.1:8000/api/v1
curl -sf -c "$WORK/cj" -X POST $API/auth/setup -H 'content-type: application/json' -d "{\"password\":\"$PW\"}" >/dev/null
TOKEN=$(curl -sf -b "$WORK/cj" -X POST $API/recorders -H 'content-type: application/json' -d '{"name":"e2e"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -sf -b "$WORK/cj" -X PUT $API/settings -H 'content-type: application/json' -d '{"todos":{"every_minutes":1}}' >/dev/null

(cd "$ROOT/recorder" && MURMUR_CORE_URL=http://127.0.0.1:8000 MURMUR_TOKEN="$TOKEN" MURMUR_SOURCE="file:$WAV" \
  MURMUR_FILE_SPEED=20 MURMUR_BUFFER_DIR="$WORK/buffer" .venv/bin/murmur-recorder run >"$WORK/recorder.log" 2>&1)

echo "waiting for the pipeline..."
for _ in $(seq 120); do
  left=$(curl -sf -b "$WORK/cj" "$API/chunks?limit=200" | python3 -c 'import json,sys;print(sum(c["status"] in ("pending","processing") for c in json.load(sys.stdin)["items"]))')
  [ "$left" = 0 ] && break; sleep 1
done
curl -sf -b "$WORK/cj" -X POST $API/summaries/generate -H 'content-type: application/json' \
  -d "{\"level\":\"custom\",\"start\":\"$(date -u -d '-3 hours' +%FT%TZ)\",\"end\":\"$(date -u -d '+1 hour' +%FT%TZ)\"}" >/dev/null
sleep 70   # one to-do extraction tick (every minute) and the summary job

python3 - "$API" "$WORK/cj" <<'PY'
import http.cookiejar, json, sys, urllib.request
api, jar = sys.argv[1:]
cj = http.cookiejar.MozillaCookieJar(jar); cj.load(ignore_discard=True, ignore_expires=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
get = lambda p: json.load(op.open(api + p))
utts = get("/utterances?order=asc&limit=500")["items"]
speakers = get("/speakers")
chunks = get("/chunks?limit=200")["items"]
print(f"utterances={len(utts)} speakers={len(speakers)} chunks={len(chunks)} "
      f"audio_left={sum(not c['audio_deleted'] and c['status']=='done' for c in chunks)}")
for u in utts[:6]: print(f"  spk={u['speaker_id']}  {u['text']}")
print("summaries:", [s["title"] for s in get("/summaries")["items"]])
todos = get("/todos")
print("todos:", [t["text"] for t in (todos["items"] if isinstance(todos, dict) else todos)])
ok = utts and speakers and get("/summaries")["items"] and all(c["audio_deleted"] for c in chunks if c["status"] == "done")
print("E2E", "OK" if ok else "FAILED"); sys.exit(0 if ok else 1)
PY
