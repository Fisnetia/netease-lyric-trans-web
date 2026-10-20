"""按歌名与歌手在网易云曲库中检索并匹配 songId。"""

from __future__ import annotations

import difflib
import re
import unicodedata

from .session import NcmClient

# 去掉 (feat. XXX) / 【官方版】 之类的括号补充说明
_BRACKET = re.compile(r"[\(\（\[\【][^\)\）\]\】]{0,60}[\)\）\]\】]")
_TAIL = re.compile(r"\b(feat|ft|with|ver|version|remaster(ed)?|single|album|mv)\b\.?", re.I)


def normalize(text: str | None) -> str:
    """归一化歌名/歌手，用于宽松比对。"""
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", str(text)).lower()
    s = _BRACKET.sub(" ", s)
    s = _TAIL.sub(" ", s)
    s = re.sub(r"[^\w\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+", " ", s, flags=re.UNICODE)
    return " ".join(s.split())


def search_songs(
    client: NcmClient, keyword: str, limit: int = 20, offset: int = 0
) -> list[dict]:
    """搜索歌曲，支持分页偏移量 offset。

    实测（2026-02）：/weapi/cloudsearch/get/web 匿名调用返回 code 50000005，
    而老的 api/search/get/web 匿名可用，所以以它为主、weapi 作为登录后的备选。
    """
    songs: list[dict] = []
    try:
        resp = client.get_json(
            "api/search/get/web",
            {"s": keyword, "type": 1, "limit": limit, "offset": offset, "total": True},
        )
        songs = (resp.get("result") or {}).get("songs") or []
    except Exception:
        songs = []
    if not songs and offset == 0:
        try:
            resp = client.weapi_post(
                "cloudsearch/get/web",
                {"s": keyword, "type": 1, "limit": limit, "offset": offset, "total": True},
            )
            songs = (resp.get("result") or {}).get("songs") or []
        except Exception:
            songs = []
    return [slim(s) for s in songs]


def search_page(
    client: NcmClient,
    title: str,
    artists: list[str] | None = None,
    *,
    limit: int = 20,
    offset: int = 0,
) -> dict:
    """搜一页并打分排序，供界面翻页用。

    返回 {candidates, has_more}。当返回数量达到 limit 时标记存在下一页。
    接口的 total 字段匿名调用时不一定给。
    """
    artists = artists or []
    keyword = " ".join([title, *artists]).strip()
    raw = search_songs(client, keyword, limit=limit, offset=offset)
    if not raw and artists:
        # 关键词带歌手有时搜不到，退回只用歌名
        raw = search_songs(client, title, limit=limit, offset=offset)
    for c in raw:
        c["score"] = score(title, artists, c)
    raw.sort(key=lambda c: c["score"], reverse=True)
    return {"candidates": raw, "has_more": len(raw) >= limit}


def slim(song: dict) -> dict:
    return {
        "id": song.get("id"),
        "name": song.get("name") or "",
        "artists": [a.get("name") for a in (song.get("ar") or song.get("artists") or [])],
        "album": (song.get("al") or song.get("album") or {}).get("name"),
        "duration_ms": song.get("dt") or song.get("duration"),
    }


def _title_score(want: str, cand: str) -> float:
    if not want or not cand:
        return 0.0
    if want == cand:
        return 1.0
    if want in cand or cand in want:
        return 0.85
    return difflib.SequenceMatcher(None, want, cand).ratio() * 0.7


def _artist_score(want: list[str], cand: list[str]) -> float:
    want = [w for w in (normalize(x) for x in want) if w]
    cand = [c for c in (normalize(x) for x in cand) if c]
    if not want or not cand:
        return 0.4  # 信息缺失时给中性分，不直接过滤
    best = 0.0
    for w in want:
        for c in cand:
            if w == c:
                return 1.0
            if w in c or c in w:
                best = max(best, 0.9)
            else:
                best = max(best, difflib.SequenceMatcher(None, w, c).ratio() * 0.6)
    return best


def score(want_title: str, want_artists: list[str], cand: dict) -> float:
    """歌名 + 歌手加权。

    # 未提供歌手信息时不按缺失扣分，避免同名歌曲低于匹配阈值。
    """
    t = _title_score(normalize(want_title), normalize(cand.get("name")))
    if not [a for a in want_artists if normalize(a)]:
        return round(t, 4)
    a = _artist_score(want_artists, cand.get("artists") or [])
    return round(t * 0.65 + a * 0.35, 4)


def match_song(
    client: NcmClient,
    title: str,
    artists: list[str] | None = None,
    *,
    limit: int = 20,
    accept: float = 0.85,
) -> dict:
    """返回 {status, best, candidates}。

    status: matched / ambiguous / not_found
      matched     最佳候选达到 accept 阈值，且明显领先第二名
      ambiguous   有候选但不够确定，需要人工从 candidates 里挑
      not_found   曲库里搜不到（例如歌曲还没上架）
    """
    artists = artists or []
    keyword = " ".join([title, *artists]).strip()
    candidates = search_songs(client, keyword, limit=limit)

    # 关键词带歌手有时会搜不到，退回只用歌名再搜一次
    if not candidates and artists:
        candidates = search_songs(client, title, limit=limit)

    for c in candidates:
        c["score"] = score(title, artists, c)
    candidates.sort(key=lambda c: c["score"], reverse=True)

    if not candidates:
        return {"status": "not_found", "best": None, "candidates": []}

    best = candidates[0]
    runner = candidates[1]["score"] if len(candidates) > 1 else 0.0
    if best["score"] >= accept and best["score"] - runner >= 0.05:
        status = "matched"
    else:
        status = "ambiguous"
    return {"status": status, "best": best, "candidates": candidates[:5]}
