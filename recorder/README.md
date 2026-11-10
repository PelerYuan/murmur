# murmur-recorder

The capture side of [Murmur](../README.md). It runs on whatever machine the USB microphone is
plugged into, listens continuously, and ships **speech only** to Murmur Core:

```
mic -> 16 kHz mono 16-bit -> software gain -> VAD segmenter -> chunk (WAV) -> buffer dir -> uploader -> Core
                                                                                ^ survives Core outages / restarts
```

* Protocol: `docs/API.md` section 2 (heartbeat every 10 s, multipart chunk upload with `sha256`,
  Bearer token). Config (device, gain, VAD, chunk timing) comes back in the heartbeat and applies **without a restart**.
* A chunk = `pre_roll_ms` of audio before the speech + the speech + `end_silence_ms` of trailing silence.
  It is flushed when `end_silence_ms` of silence has passed or `max_chunk_seconds` is reached (on a long
  monologue it cuts at a pause during the last 10 s before the limit, hard-cuts at the limit). Speech shorter than
  `min_speech_ms` is discarded, and silence/noise is never uploaded.
* Python 3.10+, dependencies: `sounddevice` (PortAudio), `numpy`, `httpx`, `webrtcvad-wheels`, `soxr`.

## Install on a host

```bash
sudo apt-get install -y libportaudio2          # PortAudio runtime (Debian/Ubuntu); Windows/macOS wheels bundle it
cd recorder
uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -e .
# or: python3 -m venv .venv && .venv/bin/pip install -e .

.venv/bin/murmur-recorder devices                # list input devices
export MURMUR_CORE_URL=http://core.lan:8000
export MURMUR_TOKEN=<token shown once when you create the recorder in the web UI>
.venv/bin/murmur-recorder                        # same as `murmur-recorder run`
```

Pick the microphone in the web UI (recorder settings) - the recorder reports its device list in every heartbeat.
Until you do, `device: null` = system default device.

### systemd user service

`~/.config/murmur-recorder.env` (chmod 600, absolute paths - systemd does not expand `~` here):

```ini
MURMUR_CORE_URL=http://core.lan:8000
MURMUR_TOKEN=paste-token-here
MURMUR_BUFFER_DIR=/home/YOU/.local/share/murmur-recorder/buffer
# MURMUR_BUFFER_MAX_MB=2048
```

`~/.config/systemd/user/murmur-recorder.service`:

```ini
[Unit]
Description=Murmur recorder
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/murmur-recorder.env
ExecStartPre=/usr/bin/mkdir -p %h/.local/share/murmur-recorder/buffer
ExecStart=%h/murmur/recorder/.venv/bin/murmur-recorder run
Restart=always
RestartSec=5
# SIGTERM flushes the in-progress chunk; give it a moment
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now murmur-recorder
loginctl enable-linger "$USER"        # keep running when you are not logged in (headless box)
journalctl --user -u murmur-recorder -f
```

### Permissions / udev for USB audio

* The user needs access to `/dev/snd/*`: be in the `audio` group (`sudo usermod -aG audio $USER`, re-login).
  On desktops with a logged-in seat, systemd-logind grants this automatically; on headless boxes you need the group.
* If PipeWire/PulseAudio is running it usually owns the card, so `hw:X,Y` fails with "device busy".
  Either select the `pulse` / `default` / `pipewire` device, or stop the sound server on that box.
* Card numbers (`hw:1,0`) follow USB enumeration order and can change after a reboot or re-plug. To pin a
  device, either use a **name substring** as the device (e.g. `USB Camera` - matching is case-insensitive) or fix
  the order in `/etc/modprobe.d/alsa.conf`:
  `options snd_usb_audio index=1 vid=0x046d pid=0x0825` (find ids with `lsusb`).
* A udev rule is only needed for unusual permission setups, e.g. `/etc/udev/rules.d/90-usb-mic.rules`:
  `SUBSYSTEM=="sound", GROUP="audio", MODE="0660"`.

## Docker

```bash
docker build -t murmur-recorder recorder/
docker run -d --name murmur-recorder --restart unless-stopped \
  --device /dev/snd --group-add "$(getent group audio | cut -d: -f3)" \
  -e MURMUR_CORE_URL=http://core.lan:8000 -e MURMUR_TOKEN=... \
  -v murmur-buffer:/buffer \
  murmur-recorder
docker run --rm --device /dev/snd --group-add "$(getent group audio | cut -d: -f3)" murmur-recorder devices
```

