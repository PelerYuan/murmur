# Murmur 接口与数据契约（v1）

这是各组件之间的**唯一契约**。`recorder`、`core`、`asr`、`web` 分别实现自己的一侧，改动契约必须先改本文件。

通用约定：

- 时间一律 **ISO 8601 UTC，带 `Z`**，例如 `2026-11-11T08:30:00Z`；前端按设置里的时区显示
- JSON 字段 `snake_case`；ID 为整数
- 错误响应：HTTP 状态码 + `{"detail": "人类可读的说明", "code": "machine_code"}`
- 音频统一为 **16 kHz、单声道、16-bit PCM WAV**
- Core 默认端口 **8000**，ASR 默认端口 **8100**

---

## 1. ASR 服务契约（Core → asr）

### `GET /health` → `{"status":"ok"}`

### `GET /v1/info`
```json
{ "name": "murmur-asr", "version": "0.1.0",
  "asr_model": "sensevoice-small-int8", "embedding_model": "campplus-zh-en",
  "embedding_dim": 192, "languages": ["zh","en","ja","ko","yue"],
  "features": {"speaker_embedding": true, "event_tags": true} }
```

### `POST /v1/process`（multipart/form-data）

| 字段 | 说明 |
|---|---|
| `file` | WAV 音频，必填 |
| `language` | 语言提示，`auto`（默认）/ `zh` / `en` … |

响应：
```json
{
  "language": "zh",
  "duration": 58.4,
  "processing_time": 2.1,
  "utterances": [
    { "start": 1.20, "end": 4.85, "text": "明天下午三点记得开会", "lang": "zh",
      "event": "speech", "speech_prob": 0.97,
      "embedding": [0.01, -0.03, "... embedding_dim 个 float"] }
  ]
}
```

- `start/end` 为相对本音频起点的秒数；`utterances` 按时间升序
- `event`：`speech` | `music` | `noise` | `laughter` | `applause` | `other`；无事件标签的模型一律返回 `speech`
- `embedding`：该话语的说话人声纹向量，模型不支持时为 `null`；**Core 用余弦相似度比较，ASR 服务无需归一化**
- 一段话语不应超过约 30 秒，ASR 服务内部负责 VAD 切分；音频里没有语音时返回 `utterances: []`
- 失败时返回 4xx/5xx 的错误 JSON，Core 会重试

### 兼容模式：OpenAI STT
Core 也能直接对接任何 OpenAI 兼容 STT：`POST {base}/v1/audio/transcriptions`，`response_format=verbose_json`，`timestamp_granularities[]=segment`，读取 `segments[].{start,end,text}`。此模式没有声纹，所有话语归入"未知说话人"。

---

## 2. 录音端协议（recorder → Core）

认证：`Authorization: Bearer <recorder_token>`，token 由网页端创建录音端时一次性显示。

### `POST /api/v1/recorder/heartbeat`
录音端每 **10 秒**发一次，同时上报设备并拉取配置。

请求：
```json
{ "version": "0.1.0",
  "devices": [ {"id": "hw:1,0", "name": "USB Camera Mic", "channels": 1, "default_samplerate": 48000, "is_default": false} ],
  "status": { "state": "recording", "level_db": -42.5, "buffered_chunks": 0, "active_device": "hw:1,0", "error": null } }
```
`state`：`recording` | `paused` | `error` | `starting`

响应（即录音端当前配置，网页端修改后下次心跳生效）：
```json
{ "recorder_id": 3, "server_time": "2026-11-11T08:30:00Z",
  "config": { "enabled": true, "device": "hw:1,0", "gain_db": 0.0,
              "vad_aggressiveness": 2, "min_speech_ms": 300, "end_silence_ms": 1200,
              "max_chunk_seconds": 60, "pre_roll_ms": 300 } }
```
`device` 为 `null` 表示使用系统默认设备；`enabled=false` 表示暂停录音。

### `POST /api/v1/recorder/chunks`（multipart/form-data）

| 字段 | 说明 |
|---|---|
| `file` | WAV |
| `started_at` | 片段第一个采样点的 UTC 时间 |
| `duration` | 秒，float |
| `sha256` | 文件内容 SHA-256（十六进制） |

