# Murmur 规划

自托管的全天"环境秘书"：USB 麦克风持续录音 → 语音转文字（区分说话人）→ LLM 总结与待办抽取 → 局域网网页端查看。

## 1. 目标与边界

**v1 要做**

- 录音端：选择 USB 麦克风，持续采集，VAD 切片，推送给 Core；断网时本地缓存并补传
- 转写：中英混杂（默认），模型可配置，STT 可部署在另一台机器
- 说话人：自动聚类，网页上命名、合并、拆分、标记"忽略"；命名后自动识别
- 总结：对接任意 OpenAI 兼容 API；分层摘要（片段/小时/日）；触发时机可配置
- 待办：从对话抽取，直接生效，带原文出处；网页端提醒
- 网页端：配置、时间线、摘要、待办、说话人管理
- 隐私默认：音频转写并校验后即删，只留声纹向量和少量代表性短片段

**v1 不做（见第 9 节）**：账号权限、推送渠道、MCP/Skill、大屏、多语言扩展。

**假设**：单租户，仅局域网访问；一个访问密码保护网页端；开源后每人自行部署。

## 2. 架构

```
┌────────────┐  音频片段(HTTP)  ┌─────────────────────────┐  音频  ┌──────────────┐
│  Recorder  │ ───────────────► │          Core           │ ─────► │  ASR 服务     │
│ 采集+VAD    │ ◄─ 配置(轮询) ── │ API · 队列 · 调度 · Web  │ ◄───── │ 转写+说话人    │
│ 断点续传    │                  │ SQLite · 存储抽象         │        └──────────────┘
└────────────┘                  │                         │  chat  ┌──────────────┐
  可多台，每台=一个房间            └─────────────────────────┘ ─────► │ LLM(OpenAI兼容)│
                                                                    └──────────────┘
```

四个可独立部署的单元，通过 HTTP 通信，彼此只依赖契约：

| 单元 | 职责 | 备注 |
|---|---|---|
| `recorder` | 枚举声卡、采集、重采样 16 kHz 单声道、VAD、切片、上传、本地缓冲 | 可装宿主机或 Docker（透传 `/dev/snd`） |
| `core` | 接收音频、任务队列、调用 ASR 与 LLM、调度、存储、REST API、托管前端 | FastAPI；worker 为独立进程 |
| `asr` | 参考实现：转写 + 说话人分离 + 声纹向量，一次调用返回 | GPU 容器，可放别的机器；契约见第 4 节 |
| `web` | 管理与查看界面 | Vite + React，构建后由 Core 静态托管 |

## 3. 技术栈与 SQLite

- Python 3.10+，FastAPI，SQLAlchemy + Alembic，独立 worker 进程
- 前端 Vite + React + TypeScript
- 默认 SQLite（WAL 模式），通过 SQLAlchemy 保留换 Postgres 的退路

**SQLite 够不够**：够。写入量按每分钟一个音频片段、每片段几十条话语估算，一天只有几万行，且基本是单写入者（Core + worker）。WAL 允许读写并发。需要注意的三点：

1. 数据库文件必须放本机磁盘，不能放 NFS/SMB，否则锁会出问题
2. 全文检索用 FTS5 的 `trigram` 分词器，默认分词器对中文无效
3. 声纹向量以 BLOB 存，相似度用 numpy 暴力计算；几百个说话人以内毫无压力

## 4. 外部服务契约

### 4.1 STT（OpenAI 兼容）

`POST {base}/v1/audio/transcriptions`，`response_format=verbose_json`，返回带时间戳的 segments。这样 Speaches、whisper.cpp server、云端服务都能直接接。

### 4.2 说话人服务（可选）

```
POST {base}/v1/diarize        multipart: file
→ { "turns": [ { "start": 0.0, "end": 3.2, "label": "S1", "embedding": [..] } ] }
```

Core 按时间戳把 STT 的 segments 与 turns 合并。

### 4.3 一体化 ASR 服务

参考实现 `asr/` 一次调用返回"文字 + 说话人 + 声纹"：

```
POST {base}/v1/process
→ { "language": "zh", "utterances": [ { "start", "end", "text", "label", "embedding", "is_speech_prob" } ] }
```

选型靠 M0 实测决定，候选：Whisper large-v3 系 + pyannote，FunASR（SenseVoice/Paraformer + CAM++）。

## 5. 数据模型（草案）

| 表 | 主要字段 |
|---|---|
| `rooms` | id, name |
| `recorders` | id, room_id, token_hash, config(json), devices(json), last_seen |
| `audio_chunks` | id, recorder_id, started_at, duration, path, sha256, status(pending/processing/done/failed), attempts, error |
| `utterances` | id, chunk_id, started_at, ended_at, speaker_id, text, lang, confidence |
| `speakers` | id, name, state(unnamed/named/ignored), centroid(blob), created_at |
| `speaker_embeddings` | id, speaker_id, utterance_id, vector(blob) |
| `speaker_samples` | id, speaker_id, path, duration |
| `summaries` | id, level(hour/day/custom), range_start, range_end, room_id?, content, model, created_at |
| `todos` | id, text, assignee_speaker_id?, due_at?, remind_at?, status(open/done/dismissed), confidence, source_utterance_id |
| `settings` | key, value(json, 敏感项加密) |