* The image runs as uid 1000 (non-root). `/dev/snd/*` belongs to the **host's** `audio` gid, which is why
  `--group-add <host gid>` is needed instead of baking a group into the image.
* Only direct ALSA devices (`hw:X,Y`) exist in the image (no PulseAudio/PipeWire), so the host's sound server must not be
  holding the card.
* Keep `/buffer` on a volume so queued audio survives container re-creation. The built-in `HEALTHCHECK` watches a
  liveness file the recorder touches every heartbeat - it stays healthy during a Core outage (audio is still being buffered).
* `docker stop` sends SIGTERM; the in-progress chunk is flushed first.

## Configuration

Local settings (environment variable, or the matching CLI flag of `murmur-recorder run`; flags win):

| Env var | Flag | Default | Meaning |
|---|---|---|---|
| `MURMUR_CORE_URL` | `--core-url` | - (required) | Core base URL, e.g. `http://core.lan:8000` |
| `MURMUR_TOKEN` | `--token` | - (required) | recorder token |
| `MURMUR_BUFFER_DIR` | `--buffer-dir` | `./buffer` | on-disk chunk queue (keep it on local disk) |
| `MURMUR_BUFFER_MAX_MB` | `--buffer-max-mb` | `2048` | cap; oldest chunks are evicted first with a `WARNING ... audio LOST` log |
| `MURMUR_SOURCE` | `--source` | `device` | `device` or `file:/path/to.wav` (test source, same pipeline) |
| `MURMUR_FILE_SPEED` | `--file-speed` | `1.0` | file source speed multiplier (`50` = 50x faster than real time) |
| `MURMUR_FILE_START_AT` | `--file-start-at` | now | ISO time to stamp the first sample with |
| `MURMUR_FILE_LOOP` | `--file-loop` | off | loop the file forever (otherwise exit after the buffer drains) |
| `MURMUR_HEARTBEAT_INTERVAL` | `--heartbeat-interval` | `10` | seconds |
| `MURMUR_DRAIN_TIMEOUT` | - | `60` | file source: seconds to wait for uploads at EOF before exiting |
| `MURMUR_LOG_LEVEL` | `--log-level` | `INFO` | |

Remote config (edited in the web UI, delivered by the heartbeat, applied live):

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | `false` releases the microphone, flushes the current chunk, reports `state: paused` |
| `device` | `null` | `null` = system default. Otherwise a device id from the list (below). Changing it reopens the stream |
| `gain_db` | `0.0` | software gain applied **before** VAD and before the chunk is written (clipped, clamp -60..+60) |
| `vad_aggressiveness` | `2` | WebRTC VAD 0-3; higher rejects more non-speech but may clip quiet speech |
| `min_speech_ms` | `300` | speech span below this is dropped |
| `end_silence_ms` | `1200` | silence that closes a chunk (also the trailing silence kept) |
| `max_chunk_seconds` | `60` | hard chunk length limit |
| `pre_roll_ms` | `300` | audio kept before the first speech frame |

Cached in `<buffer>/.murmur-config.json`, so a restart while Core is down keeps the last config (a paused recorder stays paused).

### Device ids

`murmur-recorder devices` lists input-capable devices only (ALSA plugin noise like `surround51` is hidden).
The **id** is `hw:<card>,<dev>` when PortAudio's name contains it (matches `arecord -l`), else the PortAudio device
name (`default`, `pulse`, `Microphone (USB Audio Device)`, `MacBook Pro Microphone`...). A configured device resolves by
exact id, exact name, then case-insensitive substring of the name, then a bare integer as PortAudio index.
The device list in the heartbeat is refreshed every 30 s in a short-lived subprocess (PortAudio cannot re-scan hardware
while a stream is open), so a hot-plugged mic shows up in the UI within ~30 s.

The stream is opened at 16 kHz mono when the device allows it, otherwise at the device's native rate / 2 channels and
converted (soxr resampler, channel average).

### Status reported in the heartbeat

`state`: `starting` | `recording` | `paused` | `error`. `level_db`: input level in dBFS **after gain** (what the
VAD and ASR hear), RMS per 100 ms block, instant attack and a 30 dB/s release; `-100.0` means digital silence or not
capturing. `buffered_chunks`: files waiting for upload. `error`: a capture problem (`state: error`) or, while
recording, the last upload problem (`upload: ...`).