响应 `201`：`{"id": 123, "duplicate": false}`。同一录音端同一 `sha256` 重复上传返回 `200` 且 `duplicate: true`（幂等，录音端据此安全重试）。

录音端行为要求：采集 → VAD → 以"语音段 + 前后静音"为单位成片，一片最长 `max_chunk_seconds`；上传失败写入本地缓冲目录，指数退避重试，恢复后按时间顺序补传；上传成功才删除本地文件。

---

## 3. 网页端 REST API（`/api/v1`）

认证：`murmur_session` Cookie（HttpOnly）。未登录返回 `401`。分页参数 `limit`（默认 50，最大 500）、`cursor`（不透明字符串），响应 `{"items":[...], "next_cursor": "..."|null}`。

### 3.1 认证
| 方法 路径 | 说明 |
|---|---|
| `GET /auth/status` | `{"setup_required": bool, "authenticated": bool}`（无需登录） |
| `POST /auth/setup` `{password}` | 仅在未设置密码时可用，最少 6 位；成功后自动登录 |
| `POST /auth/login` `{password}` | 设置 Cookie，限速：同一 IP 5 次失败后冷却 60 秒 |
| `POST /auth/logout` | |
| `POST /auth/password` `{old_password,new_password}` | |

### 3.2 房间与录音端
```
Room      {id, name, created_at}
Recorder  {id, name, room_id, created_at, last_seen, online, version, devices:[...], status:{...},
           config:{enabled, device, gain_db, vad_aggressiveness, min_speech_ms, end_silence_ms, max_chunk_seconds, pre_roll_ms}}
```
`online`：最近 30 秒内有心跳。

| 方法 路径 | 说明 |
|---|---|
| `GET/POST /rooms`，`PATCH/DELETE /rooms/{id}` | 删除房间时其录音端的 `room_id` 置空 |
| `GET /recorders`，`POST /recorders` `{name, room_id}` | 创建后响应含**仅此一次**的 `token` |
| `PATCH /recorders/{id}` | 可改 `name`、`room_id`、`config` 的任意子集 |
| `POST /recorders/{id}/rotate-token` | 返回新 `token` |
| `DELETE /recorders/{id}` | |

### 3.3 设置
`GET /settings` 返回完整设置对象（密钥字段返回 `"***"` 占位，表示已设置）；`PUT /settings` 提交**局部**对象，深度合并；密钥字段提交 `"***"` 表示不修改。

默认值与含义：
```json
{
  "general": { "timezone": "Asia/Shanghai", "ui_language": "zh", "output_language": "zh" },
  "asr": { "mode": "murmur", "base_url": "http://localhost:8100", "api_key": "", "model": "", "language": "auto", "timeout_seconds": 300, "concurrency": 2 },
  "llm": { "base_url": "", "api_key": "", "model": "", "temperature": 0.3, "max_input_chars": 24000, "timeout_seconds": 180,
           "prompts": { "summary": "", "daily": "", "todos": "" } },
  "speakers": { "match_threshold": 0.55, "cluster_threshold": 0.60, "sample_count": 5, "sample_seconds": 5, "min_utterance_seconds": 0.8 },
  "filters": { "drop_non_speech": true, "drop_hallucinations": true, "min_confidence": 0.3, "min_text_chars": 1 },
  "retention": { "delete_audio_after_transcribe": true, "failed_audio_days": 7, "utterance_embedding_days": 30 },
  "schedule": {
    "incremental": { "enabled": true, "every_minutes": 30, "min_utterances": 5 },
    "hourly": { "enabled": false },
    "daily": { "enabled": true, "time": "23:30" },
    "idle": { "enabled": false, "idle_minutes": 10 }
  },
  "todos": { "enabled": true, "every_minutes": 10, "min_confidence": 0.6, "default_remind_before_minutes": 10 }
}
```
- `asr.mode`：`murmur`（第 1 节契约）或 `openai`（兼容模式）
- `llm.prompts.*` 为空字符串时使用内置默认模板
- 说话人阈值是余弦相似度，随声纹模型不同需要调参

