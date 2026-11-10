# murmur-asr

The ASR service of Murmur: one HTTP call turns a WAV into **timestamped utterances with text, language, sound-event tag and
a speaker embedding**. It implements section 1 of [`docs/API.md`](../docs/API.md) and nothing else.

Pipeline per request (all ONNX, no torch, CPU by default):

```
WAV  ->  decode / downmix / resample to 16 kHz mono
     ->  silero VAD (sherpa-onnx)           speech segments, merged / split so none is longer than 25 s
     ->  SenseVoice-small int8 (default)    text + language + event (zh en ja ko yue, handles zh/en mixing)
         or Whisper (optional backend)      text only, with a hallucination guard
     ->  CAM++ zh-en speaker embedding      192-dim float vector per utterance (null if < 0.8 s or not speech)
```

## Quick start

```bash
export PATH=$HOME/.local/bin:$PATH                 # uv
cd asr
uv venv --python 3.10 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/python -m murmur_asr.download_models     # optional: ~270 MB into ~/.cache/murmur-models (otherwise done on first start)
.venv/bin/python -m murmur_asr                     # listens on 0.0.0.0:8100
curl -s localhost:8100/health
curl -s -F file=@some.wav -F language=auto localhost:8100/v1/process | python -m json.tool | head -30
```

Docker (CPU):

```bash
docker build -t murmur-asr .                       # ~360 MB image, models are NOT inside
docker run -d --name murmur-asr -p 8100:8100 -v murmur-models:/models murmur-asr   # first start downloads the models into the volume
# or bake the models into the image:  docker build --build-arg BAKE_MODELS=1 -t murmur-asr:baked .
```

The container runs as uid 1000, exposes 8100, has a `HEALTHCHECK` on `/health` and keeps models in the `/models` volume.

## HTTP API (as in docs/API.md)

| | |
|---|---|
| `GET /health` | `200 {"status":"ok"}` once the models are loaded; `503 {"status":"loading"\|"error","detail":...}` before that. Never needs the API key (container healthchecks). |
| `GET /v1/info` | name, version, `asr_model`, `embedding_model`, `embedding_dim` (192), `languages`, `features` |
| `POST /v1/process` | multipart: `file` (WAV, required), `language` (`auto` default, `zh`, `en`, `ja`, `ko`, `yue`; Whisper accepts any Whisper language code) |

Response: `language` (dominant by speech duration, `"unknown"` if nothing was recognised), `duration`, `processing_time`, `utterances[]`
with `start`, `end` (seconds from the start of the file), `text`, `lang`, `event` (`speech|music|noise|laughter|applause|other`),
`speech_prob`, `embedding`.

Behaviour worth knowing:

* Input WAV may be any rate / channel count / PCM 8-32 bit or float; it is down-mixed (channel average) and resampled to 16 kHz.
* Silence, noise or a zero-frame WAV give `200` with `utterances: []`.
* Utterances with a non-speech `event` (music, applause, ...) are returned (text may be empty or garbage) with `embedding: null`, so Core can filter them. A `speech` utterance whose text is empty is dropped.
* `embedding` is the raw CAM++ output (not normalised) and is `null` for utterances shorter than `MURMUR_ASR_MIN_EMBEDDING_SECONDS` (0.8 s) or with a non-speech event.
* Errors are `{"detail": "...", "code": "..."}`:
  `400 invalid_audio` (not a WAV, corrupt, no file field, empty body), `401 unauthorized`, `413 payload_too_large` (upload or audio length over the limits),
  `415 unsupported_audio` (e.g. ADPCM/A-law WAV), `422 invalid_request`, `503 busy` (queue full, has `Retry-After`) / `503 loading`, `500 internal_error`.

## Configuration (environment)

