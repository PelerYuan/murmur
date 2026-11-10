from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    return "scrypt${}${}${}${}${}".format(
        _SCRYPT_N, _SCRYPT_R, _SCRYPT_P, base64.b64encode(salt).decode(), base64.b64encode(digest).decode()
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt_b64, digest_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        digest = hashlib.scrypt(password.encode(), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except Exception:
        return False
    return hmac.compare_digest(digest, expected)


def new_token(prefix: str = "") -> str:
    return prefix + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Crypto:
    """Encrypts secrets (API keys) stored in the settings table."""

    PREFIX = "enc:"

    def __init__(self, secret: str):
        key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
        self._fernet = Fernet(key)

    @classmethod
    def from_config(cls, secret_key: Optional[str], data_dir: Path) -> "Crypto":
        if secret_key:
            return cls(secret_key)
        data_dir.mkdir(parents=True, exist_ok=True)
        path = data_dir / "secret.key"
        if path.exists():
            secret = path.read_text().strip()
        else:
            secret = secrets.token_urlsafe(48)
            path.write_text(secret)
            path.chmod(0o600)
        return cls(secret)

    def encrypt(self, value: str) -> str:
        if not value or value.startswith(self.PREFIX):
            return value
        return self.PREFIX + self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, value: str) -> str:
        if not value or not value.startswith(self.PREFIX):
            return value
        try:
            return self._fernet.decrypt(value[len(self.PREFIX):].encode()).decode()
        except InvalidToken:
            return ""


class LoginLimiter:
    """Blocks an address for a cool-down after repeated failed logins."""

    def __init__(self, max_failures: int = 5, cooldown: float = 60.0):
        self.max_failures = max_failures
        self.cooldown = cooldown
        self._lock = threading.Lock()
        self._state: dict[str, tuple[int, float]] = {}

    def retry_after(self, key: str) -> int:
        with self._lock:
            failures, until = self._state.get(key, (0, 0.0))
            now = time.monotonic()
            if failures >= self.max_failures and until > now:
                return int(until - now) + 1
            if failures >= self.max_failures and until <= now:
                self._state.pop(key, None)
            return 0

    def failed(self, key: str) -> None:
        with self._lock:
            failures, _ = self._state.get(key, (0, 0.0))
            self._state[key] = (failures + 1, time.monotonic() + self.cooldown)

    def succeeded(self, key: str) -> None:
        with self._lock:
            self._state.pop(key, None)