| 方法 路径 | 说明 |
|---|---|
| `POST /settings/test/asr` | 请求 ASR `/health` 与 `/v1/info`，返回 `{ok, detail, latency_ms, info}` |
| `POST /settings/test/llm` | 发一条最小 chat 请求，返回 `{ok, detail, latency_ms}` |

### 3.4 流水线
```
Chunk {id, recorder_id, room_id, started_at, duration, status: pending|processing|done|failed|skipped,
       attempts, error, utterance_count, audio_deleted}
```
| 方法 路径 | 说明 |
|---|---|
| `GET /pipeline/status` | `{counts:{pending,processing,done,failed,skipped}, oldest_pending_at, last_done_at, asr_ok, llm_configured, errors:[最近 5 条]}` |
| `GET /chunks?status=&limit=&cursor=` | |
| `POST /chunks/{id}/retry` | `failed` → `pending`；音频已删除时返回 `409` |

### 3.5 话语与说话人
```
Utterance {id, chunk_id, room_id, started_at, ended_at, text, lang, speaker_id|null, speaker_name, confidence}
Speaker   {id, name|null, display_name, state: unnamed|named|ignored, color, utterance_count, total_seconds,
           first_seen, last_seen, samples:[{id, duration}]}
```
`display_name`：有 `name` 用 `name`，否则 `说话人 {id}`（后端按 `ui_language` 生成，前端也可自行处理）。`color`：后端按 id 分配的 `#rrggbb`。

| 方法 路径 | 说明 |
|---|---|
| `GET /utterances?from=&to=&room_id=&speaker_id=&q=&limit=&cursor=` | 按 `started_at` 倒序；`q` 为全文检索（支持中文子串） |
| `PATCH /utterances/{id}` | 可改 `speaker_id`（把这句话改归到别的说话人，同时更新声纹质心）和 `text` |
| `DELETE /utterances/{id}` | |
| `GET /speakers?state=` | |
| `GET /speakers/{id}` | |
| `PATCH /speakers/{id}` | `name`（设为非空即 `state=named`）、`state`（`ignored` 会让之后该声纹的话语被丢弃） |
| `POST /speakers/{id}/merge` `{into_id}` | 话语与声纹并入目标，样本合并去重；返回目标说话人 |
| `POST /speakers/{id}/split` `{utterance_ids:[...]}` | 把这些话语拆成一个新的未命名说话人 |
| `DELETE /speakers/{id}` | 其话语的 `speaker_id` 置空，声纹一并删除 |
| `GET /speakers/{id}/samples/{sample_id}/audio` | `audio/wav` |

### 3.6 摘要
```
Summary {id, level: incremental|hourly|daily|custom, range_start, range_end, room_id|null,
         title, content (Markdown), model, utterance_count, created_at}
SummaryJob {id, level, range_start, range_end, room_id, status: queued|running|done|failed, error, summary_id}
```
| 方法 路径 | 说明 |
|---|---|
| `GET /summaries?level=&from=&to=&room_id=&limit=&cursor=` | 按 `range_start` 倒序 |
| `GET /summaries/{id}`，`DELETE /summaries/{id}` | |
| `POST /summaries/generate` `{level, start, end, room_id?}` | 返回 `202` + `SummaryJob`；同一范围已有摘要则覆盖重生成 |
| `GET /summary-jobs?status=` | |

### 3.7 待办与提醒
```
Todo {id, text, status: open|done|dismissed, assignee_speaker_id|null, assignee_name|null,
      due_at|null, remind_at|null, reminder_state: none|pending|fired|acked,
      confidence, source: auto|manual, source_utterance_id|null, source_excerpt|null,
      created_at, updated_at, completed_at|null}
```
| 方法 路径 | 说明 |
|---|---|
| `GET /todos?status=&assignee_id=&q=` | 默认 `open` 在前，按 `due_at` 升序（无截止最后） |
| `POST /todos` | 手动创建，`source=manual` |
| `PATCH /todos/{id}` | `text/status/assignee_speaker_id/due_at/remind_at`；修改 `remind_at` 重置 `reminder_state=pending` |
| `DELETE /todos/{id}` | |
| `GET /reminders/due` | `remind_at <= now` 且 `reminder_state in (pending, fired)` 的 open 待办 |
| `POST /todos/{id}/ack-reminder` | `reminder_state=acked` |
| `POST /todos/{id}/snooze` `{minutes}` | `remind_at = now + minutes`，`reminder_state=pending` |

