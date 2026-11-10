"""Blob storage for audio chunks and speaker samples."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def exists(self, key: str) -> bool: ...


class LocalStorage:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise ValueError(f"invalid storage key: {key}")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink()
        except FileNotFoundError:
            pass

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()


class S3Storage:
    """S3-compatible object storage (AWS, MinIO, ...). Needs `pip install murmur-core[s3]`.

    Credentials and an optional custom endpoint come from the standard AWS environment variables
    (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL, AWS_DEFAULT_REGION).
    """

    def __init__(self, bucket: str, prefix: str = "", client=None):
        if client is None:
            try:
                import boto3
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError("S3 storage needs boto3: pip install 'murmur-core[s3]'") from exc
            client = boto3.client("s3")
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def _key(self, key: str) -> str:
        if ".." in Path(key).parts:
            raise ValueError(f"invalid storage key: {key}")
        return f"{self.prefix}/{key}" if self.prefix else key

    def put(self, key: str, data: bytes) -> None:
        self.client.put_object(Bucket=self.bucket, Key=self._key(key), Body=data)

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=self._key(key))["Body"].read()

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._key(key))

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(key))
            return True
        except Exception:
            return False


def make_storage(spec: str, data_dir: Path) -> Storage:
    if spec in ("", "local"):
        return LocalStorage(Path(data_dir) / "storage")
    if spec.startswith("local:"):
        return LocalStorage(Path(spec[len("local:"):]))
    if spec.startswith("s3://"):
        rest = spec[len("s3://"):]
        bucket, _, prefix = rest.partition("/")
        return S3Storage(bucket, prefix)
    raise ValueError(f"unsupported MURMUR_STORAGE value: {spec}")