`utterances_fts`：FTS5 虚拟表（trigram）。

## 6. 关键流程

**音频生命周期**
1. 录音端切片上传 → `audio_chunks.status=pending`
2. worker 调 ASR → 写入 `utterances`、声纹向量，同一事务内标记 `done`
3. 校验：落库成功且 sha256 一致 → 删除原始音频
4. 任一步失败：不删音频，计数重试，超过上限标 `failed` 等人工处理

**说话人**
- 新话语的声纹与已命名说话人比对，超过阈值则归属；否则与未命名聚类比对；都不匹配则新建聚类
- 每个聚类保留代表性短片段（默认 5 段 × 约 5 秒，可配置），供网页回听
- 合并：声纹与话语并入目标说话人，样本去重后截断；拆分：按话语重新归属
- "忽略"：该说话人后续话语不转写入库（用于电视、广播里的固定声音）

**非人声过滤**：录音端 VAD 之外，Core 侧可选启用语音/音乐/噪声分类；开关在网页设置里。另加转写幻觉过滤（重复文本、极低置信度）。

**摘要调度**（每个策略独立开关）
- 增量：每 N 分钟或攒够 M 条话语，总结新内容
- 小时：整点汇总
- 日报：每天固定时间（默认 23:30）
- 手动：网页上对任意时间段重跑
- 空闲触发：连续 K 分钟没有说话时汇总上一段

**待办抽取**：LLM 结构化输出（JSON schema），输入含对话时间与时区以解析"明天下午三点"；低于置信度阈值不创建；与已有待办做相似度去重；每条带来源话语。

**提醒**：网页端轮询或 SSE，到 `remind_at` 时弹出横幅并响铃，需用户点确认。

## 7. 配置

环境变量给默认值，网页设置页可覆盖，敏感项（API Key）加密落库。

| 范围 | 配置项 |
|---|---|
| 录音端 | 设备选择、增益、VAD 灵敏度、片段时长、房间归属、Core 地址与 token |
| 存储 | 数据目录、音频临时目录、代表性片段数量与时长 |
| ASR | 服务地址、模型、语言提示、是否启用说话人服务 |
| LLM | base URL、API Key、模型、提示词模板、输出语言 |
| 调度 | 各摘要策略的开关与参数 |
| 过滤 | 非人声过滤开关、幻觉过滤阈值 |
| 待办 | 置信度阈值、去重阈值 |

## 8. 路线图

| 阶段 | 内容 | 验收 | 状态（v0.1.0） |
|---|---|---|---|
| **M0 实测** | 摄像头麦在客厅真实录 1–2 小时；对比候选 ASR 的中英混杂准确率、说话人区分、幻觉率、延迟；确定 VAD 参数 | 一份实测报告，选定默认 ASR 方案 | **未做**：需要真实麦克风。已用合成语音和 sherpa 样例选定 SenseVoice + CAM++，数据见 asr/README.md |
| **M1 采集转写链路** | recorder、Core 接收与队列、ASR 契约与参考容器、转写入库、校验后删音频、重试 | 连续 24 小时不丢、不堆积 | 已实现并通过测试与离线端到端；24 小时实测未做 |
| **M2 说话人体系** | 聚类与识别、声纹入库、代表性片段、命名/合并/拆分/忽略 API | 命名后新话语自动标注 | 已完成 |
| **M3 总结与待办** | LLM 适配器、分层摘要、调度策略、待办抽取与去重 | 自动产出日报与待办 | 已完成（只用 mock LLM 验证过，真实模型待测） |
| **M4 Web 后台** | 登录、配置页、时间线、摘要、搜索、待办与提醒、说话人管理（含回听） | 全部配置无需改文件 | 已完成 |
| **M5 部署加固** | docker-compose（core/worker/recorder/asr 分开）、备份、日志与监控、文档、CI | 一条命令部署，ASR 在另一台机器可用 | compose 与镜像已完成；备份、监控、CI 未做（见 BACKLOG） |

## 9. 后续待办（v1 之外）

- 推送提醒渠道：ntfy、Bark、Telegram、Webhook
- 账号与权限体系（多成员、谁能看谁的对话）
- MCP server 与 Skill，让外部 agent 读取转写和摘要
- 大屏汇总页面
- 其他语言与更多 STT 模型适配器
- 更好的麦克风、回声消除
- 按房间/按人的摘要视图

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 摄像头麦远场收音弱、AGC 失真 | M0 实测量化，给出是否升级硬件的结论；软件不绑定硬件 |
| 电视人声被当成说话人 | "忽略此说话人"；说话人聚类自然把固定声音归在一起 |
| Whisper 在静音和噪声上幻听 | 前置 VAD、语音/非语音分类、重复与低置信度过滤 |
| 中英混杂识别不稳 | 模型可配置；M0 对比后选默认 |
| 待办误报 | 置信度阈值、去重、原文出处、一键删除 |
| 音频删除后无法核对说话人 | 保留少量代表性片段 |
| 声纹属于生物特征数据 | 只存向量，不存可还原的音频；网页仅限局域网；文档里写明部署者责任 |