## Offline behaviour

* Chunks are written `tmp -> fsync -> rename` into the buffer dir (`20261111T083000.123Z.wav` = UTC start), so a crash
  never leaves a half chunk.
* The uploader sends the oldest first, deletes a file only after `201`/`200`, retries with exponential backoff
  (1 s doubling, +/-15 % jitter, capped at 60 s) and logs the first failure then at most once a minute.
* On start it re-scans the buffer dir and uploads what a previous run left behind. Re-sending is safe: Core dedupes by `sha256`.
* `401/403` (bad or rotated token): clear error in the log and in `status.error`, capture and buffering continue,
  retry every ~30-60 s. Files rejected permanently by Core (400/413/415/422) or invalid WAVs go to `<buffer>/rejected/`.

## Testing without a microphone

```bash
# mock Core: registers any token, stores chunks, serves config from a JSON file you can edit live
.venv/bin/python tools/fake_core.py --port 8000 --out ./received --config ./cfg.json
MURMUR_CORE_URL=http://127.0.0.1:8000 MURMUR_TOKEN=x MURMUR_SOURCE=file:sample.wav MURMUR_FILE_SPEED=20 \
  .venv/bin/murmur-recorder
```

`curl -X POST 'localhost:8000/_admin/fail?mode=down'` makes the mock return 503 to simulate an outage (`mode=ok` restores it).

Unit tests: `.venv/bin/python -m pytest` (uses real speech from `/home/peler/murmur-testdata/` when present, else `espeak-ng`).
`tests/test_live_loopback.py` exercises real PortAudio capture through the ALSA loopback card (`sudo modprobe snd-aloop`)
and skips itself when that is not available.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no input device available` / device list empty | mic not detected (`lsusb`, `arecord -l`); in Docker forgot `--device /dev/snd`; permission: join the `audio` group |
| `cannot enumerate audio devices ... PortAudio` | install `libportaudio2` |
| `cannot open input device ... Device unavailable` / busy | PipeWire/PulseAudio owns the card - use device `pulse`/`default`, or another app is recording from it |
| `Invalid sample rate` | handled: the recorder falls back to the device's native rate and resamples. If it still fails the device is not 16/44.1/48 kHz capable - try the `default` device (ALSA `plug` conversion) |
| `input overflow` in debug logs, gaps in audio | CPU starvation or USB hub problems; the recorder asks for a 0.5 s PortAudio buffer and re-anchors timestamps after a gap |
| Nothing is ever uploaded, level stays near -100 dB | muted / wrong capture device or ALSA mixer at 0: `alsamixer -c 1` -> F4 (Capture), unmute and raise |
| Chunks are cut mid-sentence or words clipped | raise `pre_roll_ms`, lower `vad_aggressiveness` to 1, raise `gain_db` for quiet far-field mics |
| Lots of chunks of room noise / TV | raise `vad_aggressiveness` to 3 and/or `min_speech_ms`; Core also filters non-speech and hallucinations |
| Volume pumps, noise swells between words, speech fades in and out | **headset/webcam AGC**: the mic's own automatic gain control raises the noise floor between words and squashes dynamics. Disable "Auto Gain Control" (`alsamixer`, or `pavucontrol` input properties) if the device exposes it; otherwise prefer a fixed `gain_db` and a higher `end_silence_ms`. Webcam mics are notorious for this |
| `Core rejected the recorder token (401)` | token wrong/rotated: copy the current one from the web UI; audio keeps buffering meanwhile |
| `buffer over limit ... audio LOST` | Core was unreachable longer than the cap allows (audio is 32 kB/s, so 2 GB is about 18 h of speech); raise `MURMUR_BUFFER_MAX_MB` |

### Reading the level meter

The web UI meter shows `level_db` (dBFS, after gain): about **-60 dB** and below is a quiet room, **-45..-30 dB** is
typical speech from a far-field mic, **-20..-6 dB** is close, healthy speech, anything stuck near **0 dB** is clipping
(reduce `gain_db`). If speech peaks at -50 dB or lower, raise `gain_db` (+10 to +20 dB is common for webcam mics); the
VAD works best when speech sits clearly above the room noise. Constant high readings with nobody talking mean a noisy
mic or AGC.
