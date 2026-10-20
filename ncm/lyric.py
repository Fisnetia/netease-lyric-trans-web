"""读取歌曲详情与官方原文歌词/翻译。

只读查询：获取曲目信息、线上原文歌词及已有翻译贡献者。
"""

from __future__ import annotations

import json
import re

from .session import NcmClient

# [mm:ss.xx] 或 [mm:ss.xxx]，网易云也用 [mm:ss:xx]
_TIME = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def fetch_lyric(client: NcmClient, song_id: int) -> dict:
    # lv/kv/tv/rv 置入加密 body，避免接口返回空歌词
    # （实测 2026-02：body 里没有时 lrc.lyric 长度为 0，code 仍是 200，极易误判）。
    body = {"id": song_id, "lv": -1, "kv": -1, "tv": -1, "rv": -1}
    resp = client.weapi_post(
        "song/lyric",
        body,
        query={"lv": -1, "kv": -1, "tv": -1},
    )
    if resp.get("code") not in (200, None):
        return {"ok": False, "code": resp.get("code"), "raw": resp}
    return {
        "ok": True,
        "code": resp.get("code", 200),
        "original": (resp.get("lrc") or {}).get("lyric") or "",
        "translation": (resp.get("tlyric") or {}).get("lyric") or "",
        "roman": (resp.get("romalrc") or {}).get("lyric") or "",
        "lyric_user": (resp.get("lyricUser") or {}).get("nickname"),
        "trans_user": (resp.get("transUser") or {}).get("nickname"),
        "has_translation": bool((resp.get("tlyric") or {}).get("lyric")),
        "pure_music": bool(resp.get("pureMusic")),
    }


def song_detail(client: NcmClient, song_id: int) -> dict:
    payload = {"c": json.dumps([{"id": song_id}], separators=(",", ":"))}
    resp = client.weapi_post("v3/song/detail", payload)
    songs = resp.get("songs") or []
    if not songs:
        return {}
    s = songs[0]
    return {
        "id": s.get("id"),
        "name": s.get("name"),
        "artists": [a.get("name") for a in (s.get("ar") or [])],
        "album": (s.get("al") or {}).get("name"),
        "pic_url": (s.get("al") or {}).get("picUrl"),
        "duration_ms": s.get("dt"),
    }


def parse_lrc(text: str) -> list[dict]:
    """把 LRC 拆成 [{time_ms, text}]，忽略空行与元信息标签。"""
    out: list[dict] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        stamps = list(_TIME.finditer(line))
        content = _TIME.sub("", line).strip()
        if not stamps:
            continue  # 无时间轴的行（作词/作曲标签）跳过
        for m in stamps:
            minute = int(m.group(1))
            second = int(m.group(2))
            frac = m.group(3) or "0"
            ms = int(frac.ljust(3, "0")[:3])
            out.append({"time_ms": (minute * 60 + second) * 1000 + ms, "text": content})
    out.sort(key=lambda x: x["time_ms"])
    return out


def timed_lines(text: str) -> list[dict]:
    """只保留有时间轴且有文字的行，用于对齐对比。"""
    return [x for x in parse_lrc(text) if x["text"]]


# 网易云 LRC 中带时间轴的元信息行（如作词、作曲、编曲等），翻译稿中无需包含。
CREDIT_LABELS = {
    "作词", "作曲", "编曲", "制作人", "监制", "出品", "发行", "混音", "母带", "录音",
    "吉他", "贝斯", "鼓", "键盘", "钢琴", "弦乐", "和声", "配唱", "人声", "统筹",
    "企划", "op", "sp", "词", "曲", "编", "制作", "录音室", "录音师", "封面", "设计",
    "文案", "宣发", "翻译", "校对", "美工", "视觉", "导演", "摄影", "后期", "旁白",
    "program", "arrange", "compose", "lyric", "producer", "mix", "master",
    # 日文元信息标签（例如 "作詞・作曲：Artist"）
    "作詞", "作曲", "編曲", "製作", "制作総指揮", "訳詞", "翻訳", "歌", "唄", "演奏",
    "ギター", "ベース", "ドラム", "ピアノ", "弦楽", "録音", "調整", "監修", "発売",
    "プロデュース", "ミックス", "マスタリング", "イラスト", "動画", "映像", "絵",
    "作詞作曲", "作曲作詞",
    # 韩文写法
    "작사", "작곡", "편곡", "보컬", "기타", "베이스", "드럼", "피아노", "믹싱", "마스터링",
}

