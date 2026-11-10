# Murmur

A self-hosted, all-day ambient secretary. A USB microphone listens continuously, speech is transcribed with speaker separation, and an LLM turns the day into summaries and to-dos. Everything runs on your own hardware and is viewed through a LAN-only web UI. [中文说明](README.zh-CN.md)

> **Status: v0.1.0, first working version.** The whole chain (recorder → core → ASR → summaries/to-dos → web UI) runs end to end and is tested, but it has not yet been run on a real USB microphone around the clock. See [What is verified](#what-is-verified).

## How it works

```
 USB mic ──► recorder ──HTTP──► core ──HTTP──► asr (GPU box, optional)
 (any host)   VAD, buffer       queue, speakers,   speech-to-text + voiceprints
                                summaries, to-dos  
                                   │  ▲
                              web UI  └── any OpenAI-compatible LLM
```

- **recorder** runs on the machine with the microphone (one per room). It detects speech, uploads short WAV chunks and survives network outages with a local buffer.
- **core** stores transcripts in SQLite, matches speakers, schedules summaries and to-do extraction, fires reminders and serves the web UI.
- **asr** turns a WAV into timestamped utterances plus a speaker embedding (sherpa-onnx: SenseVoice for Chinese/English/Japanese/Korean/Cantonese, CAM++ voiceprints). CPU by default, CUDA optional. Core can also talk to any OpenAI-compatible speech-to-text API, without speaker separation.
- **web** is the single-page UI: dashboard, timeline with search and audio samples, summaries, to-dos with reminders, speaker management, recorder and settings pages, first-run onboarding, zh/en, light/dark, phone layout.

The components only talk HTTP; the contract is [docs/API.md](docs/API.md).

## Design goals

- **Everything is swappable.** Recorder placement, audio storage (local or S3), STT service, LLM endpoint and summary timing (incremental, hourly, daily, on idle, manual) are all settings, not code.
- **Speakers are central.** Voices are clustered automatically. You name, merge, split or ignore them in the web UI (ignore the TV, for instance), listening to a few kept sample clips to decide. Named voices are recognised from then on.
- **Audio does not linger.** Raw audio is deleted only after its transcript is committed and verified. What stays are voiceprint vectors and a few short sample clips per speaker.
- **Failures are boring.** Chunks are uploaded idempotently, processed with retries, and a down ASR or LLM only delays results.

## Quick start (Docker)

```bash
git clone https://github.com/PelerYuan/murmur && cd murmur/deploy
cp .env.example .env                       # set the LLM endpoint, optionally a secret key
docker compose --profile asr up -d --build # core + asr on this machine
```

Open `http://<server>:8000`, choose a password and follow the onboarding. Create a recorder under **Recorders**, then on the machine with the microphone:

```bash
cd recorder && uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -e .
MURMUR_CORE_URL=http://<server>:8000 MURMUR_TOKEN=<token from the UI> .venv/bin/murmur-recorder
```

(or `docker compose --profile recorder up -d` there, with `/dev/snd` passed through). To put ASR on a GPU machine, run the `asr` image there (see [asr/README.md](asr/README.md)) and set its URL in **Settings → ASR**.

Try it without a microphone or an LLM: `scripts/e2e.sh` plays a synthetic family conversation through the real ASR with a mock LLM; `core/scripts/seed_demo.py` fills a data directory with a few days of demo data for the UI.

## What is verified

- Core: 50 automated tests (pipeline, speakers, summaries, to-dos, scheduler, local and S3 storage, SSE, auth).
- Recorder: 63 tests, plus real capture through an ALSA loopback device, also inside Docker.
- ASR: 116 tests with real models; real-time factor about 0.04 on 8 CPU cores, CER 0 on the Chinese samples.
- Web: type-checked, 116 unit tests, every page looked at on desktop and phone width, light and dark.
- End to end: a 4-speaker Chinese conversation produced the 4 speakers; the first short utterance of a new voice can stay unassigned. Bilingual speakers can split into one cluster per language (cross-language voiceprint similarity is low), which you fix with one merge click.
- Docker images for core, asr and recorder build, and core plus asr run together through compose.

Not verified yet: a real USB microphone or webcam (gain control, hot-plug), CUDA, the Whisper backend above `tiny`, and a real LLM (only the OpenAI request/response shape and a mock were exercised).

## Documents

[docs/PLAN.md](docs/PLAN.md) design and roadmap (Chinese) · [docs/API.md](docs/API.md) contract · [docs/PRODUCT.md](docs/PRODUCT.md) product spec · [docs/BACKLOG.md](docs/BACKLOG.md) what comes next · [CHANGELOG.md](CHANGELOG.md)

Privacy: Murmur records people. Keep it on a trusted LAN, tell the people who live or work there, and follow the law where you are. Voiceprints are biometric data.

## License

Apache-2.0. See [LICENSE](LICENSE).
