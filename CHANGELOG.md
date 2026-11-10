# Changelog

## 0.1.0 (2026-11-11)

First working version of the whole chain.

- **recorder**: WebRTC-VAD segmenter with pre-roll and max-chunk cut, device and file sources, local buffer with
  eviction, idempotent uploader with backoff, heartbeat that applies config without a restart, Docker image.
- **core**: FastAPI + SQLite (WAL, FTS5 trigram search) with optional PostgreSQL; chunk pipeline with retries;
  speaker clustering/matching with name, merge, split, ignore and sample clips; raw audio deleted only after the
  transcript is committed; local or S3 audio storage; incremental, hourly, daily, idle and manual summaries
  (map-reduce for long transcripts); LLM to-do extraction with de-duplication and web reminders; SSE events;
  encrypted API keys in settings; single-password login with `reset-password` CLI.
- **asr**: sherpa-onnx service with silero VAD, SenseVoice (default) or Whisper, CAM++ speaker embeddings,
  CPU and CUDA images.
- **web**: dashboard, timeline, summaries, to-dos, speakers, recorders and rooms, settings, onboarding;
  zh/en, light/dark, phone layout.
- **deploy**: core Dockerfile and `deploy/docker-compose.yml` (core, optional asr and recorder profiles).
- **scripts**: `scripts/e2e.sh` offline end-to-end smoke test, `scripts/mock_llm.py`.

Known gaps: not yet run on a real USB microphone; CUDA and Whisper above `tiny` untested; no real-LLM run;
a new voice's first short utterance can stay unassigned; one speaker talking in two languages may split into two
clusters until merged by hand. Next steps are in [docs/BACKLOG.md](docs/BACKLOG.md).
