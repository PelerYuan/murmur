import json
import threading
import time

import pytest

from murmur_core import events
from murmur_core.storage import LocalStorage, S3Storage, make_storage


def test_local_storage_roundtrip_and_traversal(tmp_path):
    st = LocalStorage(tmp_path / "s")
    st.put("a/b.bin", b"123")
    assert st.get("a/b.bin") == b"123" and st.exists("a/b.bin")
    st.delete("a/b.bin")
    st.delete("a/b.bin")  # idempotent
    assert not st.exists("a/b.bin")
    with pytest.raises(ValueError):
        st.put("../escape", b"x")
    assert isinstance(make_storage("local:" + str(tmp_path / "other"), tmp_path), LocalStorage)
    with pytest.raises(ValueError):
        make_storage("ftp://nope", tmp_path)


def test_s3_storage_against_moto(monkeypatch):
    boto3 = pytest.importorskip("boto3")
    moto = pytest.importorskip("moto")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "x")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "x")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with moto.mock_aws():
        client = boto3.client("s3")
        client.create_bucket(Bucket="murmur")
        st = S3Storage("murmur", "audio-prefix", client=client)
        st.put("chunks/1.wav", b"RIFFdata")
        assert st.get("chunks/1.wav") == b"RIFFdata" and st.exists("chunks/1.wav")
        assert client.list_objects_v2(Bucket="murmur")["Contents"][0]["Key"] == "audio-prefix/chunks/1.wav"
        st.delete("chunks/1.wav")
        assert not st.exists("chunks/1.wav")


def test_pipeline_works_with_s3_storage(tmp_path, monkeypatch):
    boto3 = pytest.importorskip("boto3")
    moto = pytest.importorskip("moto")
    import httpx
    from fastapi.testclient import TestClient

    from conftest import FakeAsr, VOICE_A, upload, utt
    from murmur_core.app import create_app
    from murmur_core.config import Config
    from murmur_core.runtime import build_runtime
    from murmur_core.services.pipeline import PipelineWorker

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "x")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "x")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with moto.mock_aws():
        s3 = boto3.client("s3")
        s3.create_bucket(Bucket="murmur")
        asr = FakeAsr()
        asr.responses = [{"utterances": [utt(0, 3, "对象存储也能工作", VOICE_A)]}]
        rt = build_runtime(Config(data_dir=tmp_path / "d", secret_key="k"), storage=S3Storage("murmur", "p", client=s3))
        rt.asr_transport = httpx.MockTransport(asr.handler)
        with TestClient(create_app(rt.config, runtime=rt, start_background=False)) as c:
            c.post("/api/v1/auth/setup", json={"password": "secret123"})
            rec = c.post("/api/v1/recorders", json={"name": "m"}).json()
            from datetime import datetime

            upload(c, {"headers": {"Authorization": f"Bearer {rec['token']}"}}, datetime(2026, 11, 11, 8), duration=3)
            assert s3.list_objects_v2(Bucket="murmur")["KeyCount"] == 1
            PipelineWorker(rt).run_until_idle()
            assert c.get("/api/v1/utterances").json()["items"][0]["text"] == "对象存储也能工作"
            assert s3.list_objects_v2(Bucket="murmur").get("KeyCount", 0) >= 1  # speaker sample kept, chunk audio deleted
            keys = [o["Key"] for o in s3.list_objects_v2(Bucket="murmur").get("Contents", [])]
            assert not any(k.startswith("p/audio/") for k in keys)


def test_event_stream_delivers_new_events(rt):
    """Needs a real server: Starlette's TestClient buffers streaming responses until they end."""
    import socket

    import httpx
    import uvicorn

    from murmur_core.app import create_app

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(rt.config, runtime=rt, start_background=False), port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            httpx.get(base + "/healthz")
            break
        except httpx.HTTPError:
            time.sleep(0.1)
    try:
        with httpx.Client(base_url=base) as c:
            assert c.post("/api/v1/auth/setup", json={"password": "secret123"}).status_code == 200
            received: list[str] = []

            def listen():
                with c.stream("GET", "/api/v1/events", timeout=15) as resp:
                    for line in resp.iter_lines():
                        if line.startswith("event: todo.created"):
                            received.append(line)
                            return

            t = threading.Thread(target=listen, daemon=True)
            t.start()
            time.sleep(1.5)
            c.post("/api/v1/todos", json={"text": "实时事件"})
            t.join(timeout=10)
            assert received == ["event: todo.created"]
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def test_event_stream_requires_login(client):
    assert client.get("/api/v1/events").status_code == 401


def test_dashboard_and_system_info(authed, recorder):
    dash = authed.get("/api/v1/dashboard").json()
    assert dash["today"]["utterance_count"] == 0 and dash["open_todos"] == 0 and dash["recorders"][0]["online"] is False
    info = authed.get("/api/v1/system/info").json()
    assert info["version"] and info["disk_free_bytes"] > 0
    assert authed.get("/healthz").json() == {"status": "ok"}


def test_unknown_api_route_is_json_404(authed):
    r = authed.get("/api/v1/nope")
    assert r.status_code == 404 and r.json()["code"] == "not_found"


def test_static_web_is_served_with_spa_fallback(tmp_path, rt):
    from fastapi.testclient import TestClient

    from murmur_core.app import create_app

    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<html>app</html>")
    (web / "assets" / "a.js").write_text("console.log(1)")
    rt.config.web_dir = web
    with TestClient(create_app(rt.config, runtime=rt, start_background=False)) as c:
        assert c.get("/").text == "<html>app</html>"
        assert c.get("/timeline/2026-11-11").text == "<html>app</html>"  # client-side route
        assert c.get("/assets/a.js").text == "console.log(1)"
        assert c.get("/../../etc/passwd").status_code in (200, 404)
        assert "root:" not in c.get("/..%2f..%2fetc/passwd").text
        assert c.get("/api/v1/nope").status_code == 404
        assert c.get("/healthz").json()["status"] == "ok"


def test_password_change_and_cli_reset(authed, rt):
    assert authed.post("/api/v1/auth/password", json={"old_password": "wrong", "new_password": "newpass1"}).status_code == 401
    assert authed.post("/api/v1/auth/password", json={"old_password": "secret123", "new_password": "newpass1"}).status_code == 200
    assert authed.get("/api/v1/rooms").status_code == 401  # all sessions revoked
    assert authed.post("/api/v1/auth/login", json={"password": "newpass1"}).status_code == 200
    from murmur_core import cli

    import os

    os.environ["MURMUR_DATA_DIR"] = str(rt.config.data_dir)
    from murmur_core.config import get_config

    get_config.cache_clear()
    assert cli.main(["reset-password", "--password", "resetpass9"]) == 0
    get_config.cache_clear()
    assert authed.post("/api/v1/auth/login", json={"password": "resetpass9"}).status_code == 200
