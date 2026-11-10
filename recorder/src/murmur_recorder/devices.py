"""Input device enumeration (PortAudio via ``sounddevice``).

Device ids reported to Core (and accepted in ``config.device``):

* the ALSA hardware name ``hw:<card>,<dev>`` when PortAudio's device name contains it
  (``"USB Camera: Audio (hw:1,0)"`` -> ``hw:1,0``).  Matches the ``arecord -l`` numbering
  but card numbers can change when USB devices are re-plugged in a different order;
* otherwise the PortAudio device name itself (e.g. ``"default"``, ``"pulse"``,
  ``"Microphone (USB Audio Device)"`` on Windows, ``"MacBook Pro Microphone"`` on macOS).

Only input-capable devices are listed.  When resolving a configured id, in order:
exact id, exact name, ``hw:`` id contained in a name, then case-insensitive substring of
the name (so ``"USB Camera"`` keeps working after the card number changes), and finally a
bare integer is taken as the PortAudio index.  ``None`` means the system default.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional

log = logging.getLogger("murmur.devices")

_HW_RE = re.compile(r"\((hw:\d+,\d+)\)")
# ALSA plugin pseudo-devices that only add noise to the picker (not real microphones)
_NOISE_RE = re.compile(
    r"^(surround\d+|front|rear|center_lfe|side|iec958|spdif|hdmi|dmix|dsnoop|samplerate|speexrate|lavrate|"
    r"upmix|vdownmix|a52|null|usbstream|oss|jack|phoneline)(:.*)?$"
)


def _clean_name(name: str) -> str:
    return _HW_RE.sub("", name).strip().rstrip(":").strip() or name


def list_input_devices() -> List[Dict[str, Any]]:
    """Enumerate input devices in-process. Raises if PortAudio is unavailable."""
    import sounddevice as sd

    try:
        default_in = sd.default.device[0]
    except Exception:
        default_in = -1
    try:
        default_in = int(default_in)
    except (TypeError, ValueError):
        default_in = -1
    out: List[Dict[str, Any]] = []
    seen: Dict[str, int] = {}
    for idx, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] <= 0:
            continue
        name = d["name"]
        if _NOISE_RE.match(name):
            continue
        m = _HW_RE.search(name)
        dev_id = m.group(1) if m else name
        seen[dev_id] = seen.get(dev_id, 0) + 1
        if seen[dev_id] > 1:
            dev_id = f"{dev_id} #{seen[dev_id]}"
        out.append(
            {
                "id": dev_id,
                "name": _clean_name(name) if m else name,
                "channels": int(d["max_input_channels"]),
                "default_samplerate": int(d["default_samplerate"]),
                "is_default": idx == default_in,
                "index": idx,
            }
        )
    return out


def public_device(d: Dict[str, Any]) -> Dict[str, Any]:
    """The fields Core expects (drops our internal PortAudio index)."""
    return {k: d[k] for k in ("id", "name", "channels", "default_samplerate", "is_default")}


def list_input_devices_subprocess(timeout: float = 15.0) -> List[Dict[str, Any]]:
    """Enumerate in a fresh process.

    PortAudio caches its device list for the lifetime of the process and cannot be safely
    re-initialised while a stream is open, so hot-plugged devices are only visible to a new
    process.  The heartbeat uses this to keep the device list current while recording.
    """
    proc = subprocess.run(
        [sys.executable, "-m", "murmur_recorder", "devices", "--json"],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip()[-300:] or f"exit {proc.returncode}")
    return json.loads(proc.stdout)


def resolve_device(spec: Optional[str], devices: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """Map a config device string to an enumerated device dict (None -> default device => None)."""
    if spec is None or str(spec).strip() == "":
        return None
    spec = str(spec).strip()
    if devices is None:
        devices = list_input_devices()
    for d in devices:
        if d["id"] == spec:
            return d
    for d in devices:
        if d["name"] == spec:
            return d
    low = spec.lower()
    for d in devices:
        if d["id"].lower() == low:
            return d
    for d in devices:
        if low in d["name"].lower() or low in d["id"].lower():
            return d
    if spec.isdigit():
        for d in devices:
            if d["index"] == int(spec):
                return d
    raise LookupError(f"input device {spec!r} not found (available: {[d['id'] for d in devices]})")
