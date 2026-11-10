from datetime import datetime

from conftest import make_wav, upload


def test_setup_login_flow(client):
    assert client.get("/api/v1/auth/status").json() == {"setup_required": True, "authenticated": False}
    assert client.get("/api/v1/rooms").status_code == 401
    assert client.post("/api/v1/auth/setup", json={"password": "123"}).status_code == 422
    assert client.post("/api/v1/auth/setup", json={"password": "secret123"}).status_code == 200
    assert client.get("/api/v1/rooms").status_code == 200
    assert client.post("/api/v1/auth/setup", json={"password": "other123"}).status_code == 409
    client.post("/api/v1/auth/logout")
    assert client.get("/api/v1/rooms").status_code == 401
    assert client.post("/api/v1/auth/login", json={"password": "nope"}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"password": "secret123"}).status_code == 200


def test_login_rate_limit(client):
    client.post("/api/v1/auth/setup", json={"password": "secret123"})
    client.post("/api/v1/auth/logout")
    for _ in range(5):
        assert client.post("/api/v1/auth/login", json={"password": "bad"}).status_code == 401
    r = client.post("/api/v1/auth/login", json={"password": "secret123"})
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 0
    assert r.json()["code"] == "rate_limited"


def test_rooms_and_recorders(authed):
    room = authed.post("/api/v1/rooms", json={"name": "工作室"}).json()
    assert room["created_at"].endswith("Z")
    rec = authed.post("/api/v1/recorders", json={"name": "mic", "room_id": room["id"]})
    assert rec.status_code == 201 and rec.json()["token"].startswith("mrm_")
    rid = rec.json()["id"]
    assert "token" not in authed.get("/api/v1/recorders").json()[0]
    patched = authed.patch(f"/api/v1/recorders/{rid}", json={"config": {"gain_db": 6, "device": "hw:1,0"}}).json()
    assert patched["config"]["gain_db"] == 6 and patched["config"]["device"] == "hw:1,0"
    assert authed.patch(f"/api/v1/recorders/{rid}", json={"config": {"vad_aggressiveness": 9}}).status_code == 422
    assert authed.post("/api/v1/recorders", json={"name": "x", "room_id": 999}).status_code == 422
    assert authed.delete(f"/api/v1/rooms/{room['id']}").status_code == 204
    assert authed.get("/api/v1/recorders").json()[0]["room_id"] is None
    new_token = authed.post(f"/api/v1/recorders/{rid}/rotate-token").json()["token"]
    assert new_token != rec.json()["token"]


def test_heartbeat_and_config(authed, recorder):
    hb = authed.post(
        "/api/v1/recorder/heartbeat",
        headers=recorder["headers"],
        json={"version": "0.1.0", "devices": [{"id": "hw:1,0", "name": "USB Mic"}], "status": {"state": "recording", "level_db": -40}},
    )
    assert hb.status_code == 200
    assert hb.json()["config"]["enabled"] is True and hb.json()["config"]["device"] is None
    rec = authed.get("/api/v1/recorders").json()[0]
    assert rec["online"] is True and rec["devices"][0]["name"] == "USB Mic" and rec["status"]["state"] == "recording"
    authed.patch(f"/api/v1/recorders/{rec['id']}", json={"config": {"enabled": False}})
    assert authed.post("/api/v1/recorder/heartbeat", headers=recorder["headers"], json={}).json()["config"]["enabled"] is False
    assert authed.post("/api/v1/recorder/heartbeat", headers={"Authorization": "Bearer nope"}, json={}).status_code == 401


def test_chunk_upload_idempotent_and_validated(authed, recorder):
    when = datetime(2026, 11, 11, 8, 0, 0)
    wav = make_wav(2.0)
    first = upload(authed, recorder, when, wav)
    assert first.status_code == 201 and first.json()["duplicate"] is False
    again = upload(authed, recorder, when, wav)
    assert again.status_code == 200 and again.json() == {"id": first.json()["id"], "duplicate": True}
    bad = authed.post(
        "/api/v1/recorder/chunks",
        headers=recorder["headers"],
        files={"file": ("c.wav", b"not a wav", "audio/wav")},
        data={"started_at": "2026-11-11T08:00:00Z", "duration": "1", "sha256": __import__("hashlib").sha256(b"not a wav").hexdigest()},
    )
    assert bad.status_code == 400 and bad.json()["code"] == "bad_audio"
    mismatch = authed.post(
        "/api/v1/recorder/chunks",
        headers=recorder["headers"],
        files={"file": ("c.wav", wav, "audio/wav")},
        data={"started_at": "2026-11-11T08:00:00Z", "duration": "1", "sha256": "0" * 64},
    )
    assert mismatch.status_code == 422
    chunks = authed.get("/api/v1/chunks").json()["items"]
    assert len(chunks) == 1 and chunks[0]["status"] == "pending"


def test_settings_roundtrip_masks_secrets(authed):
    got = authed.get("/api/v1/settings").json()
    assert got["llm"]["api_key"] == "" and got["schedule"]["daily"]["time"] == "23:30"
    r = authed.put("/api/v1/settings", json={"llm": {"base_url": "http://x/v1", "api_key": "sk-secret", "model": "m"}})
    assert r.status_code == 200 and r.json()["llm"]["api_key"] == "***"
    authed.put("/api/v1/settings", json={"llm": {"temperature": 0.5, "api_key": "***"}})
    from murmur_core.models import Setting

    rt = authed.app.state.runtime
    with rt.scope() as s:
        assert "sk-secret" not in s.get(Setting, "llm").value_json  # encrypted at rest
        assert rt.settings.get(s).llm.api_key == "sk-secret"  # and preserved by the "***" no-op
    assert authed.put("/api/v1/settings", json={"schedule": {"daily": {"time": "25:00"}}}).status_code == 422
    assert authed.put("/api/v1/settings", json={"nope": {}}).status_code == 422


def test_settings_test_endpoints(authed):
    assert authed.post("/api/v1/settings/test/asr").json()["ok"] is True
    assert authed.post("/api/v1/settings/test/llm").json()["ok"] is False
    authed.put("/api/v1/settings", json={"llm": {"base_url": "http://llm/v1", "model": "m"}})
    r = authed.post("/api/v1/settings/test/llm").json()
    assert r["ok"] is True and r["detail"] == "pong"
