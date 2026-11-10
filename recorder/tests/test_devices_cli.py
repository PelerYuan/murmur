import json

import pytest

from murmur_recorder import cli
from murmur_recorder.config import Settings
from murmur_recorder.devices import resolve_device

DEVS = [
    {"id": "hw:1,0", "name": "USB Camera: Audio", "channels": 1, "default_samplerate": 48000, "is_default": False, "index": 4},
    {"id": "default", "name": "default", "channels": 32, "default_samplerate": 44100, "is_default": True, "index": 9},
    {"id": "Microphone (USB Audio Device)", "name": "Microphone (USB Audio Device)", "channels": 1,
     "default_samplerate": 44100, "is_default": False, "index": 2},
]


def test_resolve_device_variants():
    assert resolve_device(None, DEVS) is None
    assert resolve_device("", DEVS) is None
    assert resolve_device("hw:1,0", DEVS)["index"] == 4  # exact id
    assert resolve_device("USB Camera: Audio", DEVS)["index"] == 4  # exact name
    assert resolve_device("usb camera", DEVS)["index"] == 4  # substring survives card renumbering
    assert resolve_device("9", DEVS)["id"] == "default"  # PortAudio index
    with pytest.raises(LookupError, match="not found"):
        resolve_device("hw:7,7", DEVS)


def test_settings_from_env_and_cli_override(monkeypatch):
    env = {"MURMUR_CORE_URL": "http://core:8000", "MURMUR_TOKEN": "t", "MURMUR_SOURCE": "file:/x.wav",
           "MURMUR_FILE_SPEED": "8", "MURMUR_FILE_LOOP": "true", "MURMUR_BUFFER_DIR": "/var/buf"}
    s = Settings.from_env(env)
    assert (s.core_url, s.token, s.file_speed, s.file_loop, s.buffer_dir) == ("http://core:8000", "t", 8.0, True, "/var/buf")
    assert s.file_path == "/x.wav"
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    args = cli.build_parser().parse_args(["run", "--core-url", "http://other", "--file-speed", "2"])
    s2 = cli.settings_from_args(args)
    assert s2.core_url == "http://other" and s2.file_speed == 2.0 and s2.token == "t"


def test_missing_config_returns_2(monkeypatch, capsys):
    for k in ("MURMUR_CORE_URL", "MURMUR_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    assert cli.main([]) == 2
    assert cli.main(["run", "--core-url", "http://x"]) == 2


def test_bad_source_rejected():
    s = Settings(core_url="http://x", token="t", source="usb")
    with pytest.raises(ValueError):
        s.validate()


def test_devices_json_subcommand_does_not_crash(capsys):
    rc = cli.main(["devices", "--json"])
    out = capsys.readouterr().out
    assert rc == 0
    for d in json.loads(out):
        assert {"id", "name", "channels", "default_samplerate", "is_default"} <= set(d)
