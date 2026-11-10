"""HTTP client for the Core recorder protocol (API.md section 2)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Dict, Optional

import httpx

from . import __version__
from .buffer import BufferedChunk, iso_utc


class CoreUnauthorized(Exception):
    """401/403: the token is invalid or revoked."""


class CoreRejected(Exception):
    """The chunk itself is not acceptable (4xx that will never succeed on retry)."""


class CoreError(Exception):
    """Core unreachable or temporary failure; retry later."""


@dataclass
class UploadResult:
    chunk_id: Optional[int]
    duplicate: bool


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class CoreClient:
    PERMANENT_REJECT = {400, 413, 415, 422}

    def __init__(self, base_url: str, token: str, timeout: float = 15.0, upload_timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {token}", "User-Agent": f"murmur-recorder/{__version__}"},
            timeout=httpx.Timeout(timeout, connect=5.0),
        )
        self._upload_timeout = httpx.Timeout(upload_timeout, connect=5.0)

    def close(self) -> None:
        self._client.close()

    @staticmethod
    def _detail(resp: httpx.Response) -> str:
        try:
            d = resp.json()
            return str(d.get("detail", d))
        except Exception:
            return resp.text[:200]

    def heartbeat(self, devices: list, status: Dict[str, Any]) -> Dict[str, Any]:
        try:
            resp = self._client.post(
                "/api/v1/recorder/heartbeat",
                json={"version": __version__, "devices": devices, "status": status},
            )
        except httpx.HTTPError as e:
            raise CoreError(f"core unreachable: {type(e).__name__}: {e}") from e
        if resp.status_code in (401, 403):
            raise CoreUnauthorized(f"HTTP {resp.status_code}: {self._detail(resp)}")
        if resp.status_code != 200:
            raise CoreError(f"heartbeat HTTP {resp.status_code}: {self._detail(resp)}")
        try:
            return resp.json()
        except ValueError as e:
            raise CoreError(f"heartbeat returned invalid JSON: {e}") from e

    def upload_chunk(self, chunk: BufferedChunk) -> UploadResult:
        data = chunk.path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        form = {
            "started_at": iso_utc(chunk.started_at),
            "duration": f"{max(0, len(data) - 44) / 2 / 16000:.3f}",
            "sha256": sha,
        }
        try:
            resp = self._client.post(
                "/api/v1/recorder/chunks",
                data=form,
                files={"file": (chunk.path.name, data, "audio/wav")},
                timeout=self._upload_timeout,
            )
        except httpx.HTTPError as e:
            raise CoreError(f"core unreachable: {type(e).__name__}: {e}") from e
        if resp.status_code in (200, 201):
            try:
                j = resp.json()
            except ValueError:
                j = {}
            return UploadResult(j.get("id"), bool(j.get("duplicate", resp.status_code == 200)))
        if resp.status_code in (401, 403):
            raise CoreUnauthorized(f"HTTP {resp.status_code}: {self._detail(resp)}")
        if resp.status_code in self.PERMANENT_REJECT:
            raise CoreRejected(f"HTTP {resp.status_code}: {self._detail(resp)}")
        raise CoreError(f"upload HTTP {resp.status_code}: {self._detail(resp)}")