### 3.8 概览与实时事件
`GET /dashboard`：
```json
{ "date": "2026-11-11",
  "today": { "utterance_count": 120, "speech_seconds": 3400,
             "by_speaker": [{"speaker_id": 1, "display_name": "小明", "color": "#...", "seconds": 1800, "utterances": 60}] },
  "open_todos": 5, "due_reminders": 1,
  "latest_summary": { "...Summary|null" },
  "recorders": [{"id":1,"name":"客厅","online":true,"state":"recording"}],
  "pipeline": { "pending": 0, "failed": 0 } }
```

`GET /events`：Server-Sent Events（Cookie 认证）。事件名与 data：

| event | data |
|---|---|
| `reminder.due` | Todo |
| `todo.created` / `todo.updated` | Todo |
| `utterances.new` | `{count, chunk_id}` |
| `summary.created` | Summary |
| `recorder.status` | `{id, online, state}` |
| `ping` | 每 25 秒一次 |

### 3.9 系统
| 方法 路径 | 说明 |
|---|---|
| `GET /system/info` | `{version, role, data_dir, db_path, uptime_seconds, disk_free_bytes}` |
| `GET /healthz` | 无需登录，`{"status":"ok"}`（不在 `/api/v1` 下） |

---

## 4. 数据模型（Core）

核心表，字段为权威定义，索引由实现决定：

```
rooms(id, name, created_at)
recorders(id, name, room_id, token_hash, config_json, devices_json, status_json, version, last_seen, created_at)
chunks(id, recorder_id, room_id, started_at, duration, sha256, storage_key, status, attempts, next_attempt_at, error,
       audio_deleted, created_at, processed_at)
speakers(id, name, state, centroid BLOB, embedding_count, created_at, updated_at)
speaker_samples(id, speaker_id, storage_key, duration, source_utterance_id, created_at)
utterances(id, chunk_id, room_id, started_at, ended_at, text, lang, speaker_id, confidence, embedding BLOB, created_at)
utterances_fts            -- FTS5，tokenize='trigram'，content=utterances
summaries(id, level, range_start, range_end, room_id, title, content, model, utterance_count, created_at)
summary_jobs(id, level, range_start, range_end, room_id, status, error, summary_id, created_at, finished_at)
todos(id, text, status, assignee_speaker_id, due_at, remind_at, reminder_state, confidence, source, source_utterance_id,
      source_excerpt, created_at, updated_at, completed_at)
settings(key, value_json)            -- key 为一级分组名，如 "llm"
auth(id, password_hash, secret)      -- 单行
sessions(token_hash, created_at, expires_at)
```

## 5. 部署形态

- `ghcr.io`-风格镜像三个：`murmur-core`（含构建好的 web，`MURMUR_ROLE=all|api|worker`）、`murmur-asr`（CPU，GPU 变体用 CUDA 版 onnxruntime）、`murmur-recorder`
- Core 环境变量：`MURMUR_DATA_DIR`（默认 `./data`）、`MURMUR_DATABASE_URL`（默认 `sqlite:///{data_dir}/murmur.db`）、`MURMUR_SECRET_KEY`（加密 API Key，缺省时自动生成并保存在 data 目录）、`MURMUR_ROLE`、`MURMUR_HOST`/`MURMUR_PORT`、`MURMUR_ASR_URL` / `MURMUR_LLM_*`（仅作为首次启动的设置默认值）、`MURMUR_STORAGE`（`local` 或 `s3://bucket/prefix`）
- Recorder 环境变量：`MURMUR_CORE_URL`、`MURMUR_TOKEN`、`MURMUR_BUFFER_DIR`、`MURMUR_SOURCE`（`device` 默认，或 `file:/path.wav` 用于测试）
