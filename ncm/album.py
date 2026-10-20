"""专辑级发现：艺人 -> 新专辑 -> 曲目 -> 自动匹配本地译文文件。

接口（均实测可用，明文 /api/，不需要加密）：
    GET /api/search/get/web?s=<艺人名>&type=100      -> result.artists [{id, name}]
    GET /api/artist/albums/<artistId>?limit=N        -> hotAlbums [{id, name, publishTime, size}]
    GET /api/album/<albumId>                         -> album.songs [{id, name}]
"""

from __future__ import annotations

import difflib
import pathlib
import re

from .match import normalize
from .session import BASE, NcmClient, NcmError

# 匹配曲目名时，先移除文件名中的译文后缀标识
_FILE_SUFFIX = re.compile(
    r"[\s_\-]*[\(\（\[\【]?\s*(翻译|譯文|译文|中文翻译|trans|translation)\s*[\)\）\]\】]?\s*$",
    re.I,
)


def search_artist(client: NcmClient, name: str, limit: int = 10) -> list[dict]:
    """按名字搜歌手。

    # 搜索结果可能包含同名或关联艺人，优先筛选名称一致的项。
    包含名字、别名、译名、专辑数、单曲数等字段。
    """
    resp = client.get_json(
        "api/search/get/web", {"s": name, "type": 100, "limit": limit, "offset": 0, "total": True}
    )
    # 区分无搜索结果与频控限制（code 405），避免误报
    code = resp.get("code")
    if code not in (200, None) or (resp.get("msg") and not resp.get("result")):
        raise NcmError(
            f"搜歌手接口被挡：code={code} {resp.get('message') or resp.get('msg') or ''}"
        )
    artists = (resp.get("result") or {}).get("artists") or []
    return [
        {
            "id": a.get("id"),
            "name": a.get("name"),
            "alias": a.get("alias") or [],
            "trans": a.get("trans"),
            "album_size": a.get("albumSize"),
            "music_size": a.get("musicSize"),
            "pic": a.get("picUrl"),
        }
        for a in artists
    ]


def pick_artist(cands: list[dict], want: str) -> tuple[dict | None, str]:
    """从候选里挑一个，并说明凭什么挑的（返回 (候选, 理由)）。

    规则：**同名优先**；同名有多个时取专辑数最多的（更像那个"正经艺人"）；
    没有任何同名才退回到第一个（模糊匹配），并明确标出这是猜的。
    """
    if not cands:
        return None, "没有候选"
    same = [c for c in cands if (c.get("name") or "").strip() == want.strip()]
    if len(same) == 1:
        return same[0], "同名匹配"
    if len(same) > 1:
        best = max(same, key=lambda c: c.get("album_size") or 0)
        others = [c for c in same if c is not best]
        return best, (
            f"有 {len(same)} 个同名的，挑了专辑数最多的那个（{best.get('album_size')} 张）"
            f"；另几个同名的是 id={'、'.join(str(c.get('id')) for c in others[:4])}"
        )
    first = cands[0]
    return first, (
        f"无同名候选，使用相关度最高的搜索结果，"
        f"很可能不是你想要的 —— 请核对该艺人的名字，或从候选里指定"
    )


def artist_albums(client: NcmClient, artist_id: int, limit: int = 50) -> list[dict]:
    """艺人专辑列表（含 publishTime / size，可用来判断“新专辑是否出现”）。"""
    r = client.http.get(
        f"{BASE}/api/artist/albums/{artist_id}",
        params={"limit": limit, "offset": 0},
        headers={"Referer": f"{BASE}/"},
        timeout=30,
    )
    r.raise_for_status()
    j = r.json()
    out = []
    for a in j.get("hotAlbums") or []:
        out.append(
            {
                "id": a.get("id"),
                "name": a.get("name"),
                "publishTime": a.get("publishTime"),
                "size": a.get("size"),
            }
        )
    return out


