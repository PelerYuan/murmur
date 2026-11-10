# Murmur

自托管的全天“环境秘书”。USB 麦克风持续录音，语音转文字并区分说话人，再由大模型生成摘要和待办。全部跑在你自己的硬件上，通过仅限局域网的网页端查看。[English](README.md)

> **状态：v0.1.0，第一个可用版本。**从录音端到网页端的整条链路已经跑通并有测试覆盖，但还没有接真实的 USB 麦克风连续跑过一整天。详见[验证情况](#验证情况)。

## 工作方式

```
 USB 麦克风 ──► recorder ──HTTP──► core ──HTTP──► asr（可放在 GPU 机器上）
 （任意主机）    VAD、本地缓冲      队列、说话人、     语音转文字 + 声纹
                                   摘要、待办
                                     │  ▲
                                网页端  └── 任意 OpenAI 兼容的 LLM
```

- **recorder**：跑在插着麦克风的那台机器上，每个房间一个。检测到说话才切片上传，网络断了就先存在本地缓冲里。
- **core**：转写结果存在 SQLite，负责说话人匹配、摘要和待办的调度、提醒，以及托管网页端。
- **asr**：把一段 WAV 变成带时间戳的话语，每句附一个声纹向量（sherpa-onnx：SenseVoice 负责中英日韩粤，CAM++ 负责声纹）。默认用 CPU，可切 CUDA。core 也能接任意 OpenAI 兼容的 STT 接口，只是这样没有说话人区分。
- **web**：单页应用，有概览、时间线（可搜索、可回听样本）、摘要、待办与提醒、说话人管理、录音端与设置页、首次使用引导，支持中英文、深浅色和手机布局。

组件之间只用 HTTP 通信，接口约定见 [docs/API.md](docs/API.md)。

## 设计目标

- **每一层都可替换**：录音端放哪、音频存本地还是 S3、STT 服务、LLM 地址、摘要时机（增量、每小时、每天、空闲时、手动）都是配置，不用改代码。
- **说话人是核心对象**：自动聚类声音，在网页上命名、合并、拆分或忽略（比如把电视里的人声标成忽略），可以听留下的几段样本再下判断。命名后的声音之后自动识别。
- **音频不久留**：转写入库并校验通过后才删除原始音频，只保留声纹向量和每个说话人的少量短样本。
- **出错也平淡**：分片上传幂等，处理失败会重试；ASR 或 LLM 挂了，只是结果晚一点出来。

## 快速开始（Docker）

```bash
git clone https://github.com/PelerYuan/murmur && cd murmur/deploy
cp .env.example .env                        # 填 LLM 地址，可选填密钥
docker compose --profile asr up -d --build  # 在本机同时起 core 和 asr
```

打开 `http://<服务器>:8000`，设置密码，跟着引导走。在“录音端与房间”里新建录音端，然后到插麦克风的机器上：

```bash
cd recorder && uv venv --python 3.10 .venv && uv pip install --python .venv/bin/python -e .
MURMUR_CORE_URL=http://<服务器>:8000 MURMUR_TOKEN=<网页里显示的令牌> .venv/bin/murmur-recorder
```

也可以在那台机器上 `docker compose --profile recorder up -d`（需要透传 `/dev/snd`）。想把 ASR 放到 GPU 机器上，在那里运行 `asr` 镜像（见 [asr/README.md](asr/README.md)），再到“设置 → 语音识别”里填它的地址。

没有麦克风和 LLM 也能试：`scripts/e2e.sh` 会把一段合成的家庭对话交给真实的 ASR，LLM 用 mock 代替；`core/scripts/seed_demo.py` 会生成几天的演示数据，方便看界面。

## 验证情况

- core：50 个自动化测试，覆盖流水线、说话人、摘要、待办、调度、本地与 S3 存储、SSE、登录。
- recorder：63 个测试，另外通过 ALSA 回环设备做过真实采集，容器内也跑过。
- asr：116 个测试，用的是真实模型；8 核 CPU 上实时率约 0.04，中文样本字错率为 0。
- web：类型检查通过，116 个单元测试，每个页面在桌面和手机宽度、浅色和深色下都人工看过。
- 端到端：一段 4 人中文对话得到了 4 个说话人；新声音的第一句如果很短，可能暂时没有归属。双语说话人可能按语言拆成两个说话人（跨语言的声纹相似度偏低），在网页上点一次合并即可。
- core、asr、recorder 三个镜像都能构建，core 加 asr 通过 compose 一起跑通。

还没验证的部分：真实的 USB 麦克风或摄像头麦（增益、热插拔）、CUDA、`tiny` 以上的 Whisper 模型，以及真实的 LLM（只测了 OpenAI 请求和响应的格式，用的是 mock）。

## 文档

[docs/PLAN.md](docs/PLAN.md) 设计与路线图 · [docs/API.md](docs/API.md) 接口约定 · [docs/PRODUCT.md](docs/PRODUCT.md) 产品说明 · [docs/BACKLOG.md](docs/BACKLOG.md) 后续计划 · [CHANGELOG.md](CHANGELOG.md)

隐私提示：Murmur 会录下人的声音。请只在可信的局域网里使用，告知在场的人，并遵守当地法律。声纹属于生物特征数据。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