# 注意间隔号 U+30FB（・）位于片假名编码区，
# 排除片假名间隔号，避免元信息行被判为歌词
_KANA = re.compile(r"[\u3040-\u30fa\u30fc-\u30ff]")
_HANGUL = re.compile(r"[\uac00-\ud7af\u1100-\u11ff]")
_SEP = re.compile(r"^\s*([^:：]{1,15})\s*[:：]\s*\S")


def is_credit_line(text: str) -> bool:
    """判断是否为无需翻译的元信息行。

    判据一：标签命中已知列表（含日文/韩文写法）。
    判据二：冒号前的标签中不包含假名或谚文。例如 "君の名は : 呼んで" 类
            歌词不会被误判，而 "作詞・作曲：Artist" 类信息能够被正确识别。
    """
    m = _SEP.match(text)
    if not m:
        return False
    label = m.group(1).strip().lower()
    if label in CREDIT_LABELS or label.replace("・", "").replace(" ", "") in CREDIT_LABELS:
        return True
    return not _KANA.search(label) and not _HANGUL.search(label)


# 间奏或非歌词标记行，例如 -music-、间奏、前奏等。
# 此类行保留时间轴槽位，但无需填入翻译文本。
_MARKER_WORDS = {
    "music", "instrumental", "inst", "interlude", "solo", "guitar", "guitar solo",
    "break", "bridge", "intro", "outro", "chorus", "verse", "prelude", "riff",
    "no lyrics", "nolyrics", "melody",
    "间奏", "前奏", "尾奏", "間奏", "伴奏", "纯音乐", "純音樂", "音乐", "音樂",
    "无歌词", "無歌詞", "无人声", "無人聲", "演奏",
}
_MARKER_WRAP = re.compile(r"^[\s\-–—_=~*·【\[（(「『]+|[\s\-–—_=~*·】\]）)」』]+$")
_ONLY_SYMBOLS = re.compile(r"^[\s\-–—_=~*·.。、…・【】\[\]（）()「」『』]+$")
_MARKER_NORM = {w.replace(" ", "") for w in _MARKER_WORDS}


def is_non_lyric_marker(text: str) -> bool:
    """判断是否为非歌词标记行（间奏/前奏/纯符号等）。

    判据：剥掉首尾的横线/括号等包裹字符后，剩下的刚好是一个已知标记词；
    或者整行只有符号。

    注意：避免将以连字符开头的正常歌词行误判为标记行。
    """
    t = (text or "").strip()
    if not t:
        return True
    if _ONLY_SYMBOLS.match(t):
        return True
    core = _MARKER_WRAP.sub("", t).strip().lower()
    core = re.sub(r"\s+", " ", core)
    return core.replace(" ", "") in _MARKER_NORM


def translatable_lines(original_lrc: str) -> list[dict]:
    """需要占位的行（按时间轴排序）：所有带时间轴的行。

    包含作词/作曲等元信息行、-music- 这类标记行、以及纯空白行。
    元信息与标记行在输出时留空，保证与官方原文时间轴逐行对应。
    """
    return parse_lrc(original_lrc)


def content_lines(original_lrc: str) -> list[dict]:
    """真正需要用户译文的行（排除标记行与纯空白行）。"""
    return [
        x
        for x in parse_lrc(original_lrc)
        if not (x["text"] and is_credit_line(x["text"])) and not is_non_lyric_marker(x["text"])
    ]


def summary(lyric: dict) -> str:
    if not lyric.get("ok"):
        return f"歌词接口返回异常: {lyric.get('code')}"
    orig = timed_lines(lyric["original"])
    trans = timed_lines(lyric["translation"])
    lines = [
        f"原文行数: {len(orig)}",
        f"现有翻译行数: {len(trans)}",
        f"翻译贡献者: {lyric.get('trans_user') or '（无）'}",
        f"歌词贡献者: {lyric.get('lyric_user') or '（无）'}",
    ]
    if lyric.get("pure_music"):
        lines.append("纯音乐，无歌词")
    return "\n".join(lines)
