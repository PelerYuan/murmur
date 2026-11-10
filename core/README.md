# murmur-core

The brain of Murmur: it receives audio chunks from recorders, sends them to an ASR service, stores the transcript
with speaker labels, schedules LLM summaries and to-do extraction, fires reminders, and serves the web UI.

The HTTP contract with the other components is in [docs/API.md](../docs/API.md).

## Run it

```bash
cd core
uv venv --python 3.10 && uv pip install -e ".[dev]"      # add ,s3 for S3 audio storage, ,postgres for PostgreSQL
MURMUR_DATA_DIR=./data .venv/bin/murmur-core serve        # http://localhost:8000
```

Open the page, choose a password, add a recorder under **Recorders** (copy its token), and point **Settings → ASR / LLM**
at your services. Forgot the password? `murmur-core reset-password`.

Commands: `serve` (default), `worker` (pipeline + scheduler only), `reset-password`.

## Environment variables

Only process-level things are environment variables; everything else (ASR/LLM endpoints, schedules, thresholds, filters)
is edited in the web UI and stored in the database.

| Variable | Default | Meaning |
|---|---|---|
| `MURMUR_DATA_DIR` | `./data` | SQLite file, local audio, `secret.key` |
| `MURMUR_DATABASE_URL` | SQLite in the data dir | Any SQLAlchemy URL (PostgreSQL with the `postgres` extra) |
| `MURMUR_STORAGE` | `local` | `local`, `local:/path`, or `s3://bucket/prefix` (boto3 credentials / `AWS_ENDPOINT_URL` for MinIO) |
| `MURMUR_ROLE` | `all` | `all`, `api` or `worker`; split them to scale or isolate the pipeline |
| `MURMUR_HOST` / `MURMUR_PORT` | `0.0.0.0` / `8000` | Listen address |
| `MURMUR_SECRET_KEY` | generated into `data/secret.key` | Encrypts API keys stored in the database |
| `MURMUR_ASR_URL`, `MURMUR_ASR_API_KEY` | – | First-run defaults for the ASR endpoint |
| `MURMUR_LLM_BASE_URL`, `MURMUR_LLM_API_KEY`, `MURMUR_LLM_MODEL` | – | First-run defaults for the LLM |
| `MURMUR_COOKIE_SECURE` | `false` | Set to `true` behind HTTPS |
| `MURMUR_MAX_UPLOAD_MB` | `100` | Per-chunk upload limit |
| `MURMUR_LOG_LEVEL` | `INFO` | |

## How a chunk flows

1. The recorder uploads a WAV (idempotent on its sha256). Core stores it and queues a `chunk` row.
2. The pipeline worker claims it and calls ASR. Failures retry with backoff (15 s, 1 min, 4 min, 15 min, 30 min) and then
   mark the chunk `failed`, keeping its audio.
3. Filters drop non-speech events (music, TV sound effects) and filler-only text; ignored speakers are dropped.
4. Each utterance embedding is matched against known voiceprints (cosine). Named and ignored speakers use
   `match_threshold`; unnamed clusters use `cluster_threshold`. Utterances shorter than 1.5 s never start a new speaker.
5. Utterances, speaker assignments and a few short sample clips per speaker are committed in one transaction.
6. Only after the commit is verified is the raw chunk audio deleted.

The scheduler turns utterances into summaries (incremental, hourly, daily, on idle, or manual), extracts to-dos, fires due
reminders, and runs hourly housekeeping (retention, stale chunks, tiny junk speakers). Long transcripts are summarized
map-reduce style to fit `llm.max_input_chars`.

## Tests

```bash
.venv/bin/python -m pytest        # 49 tests: pipeline, speakers, summaries, to-dos, scheduler, storage (moto S3), SSE, auth
MURMUR_DATA_DIR=/tmp/murmur-demo .venv/bin/python scripts/seed_demo.py   # a few days of demo data; password demo1234
MURMUR_DATA_DIR=/tmp/murmur-demo .venv/bin/murmur-core serve
```

The tests use fake ASR and LLM transports; no network or GPU is needed.
