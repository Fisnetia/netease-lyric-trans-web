"""网易云 UGC 百科与歌词公开查询接口层。

仅包含只读查询与官方歌词格式校验接口，不包含任何投稿写入与任务中心操作。
"""

from __future__ import annotations

from .session import NcmClient, NcmError

BASE = "https://music.163.com"

EP_CHECK = "/api/music/wiki/ugc/lyric/check"
EP_SONG_GET = "/api/rep/ugc/song/get"
EP_SONG_INFO = "/api/rep/ugc/song/info/id/get"
EP_SEARCH_SONG = "/api/v1/search/song/get"

OK_CODES = {200, 206}


def _wiki_headers(song_id: int | None = None) -> dict:
    ref = f"{BASE}/st/wiki/song" + (f"?songId={song_id}" if song_id else "")
    return {
        "Referer": ref,
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
    }


def _handle(resp: dict, what: str) -> dict:
    code = resp.get("code")
    if code not in OK_CODES:
        raise NcmError(f"{what} 失败: code={code} message={resp.get('message')}")
    return resp


def check_lyric(
    client: NcmClient,
    content: str,
    duration_ms: int,
    *,
    kind: str = "lrc",
) -> dict:
    """调用官方格式校验接口（只读，匿名可用）。"""
    params = {"type": kind, "content": content, "duration": int(duration_ms)}
    r = client.http.get(BASE + EP_CHECK, params=params, headers=_wiki_headers(), timeout=60)
    r.raise_for_status()
    resp = r.json()
    data = resp.get("data") or {}
    if resp.get("code") == 400 and not data:
        raise NcmError(f"校验接口拒绝: {resp.get('message')}")
    return {
        "result": bool(data.get("result")),
        "message": data.get("message") or resp.get("message") or "",
        "fail_columns": data.get("failColumns") or [],
        "code": resp.get("code"),
    }


def song_get(client: NcmClient, song_id: int) -> dict:
    """读取单曲资料详情（含线上原文与翻译）。"""
    h = _wiki_headers(song_id)
    r = client.http.post(BASE + EP_SONG_GET, data={"songId": song_id}, headers=h, timeout=30)
    r.raise_for_status()
    resp = r.json()
    _handle(resp, "song/get")
    return resp.get("data") or {}


def song_info_by_id(client: NcmClient, song_id: int) -> dict:
    """通过歌曲 ID 查询百科元信息。"""
    h = _wiki_headers(song_id)
    r = client.http.get(BASE + EP_SONG_INFO, params={"songId": song_id}, headers=h, timeout=30)
    r.raise_for_status()
    resp = r.json()
    _handle(resp, "song/info/id/get")
    return resp.get("data") or {}


def search_song(client: NcmClient, song_name: str) -> list[dict]:
    """通过百科搜索接口搜索歌曲。"""
    h = _wiki_headers()
    r = client.http.get(BASE + EP_SEARCH_SONG, params={"s": song_name}, headers=h, timeout=30)
    r.raise_for_status()
    resp = r.json()
    return ((resp.get("result") or {}).get("songs")) or []
