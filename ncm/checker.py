"""歌词对齐与格式诊断模块。

对齐本地译文与带轴原文，调用官方校验接口进行时间轴合规性体检，生成结构化诊断报告。
纯只读分析，不包含任何投稿或写操作。
"""

from __future__ import annotations

import pathlib

from . import transfile, wiki
from .lyric import fetch_lyric, song_detail
from .session import NcmClient, NcmError


def prepare(
    client: NcmClient,
    song_id: int,
    trans_path: str | pathlib.Path | None = None,
    *,
    trans_text: str | None = None,
    tolerance_ms: int = 60,
    auto_reflow: bool = False,
    source_path: str | pathlib.Path | None = None,
    source_lines: list[str] | None = None,
) -> dict:
    """对齐 + 格式校验，返回完整诊断报告。不写入任何数据。"""
    lyric = fetch_lyric(client, song_id)
    if not lyric.get("ok"):
        raise NcmError(f"取歌词失败: {lyric.get('code')}")

    if trans_text is not None:
        parsed = transfile.parse_text(trans_text, label=(str(trans_path) if trans_path else "工作区文稿"))
        src_file = pathlib.Path(source_path) if source_path else None
    else:
        if not trans_path:
            raise NcmError("缺少待体检的译文内容")
        parsed = transfile.load(trans_path)
        src_file = pathlib.Path(source_path) if source_path else transfile.find_source_file(trans_path)

    src_note = ""
    if source_lines is None and src_file and src_file.exists():
        source_lines = transfile.load_source_lines(src_file, expect=len(parsed.lines))
        if len(source_lines) != len(parsed.lines):
            src_note = (
                f"⚠ 原文 {len(source_lines)} 行 ≠ 译文 {len(parsed.lines)} 行，"
                f"无法一一对应，已退回启发式对轴"
            )
            source_lines = None

    al = transfile.align(
        parsed,
        lyric["original"],
        tolerance_ms=tolerance_ms,
        auto_reflow=auto_reflow,
        source_lines=source_lines,
    )

    style = transfile.detect_time_style(lyric["original"])
    trans_lrc = al.trans_lrc(style=style)

    detail = song_detail(client, song_id) or {}
    duration = detail.get("duration_ms")

    check = None
    if duration:
        probe = trans_lrc if style == "dot" else transfile.to_style(trans_lrc, "dot")
        try:
            check = wiki.check_lyric(client, probe, duration, kind="trans")
            check["probed_style"] = "dot"
            check["submit_style"] = style
        except Exception as e:
            check = {
                "result": None,
                "message": f"检查接口异常：{type(e).__name__}: {e}",
                "fail_columns": [],
                "error": True,
            }

    channel = None
    try:
        _d = wiki.song_get(client, song_id)
        if _d:
            ft = _d.get("forTransLyric")
            tl = _d.get("transLyricLock")
            orig = bool((_d.get("lyricContent") or "").strip())
            has = bool((_d.get("transLyricContent") or "").strip())
            channel = {
                "forTransLyric": ft,
                "transLyricLock": tl,
                "has_translation": has,
                "has_original": orig,
                "open": (orig and tl in (0, None) and not has),
            }
    except Exception:
        channel = None

    return {
        "song_id": song_id,
        "song": detail,
        "duration_ms": duration,
        "channel": channel,
        "source_file": str(src_file) if src_file else None,
        "source_lines": len(source_lines) if source_lines else 0,
        "source_note": src_note,
        "file": str(trans_path),
        "parsed": {
            "has_time": parsed.has_time,
            "bilingual": parsed.bilingual,
            "lines": len(parsed.lines),
        },
        "alignment": {
            "exact": al.exact,
            "fuzzy": al.fuzzy,
            "missing": len(al.missing),
            "extra": len(al.extra),
            "ok": al.ok,
            "missing_lines": [
                {"time": transfile.format_time(o["time_ms"]), "text": o["text"]} for o in al.missing
            ],
            "extra_lines": [
                {
                    "time": transfile.format_time(l.time_ms) if l.time_ms else None,
                    "text": l.text,
                }
                for l in al.extra
            ],
            "view": transfile.mismatch_view(al),
        },
        "online": {
            "has_translation": bool(lyric.get("translation")),
            "trans_user": lyric.get("trans_user"),
            "lyric_user": lyric.get("lyric_user"),
        },
        "check": check,
        "trans_lrc": trans_lrc,
        "time_style": style,
        "reflow": (
            {
                "confidence": round(al.reflow.confidence, 3),
                "ops": [
                    {"kind": o.kind, "detail": o.detail, "score": round(o.score, 3)}
                    for o in al.reflow.ops
                ],
            }
            if al.reflow is not None
            else None
        ),
    }
