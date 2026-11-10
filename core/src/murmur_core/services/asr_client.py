"""Clients for the speech-to-text service (Murmur ASR contract and OpenAI-compatible STT)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

from ..settings_store import Asr


class AsrError(Exception):
    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class RawUtterance:
    start: float
    end: float
    text: str
    lang: Optional[str] = None
    event: str = "speech"
    speech_prob: Optional[float] = None
    embedding: Optional[list[float]] = None


@dataclass
class AsrResult:
    utterances: list[RawUtterance] = field(default_factory=list)
    language: Optional[str] = None
    duration: Optional[float] = None


def _headers(cfg: Asr) -> dict:
    return {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}


def _base(cfg: Asr) -> str:
    return cfg.base_url.rstrip("/")


def _client(cfg: Asr, transport: Optional[httpx.BaseTransport]) -> httpx.Client:
    return httpx.Client(timeout=cfg.timeout_seconds, transport=transport, headers=_headers(cfg))


def transcribe(cfg: Asr, wav: bytes, transport: Optional[httpx.BaseTransport] = None) -> AsrResult:
    if not cfg.base_url:
        raise AsrError("ASR base_url is not configured", retryable=True)
    try:
        with _client(cfg, transport) as client:
            if cfg.mode == "openai":
                return _openai(client, cfg, wav)
            return _murmur(client, cfg, wav)
    except httpx.TimeoutException as exc:
        raise AsrError(f"ASR request timed out: {exc}") from exc
    except httpx.HTTPError as exc:
        raise AsrError(f"ASR request failed: {exc}") from exc


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.status_code < 400:
        return
    detail = resp.text[:300]
    # 4xx other than throttling/timeouts means the request itself is bad: retrying won't help.
    retryable = resp.status_code >= 500 or resp.status_code in (408, 425, 429)
    if resp.status_code in (401, 403):
        retryable = True  # misconfiguration the user can fix, then retry from the UI
    raise AsrError(f"ASR returned HTTP {resp.status_code}: {detail}", retryable=retryable)


def _murmur(client: httpx.Client, cfg: Asr, wav: bytes) -> AsrResult:
    resp = client.post(
        f"{_base(cfg)}/v1/process",
        files={"file": ("chunk.wav", wav, "audio/wav")},
        data={"language": cfg.language or "auto"},
    )
    _raise_for_status(resp)
    try:
        body = resp.json()
        items = body.get("utterances", [])
        out = [
            RawUtterance(
                start=float(u["start"]),
                end=float(u["end"]),
                text=str(u.get("text", "")).strip(),
                lang=u.get("lang"),
                event=u.get("event") or "speech",
                speech_prob=u.get("speech_prob"),
                embedding=u.get("embedding"),
            )
            for u in items
        ]
    except (ValueError, KeyError, TypeError) as exc:
        raise AsrError(f"ASR returned an unexpected response: {exc}", retryable=False) from exc
    return AsrResult(out, body.get("language"), body.get("duration"))


def _openai(client: httpx.Client, cfg: Asr, wav: bytes) -> AsrResult:
    data = {"model": cfg.model or "whisper-1", "response_format": "verbose_json"}
    if cfg.language and cfg.language != "auto":
        data["language"] = cfg.language
    base = _base(cfg)
    url = f"{base}/audio/transcriptions" if base.endswith("/v1") else f"{base}/v1/audio/transcriptions"
    resp = client.post(url, files={"file": ("chunk.wav", wav, "audio/wav")}, data={**data, "timestamp_granularities[]": "segment"})
    _raise_for_status(resp)
    try:
        body = resp.json()
        segments = body.get("segments") or []
        if not segments and body.get("text"):
            segments = [{"start": 0.0, "end": float(body.get("duration") or 0.0), "text": body["text"]}]
        out = []
        for seg in segments:
            text = str(seg.get("text", "")).strip()
            if not text:
                continue
            # Whisper reports avg_logprob / no_speech_prob; map them into a rough 0..1 speech probability.
            no_speech = seg.get("no_speech_prob")
            out.append(
                RawUtterance(
                    start=float(seg.get("start", 0.0)),
                    end=float(seg.get("end", 0.0)),
                    text=text,
                    lang=body.get("language"),
                    speech_prob=None if no_speech is None else max(0.0, 1.0 - float(no_speech)),
                )
            )
    except (ValueError, TypeError) as exc:
        raise AsrError(f"ASR returned an unexpected response: {exc}", retryable=False) from exc
    return AsrResult(out, body.get("language"), body.get("duration"))


def check(cfg: Asr, transport: Optional[httpx.BaseTransport] = None) -> dict:
    """Used by the settings page 'test connection' button. Returns {ok, detail, latency_ms, info}."""
    if not cfg.base_url:
        return {"ok": False, "detail": "ASR base_url is empty", "latency_ms": None, "info": None}
    started = time.monotonic()
    try:
        with httpx.Client(timeout=10, transport=transport, headers=_headers(cfg)) as client:
            if cfg.mode == "openai":
                base = _base(cfg)
                resp = client.get(f"{base}/models" if base.endswith("/v1") else f"{base}/v1/models")
                info = None
                if resp.status_code == 404:  # some servers do not expose /models; reachability is enough
                    return {"ok": True, "detail": "reachable (no /models endpoint)", "latency_ms": _ms(started), "info": None}
            else:
                resp = client.get(f"{_base(cfg)}/health")
                info = None
                if resp.status_code < 400:
                    info_resp = client.get(f"{_base(cfg)}/v1/info")
                    if info_resp.status_code < 400:
                        info = info_resp.json()
            if resp.status_code >= 400:
                return {"ok": False, "detail": f"HTTP {resp.status_code}: {resp.text[:200]}", "latency_ms": _ms(started), "info": None}
            return {"ok": True, "detail": "ok", "latency_ms": _ms(started), "info": info}
    except httpx.HTTPError as exc:
        return {"ok": False, "detail": str(exc) or exc.__class__.__name__, "latency_ms": _ms(started), "info": None}


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