def album_detail(client: NcmClient, album_id: int) -> dict:
    r = client.http.get(
        f"{BASE}/api/album/{album_id}", headers={"Referer": f"{BASE}/"}, timeout=30
    )
    r.raise_for_status()
    j = r.json()
    alb = j.get("album") or {}
    songs = alb.get("songs") or []
    return {
        "id": alb.get("id"),
        "name": alb.get("name"),
        "publishTime": alb.get("publishTime"),
        "size": alb.get("size"),
        "songs": [
            {
                "id": s.get("id"),
                "name": s.get("name"),
                "artists": [x.get("name") for x in (s.get("ar") or s.get("artists") or [])],
            }
            for s in songs
        ],
    }


_TRACK_PREFIX = re.compile(
    r"^(?:track\s*[-_]?\s*\d{1,3}|\d{1,3})[\s._\-]+",
    re.I,
)


def file_title(stem: str) -> str:
    """`01. Sample Song 翻译` -> `Sample Song`。"""
    clean = _TRACK_PREFIX.sub("", stem.strip()).strip()
    return _FILE_SUFFIX.sub("", clean).strip() or clean


_SRC_NAME = re.compile(
    r"[\s_\-]*[\(\（\[\【]?\s*(原文|原词|原詞|对照|對照|歌词原文|source|src|jp|kr)\s*[\)\）\]\】]?[\s_\-]*$",
    re.I,
)
_BRACKET_IN = re.compile(r"[\(\（\[\【]([^\)\）\]\】]*)[\)\）\]\】]")
_WORD = re.compile(r"[^\w\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+")


def _parts(text: str) -> tuple[str, tuple[str, ...]]:
    """拆成 (核心, 括号内容集合)。

    专辑内配对**不能**把括号内容当噪音删掉：`Neighbor` 和 `Neighbor (Live)`
    是两首不同的曲目，删掉括号就会互相误配。
    比较时忽略空格与标点，便于兼容包含音轨编号的曲目名。
    """
    import unicodedata

    s = unicodedata.normalize("NFKC", text or "").lower()
    brackets = tuple(sorted(x.strip() for x in _BRACKET_IN.findall(s) if x.strip()))
    core = _WORD.sub("", _BRACKET_IN.sub(" ", s))
    return core, brackets


def find_local_file(
    directory: str | pathlib.Path, title: str, *, accept: float = 0.72
) -> tuple[pathlib.Path | None, float]:
    """在目录里按文件名找这首歌的译文文件，返回 (路径, 相似度)。

    - 同时接受 `.lrc` 和 `.txt`
    - 排除参考原文文件（如 "X 原文.txt"）
    - 核心相同但括号内容不同（`Neighbor` vs `Neighbor (Live)`）视为**不同版本**，
      分数压到阈值以下 —— 宁可不配，也不配错
    """
    d = pathlib.Path(directory)
    if not d.is_dir():
        return None, 0.0
    want_core, want_br = _parts(title)
    best: pathlib.Path | None = None
    best_score = 0.0

    all_files = list(d.glob("*.lrc")) + list(d.glob("*.txt"))
    try:
        for sub in d.iterdir():
            if sub.is_dir() and not sub.name.startswith("."):
                all_files.extend(list(sub.glob("*.lrc")) + list(sub.glob("*.txt")))
    except Exception:
        pass

    for f in sorted(all_files):
        if _SRC_NAME.search(f.stem):
            continue  # 排除参考原文文件
        cand_core, cand_br = _parts(file_title(f.stem))
        if not cand_core or not want_core:
            continue
        if cand_core == want_core and cand_br == want_br:
            score = 1.0
        elif cand_core == want_core:
            score = 0.55  # 同核心不同版本，判为不同曲目
        elif want_core in cand_core or cand_core in want_core:
            score = 0.9
        else:
            score = difflib.SequenceMatcher(None, want_core, cand_core).ratio()
        if score > best_score:
            best, best_score = f, score
    if best_score < accept:
        return None, best_score
    return best, best_score