| variable | default | meaning |
|---|---|---|
| `MURMUR_ASR_HOST` / `MURMUR_ASR_PORT` | `0.0.0.0` / `8100` | listen address |
| `MURMUR_ASR_BACKEND` | `sensevoice` | `sensevoice` or `whisper` |
| `MURMUR_ASR_WHISPER_MODEL` | `small` | Whisper size when backend is `whisper`: `tiny`, `base`, `small`, `medium`, `*.en`, `large-v3`, ... (int8 builds from the sherpa-onnx release) |
| `MURMUR_ASR_PROVIDER` | `cpu` | `cpu` or `cuda` (see GPU section) |
| `MURMUR_ASR_NUM_THREADS` | `min(4, cpu count)` | onnxruntime threads **per worker** |
| `MURMUR_ASR_WORKERS` | `2` | requests processed at the same time; each worker holds its own copy of the models (~0.4 GB RAM each) |
| `MURMUR_ASR_MAX_QUEUE` | `8` | extra requests allowed to wait for a worker; beyond that `503 busy` |
| `MURMUR_ASR_MODEL_DIR` | `~/.cache/murmur-models` (`/models` in Docker) | where models live |
| `MURMUR_ASR_AUTO_DOWNLOAD` | `1` | download missing models at start (file lock protects concurrent starts) |
| `MURMUR_ASR_DOWNLOAD_PROXY` | unset | prefix that replaces `https://github.com` in model URLs (GitHub mirror) |
| `MURMUR_ASR_API_KEY` | unset | if set, `/v1/*` requires `Authorization: Bearer <key>` |
| `MURMUR_ASR_MAX_UPLOAD_MB` | `100` | upload size limit (100 MB is ~55 min of 16 kHz mono) |
| `MURMUR_ASR_MAX_AUDIO_SECONDS` | `3600` | audio length limit |
| `MURMUR_ASR_LOG_LEVEL` | `INFO` | |
| `MURMUR_ASR_VAD_THRESHOLD` / `_VAD_MIN_SILENCE` / `_VAD_MIN_SPEECH` | `0.5` / `0.3` / `0.25` | silero parameters (seconds). A shorter `min_silence` separates quick speaker turns better but cuts sentences at commas |
| `MURMUR_ASR_MAX_SEGMENT_SECONDS` | `25` | hard cap per utterance (5..29) |
| `MURMUR_ASR_MERGE_GAP` | `0.3` | VAD segments closer than this are merged (while <= max length) |
| `MURMUR_ASR_MIN_EMBEDDING_SECONDS` | `0.8` | shorter utterances get `embedding: null` |

One log line per request: `req=ab12cd34 audio=88.7s took=3.18s infer=3.14s rtf=0.036 utts=16 lang=zh`.

Models (downloaded from the sherpa-onnx GitHub releases; the `.tar.bz2` is streamed through extraction and never stored):

| file | size | license (upstream) |
|---|---|---|
| `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/{model.int8.onnx,tokens.txt}` | 240 MB | FunASR model license (SenseVoice) |
| `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` | 28 MB | 3D-Speaker (Apache-2.0) |
| `silero_vad.onnx` | 0.6 MB | MIT |
| Whisper, only with the whisper backend: `sherpa-onnx-whisper-<name>/{<name>-encoder.int8.onnx,<name>-decoder.int8.onnx,<name>-tokens.txt}` | tiny 100 MB ... medium ~900 MB | MIT (OpenAI Whisper) |

## Whisper backend (optional)

`MURMUR_ASR_BACKEND=whisper MURMUR_ASR_WHISPER_MODEL=small python -m murmur_asr`. Same pipeline and contract, but:

* no event tags: `event` is always `speech`; `/v1/info` reports `features.event_tags=false`. Music/noise filtering then relies on the VAD only.
* `language=auto` uses Whisper's own language detection per utterance (one language per VAD segment, so zh/en code-switching inside a sentence is weaker than with SenseVoice). An explicit hint loads an extra recogniser (cached, LRU of 2).
* hallucination guard drops empty/punctuation-only output, repeated units ("谢谢谢谢谢谢..."), stock phantom phrases on short audio ("Thank you for watching", "字幕由..."), and impossible text rates.
* Chinese output from Whisper tends to be Traditional characters.

Tested end-to-end only with `tiny` (real model, see tests); `base`/`small`/`medium` use the same code path but I did not run them here.
Measured with `tiny` on this VM: RTF 0.065, mixed-token CER 0.26 on the composite rooms (SenseVoice: 0.029), so use `small` or larger if you choose Whisper.

## GPU / CUDA

What is implemented: `MURMUR_ASR_PROVIDER=cuda` is passed to sherpa-onnx for the recogniser and the speaker embedder (the silero VAD stays on CPU, it is tiny).
It only has an effect if the installed `sherpa-onnx` is a CUDA build; with the normal PyPI wheel onnxruntime prints
`Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Fallback to cpu!` and runs on CPU (I checked that behaviour; the service also logs a warning).

