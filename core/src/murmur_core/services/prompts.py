"""Default prompt templates. Users can override each one in Settings → LLM → prompts.

Placeholders: {start} {end} {rooms} {now} {language} {transcript} {todos}. Unknown braces are left alone.
"""

from __future__ import annotations

import re

SUMMARY_ZH = """你是一位细心的私人秘书，正在整理一段环境录音的转写记录。

时间范围：{start} 至 {end}
地点：{rooms}

请用{language}写一份简洁、准确的对话摘要（Markdown）：
- 先用一两句话概括这段时间发生了什么
- 然后分条列出重要的话题、决定、约定和需要跟进的事情，标明是谁说的（如果转写里有人名）
- 不要编造转写里没有的内容；听不清或不确定的地方直接略过
- 闲聊、背景噪声、重复的内容可以一笔带过
- 如果这段记录几乎没有有价值的内容，只写一句话说明即可

转写记录：
{transcript}
"""

SUMMARY_EN = """You are a careful personal secretary summarising a transcript of ambient conversation recorded at home or in a studio.

Time range: {start} to {end}
Location: {rooms}

Write a concise, accurate summary in {language} (Markdown):
- Start with one or two sentences on what happened in this period
- Then list the important topics, decisions, commitments and follow-ups as bullets, naming who said what when speaker names are available
- Do not invent anything that is not in the transcript; skip what is unclear
- Small talk, background chatter and repetition can be mentioned briefly
- If there is almost nothing of value, say so in one sentence

Transcript:
{transcript}
"""

DAILY_ZH = """你是一位细心的私人秘书，请根据下面一整天的对话转写，用{language}写一份日报（Markdown）。

日期范围：{start} 至 {end}
地点：{rooms}

建议结构（没有内容的部分可以省略）：
## 今日概览
两到三句话概括这一天。
## 重点与话题
按主题分组，列出重要内容，标明谁参与、大致什么时间。
## 决定与约定
## 待跟进
今天提到的待办事项（下面「已识别的待办」仅供参考，可补充遗漏、不要重复罗列琐碎项）。
## 有意思的片段
可选，一两条。

要求：只依据转写内容，不要编造；语气自然简洁。

已识别的待办：
{todos}

转写记录：
{transcript}
"""

DAILY_EN = """You are a careful personal secretary. From the full-day transcript below, write a daily digest in {language} (Markdown).

Date range: {start} to {end}
Location: {rooms}

Suggested structure (omit empty sections):
## Overview
Two or three sentences about the day.
## Highlights and topics
Grouped by theme, naming who took part and roughly when.
## Decisions and commitments
## Follow-ups
To-dos mentioned today (the "Detected to-dos" below are a hint; add anything missing, skip trivia).
## Moments worth remembering
Optional, one or two.

Rely only on the transcript; do not invent. Keep the tone natural and brief.

Detected to-dos:
{todos}

Transcript:
{transcript}
"""

REDUCE_ZH = """下面是同一时间范围（{start} 至 {end}）内按时间顺序分段生成的多份摘要。请把它们合并成一份完整、不重复的{language}摘要（Markdown），保留重要的决定、约定与跟进事项。

{transcript}
"""

REDUCE_EN = """Below are several partial summaries covering the same time range ({start} to {end}), in chronological order. Merge them into one complete, non-repetitive summary in {language} (Markdown), keeping important decisions, commitments and follow-ups.

{transcript}
"""

TODOS_ZH = """你负责从环境录音转写中提取待办事项。

当前时间：{now}（时区已包含在内）
地点：{rooms}

规则：
- 只提取明确的承诺、请求、需要做的事或约好的日程（如「明天下午三点开会」「记得给小李回电话」「周五前把报告发出去」）
- 不要把闲聊、已经完成的事、抽象的想法或新闻当作待办
- `text` 用{language}写成一句简短的行动描述
- `assignee` 必须是转写中出现的说话人名字之一；无法确定时为 null
- `due` 为截止或事件时间，使用带时区偏移的 ISO 8601（例如 2026-11-12T15:00:00+08:00）；根据「当前时间」换算「明天」「周五」等相对时间；没有时间则为 null
- `remind` 仅当对话明确要求在某个时间提醒时填写，否则为 null
- `ref` 是该待办来源的那一行转写开头的编号（整数）
- `confidence` 为 0 到 1 之间的把握程度
- 上下文行（标记为 context）只用于理解，不要从中提取待办
- 没有待办时返回空数组

只输出一个 JSON 对象，格式：
{{"todos": [{{"text": "...", "assignee": null, "due": null, "remind": null, "ref": 123, "confidence": 0.8}}]}}

转写记录：
{transcript}
"""

TODOS_EN = """You extract to-do items from ambient-recording transcripts.

Current time: {now} (timezone included)
Location: {rooms}

Rules:
- Extract only explicit commitments, requests, things that need doing, or scheduled events (e.g. "meeting tomorrow at 3pm", "remember to call Li back", "send the report by Friday")
- Do not turn small talk, finished actions, vague ideas or news into to-dos
- `text`: a short action description in {language}
- `assignee`: must be one of the speaker names appearing in the transcript, or null if unclear
- `due`: deadline or event time as ISO 8601 with timezone offset (e.g. 2026-11-12T15:00:00+08:00); resolve "tomorrow", "Friday" etc. against the current time; null if none
- `remind`: only when the conversation explicitly asks to be reminded at a time, otherwise null
- `ref`: the integer id at the start of the transcript line the to-do came from
- `confidence`: 0 to 1
- Lines marked "context" are only for understanding; do not extract from them
- Return an empty array when there are none

Output a single JSON object:
{{"todos": [{{"text": "...", "assignee": null, "due": null, "remind": null, "ref": 123, "confidence": 0.8}}]}}

Transcript:
{transcript}
"""

_DEFAULTS = {
    "summary": {"zh": SUMMARY_ZH, "en": SUMMARY_EN},
    "daily": {"zh": DAILY_ZH, "en": DAILY_EN},
    "reduce": {"zh": REDUCE_ZH, "en": REDUCE_EN},
    "todos": {"zh": TODOS_ZH, "en": TODOS_EN},
}

LANGUAGE_NAMES = {"zh": "中文", "en": "English", "ja": "日本語", "ko": "한국어", "fr": "Français", "de": "Deutsch", "es": "Español"}


def default_prompt(kind: str, output_language: str) -> str:
    lang = "zh" if output_language.startswith("zh") else "en"
    text = _DEFAULTS[kind][lang]
    # The shipped templates escape literal braces for str.format; ours are substituted by regex, so unescape.
    return text.replace("{{", "{").replace("}}", "}")


_PLACEHOLDER = re.compile(r"\{(start|end|rooms|now|language|transcript|todos)\}")


def render(template: str, **values: str) -> str:
    return _PLACEHOLDER.sub(lambda m: str(values.get(m.group(1), "")), template)


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code.split("-")[0], code)
