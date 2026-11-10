# Murmur

A self-hosted, all-day ambient secretary. A USB microphone listens continuously, speech is transcribed with speaker separation, and an LLM turns the day into summaries and to-dos. Everything runs on your own hardware and is viewed through a LAN-only web UI.

> Status: planning. See [docs/PLAN.md](docs/PLAN.md) (Chinese) for the design and roadmap. [中文说明](README.zh-CN.md)

## Design goals

- **Everything is swappable.** The recorder, audio storage, speech-to-text service and LLM are each configured separately. The STT service can run on another machine; the LLM is any OpenAI-compatible API.
- **Speakers are first-class.** Voices are clustered automatically; you name, merge, split or ignore them in the web UI, and named voices are recognised from then on.
- **Audio does not linger.** Raw audio is deleted once its transcript is safely stored. Only voiceprint vectors and a few short sample clips per speaker are kept.
- **Isolated components.** `recorder`, `core`, `asr` and `web` talk over plain HTTP and can be deployed separately.

## Roadmap

M0 field test → M1 capture & transcription → M2 speakers → M3 summaries & to-dos → M4 web UI → M5 deployment. Details in [docs/PLAN.md](docs/PLAN.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