How to get a CUDA build (per the sherpa-onnx docs, https://k2-fsa.github.io/sherpa/onnx/cuda.html):

```bash
pip uninstall -y sherpa-onnx sherpa-onnx-core
pip install "sherpa-onnx==2.0.1+cuda12.cudnn9.onnxruntime1.28.2" -f https://k2-fsa.github.io/sherpa/onnx/cuda.html   # ~440 MB wheel, Linux x86_64, Python 3.10-3.13
```

You need an NVIDIA driver for CUDA 12 and cuDNN 9 on the host (the wheel does not bundle cuDNN). `Dockerfile.gpu` does this on top of
`nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04`; run it with `docker run --gpus all ...` (NVIDIA Container Toolkit).

**Not verified here**: this VM has no GPU. I confirmed that the wheel URL and the base image tag exist, but I did not build `Dockerfile.gpu`
nor run anything on CUDA. Expect: the first request after start can be slow (CUDA kernel warm-up), int8 quantised models gain little from a GPU
(SenseVoice int8 is already ~30x faster than real time on 4 CPU threads), so a GPU mainly matters for Whisper `medium`/`large`.
With CUDA, lower `MURMUR_ASR_WORKERS` to 1-2 (GPU memory) and keep `NUM_THREADS` small.

## Tests and tools

```bash
.venv/bin/python -m pytest -q                 # everything (~40 s): unit tests + real-model contract tests
.venv/bin/python -m pytest -q -m "not heavy"  # fast part only (no models needed)
```

* `tests/test_audio.py`, `test_segmentation.py`, `test_events.py`: WAV decoding of all formats, resampler vs scipy, segment merge/split/pad, event mapping, hallucination guard.
* `tests/test_api_fake.py`: HTTP contract and every error path with a fake engine (corrupt/empty/oversized upload incl. chunked body, auth, busy queue, loading state, load failure, engine exception).
* `tests/test_models_download.py`: streaming extraction, atomicity, concurrent starts, config validation.
* `tests/test_whisper_wiring.py`: backend selection and Whisper wrapper with a fake recogniser.
* `tests/test_real.py` (marker `heavy`): real models on real audio through the real app: sherpa samples in 5 languages, 44.1 kHz stereo float input, silence/noise/beep, the synthetic rooms from `/home/peler/murmur-testdata` (speaker separation by embedding, code-switching, music not reported as speech, >25 s monologue split, concurrency), and the Whisper tiny backend. Tests needing test data are skipped if the directory is absent.
* `scripts/build_testdata.py`, `scripts/make_pseudo_labels.py`: rebuild the shared test data. `scripts/evaluate.py [rtf|cer|seg|emb]`: the measurements below against a running service.

## Measured on this VM

8 vCPU (AVX2), 7.8 GB RAM, no GPU, SenseVoice int8, 4 threads per worker, 2 workers. Test data: `/home/peler/murmur-testdata`.

**Speed.** Single request, wall-clock including HTTP and decoding: **RTF 0.037** (489 s of audio in 18.2 s; per file 0.032-0.049, e.g. 104 s of conversation in 3.9 s).
Two concurrent requests: 35x real time total throughput (the 8 cores are saturated; 4 concurrent just queue). Startup: models loaded in 1.7 s (first worker) / 3.2 s (both); first-ever start with download: 14 s in Docker.
Memory: RSS 0.8-0.9 GB with 2 workers (~0.4 GB per worker). Docker CPU image: 356 MB on disk.

**Transcript accuracy** (CER counts each CJK character and each Latin word as one token, punctuation/case ignored):

| material | result |
|---|---|
| sherpa samples zh / yue / ko | CER 0.00 (ko has spurious spaces inside words, ja too; zh/en/yue are clean) |
| sherpa ja | CER 0.03 (one wrong kana) |
| sherpa en | one word wrong ("gold" -> "code"), 1/15 words |
| TTS composite rooms (zh, zh/en mix, with music, monologue) | CER 0.020 / 0.041 / 0.031 / 0.023, weighted **0.029**. Typical errors: "Shanghai" -> "宣海", "GitHub" -> "gitthub", "WiFi" -> "aboutwifi" |

TTS speech is cleaner than a real living room, so expect worse on real recordings (M0 in the plan).

**Segmentation** (41 true turns in the 3 composite rooms): all 41 found; 9 turns were cut into several utterances (pause at a comma, `VAD_MIN_SILENCE=0.3`) and
1 of 53 utterances mixed two speakers (gaps of 0.6-0.8 s). With `VAD_MIN_SILENCE=0.5` it was 3 turns cut but 5 utterances mixing speakers; speaker purity was chosen over fewer fragments.
Speaker changes *without* a pause inside one segment cannot be separated (e.g. `0-four-speakers-zh.wav` 4.5-18 s is one utterance with 2-3 speakers); Core should expect a few impure embeddings.
Music stretches were labelled `event: music` (4/4 utterances, with garbage text, `embedding: null`); the vacuum noise and knocks were not detected at all (no utterance).
Note SenseVoice sometimes tags real speech over background music as `music`; Core should treat `music` + non-empty text with care.

**Speaker embeddings: cosine similarity of CAM++ (192-dim)**

| set | same-speaker pairs | different-speaker pairs |
|---|---|---|
| TTS speakers, utterances inside the composites (48 emb.) | mean 0.76, min 0.41, p5 0.58, p50 0.78, max 0.99 | mean 0.26, p95 0.44, max 0.62 |
| TTS single-sentence clips, same language (228 emb., 16 voices) | mean 0.79, std 0.07, min 0.41, p5 0.66 | mean 0.28, p95 0.48, max 0.81 (xiaoyi vs yunxia voices) |
| **real humans** (sherpa demo wavs, pseudo-labels, 16 emb.) | mean 0.76, min 0.63, max 0.90 | mean 0.18, p95 0.48, max 0.51 |
| same speaker, **zh clip vs en clip** (4 multilingual TTS voices) | mean **0.49**, min 0.18, p95 0.70 | |

* Utterance vs the centroid of its own speaker (built from other utterances): mean 0.90, min 0.66; vs centroids of other speakers: mean 0.28, p95 0.46, max 0.61.
* Short audio hurts (zh clips cropped, own-speaker mean vs centroid / other-speaker p95): 0.8 s: 0.66 / 0.45, 1.0 s: 0.72 / 0.50, 1.5 s: 0.81 / 0.53, 2 s: 0.85 / 0.55, 3 s: 0.90 / 0.58.
* Equal-error single threshold on pair scores is 0.48-0.58 (about 1-2 % false accepts and false rejects within one language).

**Suggested Core thresholds** (cosine, ASR vectors need no normalisation):

* `match_threshold` (utterance vs a **named** speaker's centroid; wrong attribution is expensive): **0.60**. Own-centroid scores for >= 2 s utterances are above 0.75 (p5), other speakers stay below 0.58 (p95).
* `cluster_threshold` (utterance vs an **unnamed** cluster centroid, otherwise open a new cluster): **0.55**. Splitting one person into two clusters is cheap to fix in the UI (merge); merging two people is not, so err on the high side. If you see too many clusters in practice, drop it to 0.50, not lower.
* Only create clusters / update centroids from utterances of **>= 1.5 s** (scores of 0.8-1 s utterances are 0.1-0.2 lower); shorter ones may still be matched against existing speakers using the same thresholds, or left unassigned.
* Compare against a centroid or several exemplars, not a single utterance (single-utterance same-speaker pairs reach down to 0.4).
* A bilingual speaker switching between Chinese and English scores only ~0.5 against themself: keep multiple exemplars per speaker (one per language) rather than one centroid, or expect an extra cluster that the user merges once.
* The synthetic voices are cleaner than a living room with TV and distance; real-room scores will be lower. Re-tune after the M0 recording session; `scripts/evaluate.py emb` reproduces these tables on any labelled audio.

## Deviations / notes on the contract

* `speech_prob`: sherpa-onnx does not expose silero's per-window probability. The service reports the **fraction of 32 ms windows in the utterance that silero judged speech** (0..1), typically 0.7-0.95 for clean speech. Useful for ranking, not a calibrated probability.
* `language` at top level is the duration-weighted dominant language (or `"unknown"` for no speech).
* `GET /health` returns 503 (with a JSON body) while models are loading/failed; the contract only shows the 200 case.
* Added error codes listed above; every error has `detail` and `code`.
* Reported utterance `start/end` are the VAD boundaries; silero tends to start ~0.1 s late, the recogniser is fed 0.25 s extra audio on both sides to compensate.

## Implementation notes

* sherpa-onnx quirk: pushing several VAD windows in one `accept_waveform` call makes segment start offsets wrong (seconds late), so the VAD is fed one 512-sample window at a time.
* `SenseVoice` ignores per-stream language options and `set_config` re-tokenises differently, so language hints are implemented with cached per-language recognisers.
* SenseVoice output for Korean/Japanese sometimes contains spaces inside words when audio is trimmed tightly; harmless for zh/en.
* Not handled: overlapping speech (two people at once yields one utterance), speaker change without a pause, streaming.

Layout: `src/murmur_asr/{config,audio,segmentation,events,recognizers,embedding,pipeline,service,download_models}.py`, `__main__.py`.
