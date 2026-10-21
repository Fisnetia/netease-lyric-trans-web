"""网易云双语歌词工作台 —— 本地 Web 界面。

    python gui.py            # 启动后自动打开浏览器
    python gui.py --no-browser
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import threading
import time
import unicodedata
import webbrowser

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from ncm import album as album_mod  # noqa: E402
from ncm import dict_asia  # noqa: E402
from ncm import checker, transfile  # noqa: E402
from ncm import wiki  # noqa: E402
from ncm.match import match_song, search_page  # noqa: E402
from ncm.session import NcmClient, NcmError  # noqa: E402

DEFAULT_DIR = (ROOT / "Lyrics") if (ROOT / "Lyrics").is_dir() else (ROOT / "待投稿")
DEFAULT_PORT = 8765

class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            if path.lower().endswith((".png", ".jpg", ".jpeg", ".ico", ".svg", ".woff2", ".woff", ".cur")):
                response.headers["Cache-Control"] = "public, max-age=604800"
            else:
                response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app = FastAPI(title="网易云翻译助手")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.mount("/static", CachedStaticFiles(directory=ROOT / "web"), name="static")


# 记录启动时核心源文件的内容哈希。
# 服务端通过比对哈希检测代码变动，以便在开发时提示重启服务。
_WATCHED = [ROOT / "gui.py"]
_WATCHED += sorted((ROOT / "ncm").glob("*.py"))


def _snapshot_hashes() -> dict[str, str]:
    import hashlib

    out: dict[str, str] = {}
    for p in _WATCHED:
        try:
            out[str(p.relative_to(ROOT))] = hashlib.md5(p.read_bytes()).hexdigest()
        except OSError:
            continue
    return out


_BOOT_HASHES = _snapshot_hashes()


def _stale_files() -> list[str]:
    """检测启动后发生变动的源文件列表。"""
    now = _snapshot_hashes()
    return sorted(k for k, v in now.items() if _BOOT_HASHES.get(k) != v)



def client() -> NcmClient:
    return NcmClient()





# ---------------------------------------------------------------- 只读接口


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html = (ROOT / "web" / "index.html").read_text("utf-8")
    return HTMLResponse(html)


@app.get("/cloudmusic.png")
@app.get("/Cloudmusic.png")
def get_cloudmusic_img() -> Response:
    for name in ("Cloudmusic.png", "cloudmusic.png", "web/cloudmusic.png"):
        p = ROOT / name
        if p.exists():
            return Response(
                content=p.read_bytes(),
                media_type="image/png",
                headers={"Cache-Control": "public, max-age=604800, immutable"},
            )
    raise HTTPException(status_code=404, detail="Image not found")


@app.get("/favicon.ico")
def get_favicon() -> Response:
    for name in ("favicon.ico", "web/favicon.ico"):
        p = ROOT / name
        if p.exists():
            return Response(
                content=p.read_bytes(),
                media_type="image/x-icon",
                headers={"Cache-Control": "public, max-age=604800, immutable"},
            )
    return get_cloudmusic_img()


@app.get("/api/status")
def api_status() -> dict:
    return {
        "ok": True,
        "files": [],
        "stale": [],
    }


@app.get("/api/files")
def api_files() -> dict:
    """公开服务模式：所有文稿均保存在访客各自的浏览器本地专属工作区。"""
    return {"files": [], "dir": "workspace"}


@app.get("/api/read_file")
def api_read_file(path: str) -> dict:
    """公开服务模式：禁用直接读取服务端磁盘文件，保障隐私与安全。"""
    return {"ok": False, "error": "公开服务模式已禁用直接读取服务器文件"}


@app.get("/api/dirs")
def api_dirs() -> dict:
    """公开服务模式：仅开放浏览器本地工作区。"""
    return {"dirs": [], "default": "workspace"}


@app.get("/api/browse")
def api_browse(path: str = "") -> dict:
    """公开服务模式：禁用服务端目录浏览。"""
    return {"ok": False, "items": [], "error": "公开服务模式已禁用服务端目录浏览"}


@app.get("/api/songs")
def api_songs() -> dict:
    return {"songs": [], "albums": []}


@app.get("/api/search")
def api_search(q: str, artist: str = "", limit: int = 20, offset: int = 0) -> dict:
    """搜索歌曲候选列表，支持按歌手过滤与分页。"""
    if not q.strip():
        return {"candidates": [], "status": "empty", "has_more": False, "offset": offset}
    artists = [artist] if artist.strip() else []
    r = search_page(client(), q, artists, limit=max(1, min(limit, 50)), offset=max(0, offset))
    return {
        "status": "ok",
        "candidates": r["candidates"],
        "has_more": r["has_more"],
        "offset": offset,
        "limit": limit,
    }


@app.get("/api/dict/search")
def api_dict_search(word: str = "", mode: str = "auto") -> dict:
    """查询 dict.asia 日文在线词典 (支持 auto / jc / cj 模式)。"""
    if not word.strip():
        return {"ok": False, "found": False, "message": "请输入要查询的词条"}
    return dict_asia.query_dict_asia(word.strip(), mode=mode)


@app.get("/api/guess_file")
def api_guess_file(title: str, song_id: int | None = None) -> dict:
    """按歌名查找本地文稿文件。"""
    fp, score = album_mod.find_local_file(DEFAULT_DIR, title)
    return {
        "file": str(fp.relative_to(ROOT)).replace("\\", "/") if fp else None,
        "score": round(score, 3),
        "source": (
            str(transfile.find_source_file(fp).relative_to(ROOT)).replace("\\", "/")
            if fp and transfile.find_source_file(fp)
            else None
        ),
    }


@app.get("/api/song_name")
def api_song_name(songId: int) -> dict:
    """获取线上曲目名规范。"""
    try:
        det = wiki.song_get(client(), songId)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if not det or not det.get("songName"):
        return {"ok": False, "error": f"线上没有 songId={songId} 的曲目"}
    return {"ok": True, "name": det["songName"]}


@app.get("/api/song_lyric")
def api_song_lyric(songId: int) -> dict:
    """拉取歌曲详情与官方原文歌词/现有翻译。"""
    c = client()
    try:
        from ncm.lyric import fetch_lyric, song_detail

        ly = fetch_lyric(c, songId)
        det = song_detail(c, songId) or {}
        if not ly.get("ok"):
            return {"ok": False, "error": f"拉取歌词失败 (code={ly.get('code')})"}
        return {
            "ok": True,
            "id": songId,
            "name": det.get("name") or "",
            "artists": " / ".join(det.get("artists") or []) or "未知歌手",
            "album": det.get("album") or "",
            "pic_url": det.get("pic_url") or "",
            "duration_ms": det.get("duration_ms"),
            "original": ly.get("original") or "",
            "translation": ly.get("translation") or "",
            "roman": ly.get("roman") or "",
            "has_translation": ly.get("has_translation", False),
            "pure_music": ly.get("pure_music", False),
            "lyric_user": ly.get("lyric_user") or "",
            "trans_user": ly.get("trans_user") or "",
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.post("/api/align")
def api_align(body: dict) -> dict:
    """独立对轴器：支持双文本、LRC、歌曲编号自动拉取及字符级拆并。"""
    song_id = body.get("song_id")
    orig_text = (body.get("orig_text") or "").strip()
    trans_text = (body.get("trans_text") or "").strip()
    source_text = (body.get("source_text") or "").strip()
    auto_reflow = bool(body.get("auto_reflow", True))
    tolerance_ms = int(body.get("tolerance_ms", 60))

    c = client()
    song_info = {}

    if song_id and not orig_text:
        try:
            from ncm.lyric import fetch_lyric, song_detail

            sid = int(song_id)
            ly = fetch_lyric(c, sid)
            det = song_detail(c, sid) or {}
            song_info = {
                "id": sid,
                "name": det.get("name", ""),
                "artists": " / ".join(det.get("artists", [])),
                "has_translation": ly.get("has_translation", False),
                "trans_user": ly.get("trans_user", ""),
            }
            if ly.get("ok") and ly.get("original"):
                orig_text = ly["original"]
            else:
                return {"ok": False, "error": f"未能从网易云获取曲目 {sid} 的歌词"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"获取官方歌词失败: {e}"}

    if not orig_text:
        return {"ok": False, "error": "请提供原文及时间轴内容（或输入歌曲编号）"}
    if not trans_text:
        return {"ok": False, "error": "请提供需要对齐的译文内容"}

    try:
        timed = transfile.parse_lrc(trans_text)
        if not timed:
            raw_lines = [
                transfile.Line(None, ln.strip())
                for ln in trans_text.splitlines()
                if ln.strip()
                and not transfile.is_trans_metadata(ln.strip())
                and not transfile.is_credit_line(ln.strip())
            ]
            parsed = transfile.Parsed("<memory>", has_time=False, lines=raw_lines)
        else:
            parsed_lines = []
            for item in timed:
                txt = (item.get("text") or "").strip()
                if not txt or transfile.is_trans_metadata(txt) or transfile.is_credit_line(txt):
                    continue
                parsed_lines.append(transfile.Line(item.get("time_ms"), txt, raw=item.get("raw", "")))
            parsed = transfile.Parsed("<memory>", has_time=True, lines=parsed_lines)

        source_lines = None
        if source_text:
            s_timed = transfile.parse_lrc(source_text)
            if s_timed:
                source_lines = [x["text"] for x in s_timed if x["text"].strip()]
            else:
                source_lines = [ln.strip() for ln in source_text.splitlines() if ln.strip()]

        al = transfile.align(
            parsed,
            orig_text,
            tolerance_ms=tolerance_ms,
            auto_reflow=auto_reflow,
            source_lines=source_lines,
        )

        style = transfile.detect_time_style(orig_text)
        aligned_lrc = al.trans_lrc(style=style)

        pairs_out = []
        for orig, line in al.pairs:
            pairs_out.append(
                {
                    "time_ms": orig["time_ms"],
                    "time_str": transfile.format_time(orig["time_ms"], style),
                    "orig_text": orig["text"],
                    "trans_text": line.text,
                    "is_empty_slot": transfile.is_empty_slot(orig["text"]),
                    "status": "ok"
                    if line.text
                    else ("empty" if transfile.is_empty_slot(orig["text"]) else "missing"),
                }
            )

        missing_out = [
            {
                "time_ms": o["time_ms"],
                "time_str": transfile.format_time(o["time_ms"], style),
                "orig_text": o["text"],
            }
            for o in al.missing
        ]

        extra_out = [
            {
                "time_ms": l.time_ms,
                "time_str": transfile.format_time(l.time_ms, style)
                if l.time_ms is not None
                else None,
                "text": l.text,
            }
            for l in al.extra
        ]

        slots = transfile.translatable(orig_text)
        content_count = len(transfile.content_slots(slots))

        return {
            "ok": True,
            "song": song_info,
            "style": style,
            "style_label": transfile.time_style_label(style),
            "stats": {
                "total_slots": len(slots),
                "content_slots": content_count,
                "trans_lines": len(parsed.lines),
                "matched": len(al.pairs),
                "exact": al.exact,
                "fuzzy": al.fuzzy,
                "missing": len(al.missing),
                "extra": len(al.extra),
                "is_perfect": al.ok,
            },
            "pairs": pairs_out,
            "missing": missing_out,
            "extra": extra_out,
            "aligned_lrc": aligned_lrc,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.api_route("/api/prepare", methods=["GET", "POST"])
def api_prepare(
    songId: int | None = None,
    file: str | None = None,
    autoReflow: bool = True,
    src: str = "",
    body: dict | None = None,
) -> dict:
    """只读体检：对齐 + 通道 + 官方校验 + kt 模拟（支持传本地文件路径或直接传文本）。"""
    c = client()
    trans_text = None
    if body:
        songId = int(body.get("songId") or (songId or 0))
        autoReflow = bool(body.get("autoReflow", autoReflow))
        file = body.get("file") or file or body.get("fileName")
        trans_text = body.get("trans_text") or body.get("trans")
        src = body.get("src") or src

    if not songId:
        return {"ok": False, "error": "缺少歌曲编号 (songId)"}

    path = None
    if file:
        p = (ROOT / file) if not pathlib.Path(file).is_absolute() else pathlib.Path(file)
        if p.exists() and p.is_file():
            path = p
        elif trans_text is None:
            return {"ok": False, "error": f"文稿文件不存在：{file}"}

    try:
        rep = checker.prepare(
            c,
            songId,
            path,
            trans_text=trans_text,
            auto_reflow=autoReflow,
            source_path=(src or None),
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    # 对齐校验：行数相等且逐行时间轴匹配
    from ncm.lyric import fetch_lyric, parse_lrc

    ly = fetch_lyric(c, songId)
    slots = transfile.translatable(ly["original"])
    got = [x for x in parse_lrc(rep["trans_lrc"]) if x["time_ms"] is not None]
    kt_ok = len(slots) == len(got) and all(
        a["time_ms"] == b["time_ms"] for a, b in zip(slots, got)
    )
    rep["kt"] = {
        "ok": kt_ok,
        "slots": len(slots),
        "lines": len(got),
        "message": (
            f"{len(slots)} 行、逐行时间轴匹配"
            if kt_ok
            else f"行数/时间轴不一致：原文槽位 {len(slots)} vs 译文 {len(got)}"
        ),
    }
    return {"ok": True, "report": rep}





_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _safe_name(s: str, *, maxlen: int = 120) -> str:
    """清理文件名中的非法字符，生成合法的文件名。"""
    s = _ILLEGAL.sub("_", (s or "").strip())
    s = s.rstrip(". ")          # Windows 不允许文件名以点或空格结尾
    return (s or "unnamed")[:maxlen]


def _decode_bytes(b: bytes) -> tuple[str, str]:
    """探测编码并将字节流解码为文本，按 UTF-8、GBK、CP932 顺序尝试。"""
    for bom, enc in ((b"\xef\xbb\xbf", "utf-8-sig"), (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16")):
        if b.startswith(bom):
            try:
                return b.decode(enc), enc
            except UnicodeDecodeError:
                pass
    for enc in ("utf-8", "gbk", "cp932"):
        try:
            return b.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return b.decode("utf-8", errors="replace"), "utf-8(replace)"


def _authoritative_title(song_id: int | None, given: str) -> tuple[str, str | None]:
    """按 songId 获取线上规范曲目名。

    返回 (曲目名, 警告)。
    """
    given = (given or "").strip()
    if not song_id:
        return given, None
    try:
        det = wiki.song_get(client(), int(song_id))
    except Exception as e:  # noqa: BLE001
        return given, f"获取线上曲目名失败（{type(e).__name__}），使用输入名称：{given}"
    if not det or not det.get("songName"):
        return given, f"未查询到 songId={song_id} 的曲目，使用输入名称：{given}"
    real = det["songName"]
    if given and given != real:
        return real, f"输入曲目名为“{given}”，线上规范名为“{real}”，已自动采用规范名称"
    return real, None


@app.post("/api/decode_file")
def api_decode_file(body: dict) -> dict:
    """将文件字节流解码为文本并返回识别编码。"""
    import base64 as _b64

    try:
        raw = _b64.b64decode(body.get("b64") or "")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"base64 解析失败：{e}"}
    if not raw:
        return {"ok": False, "error": "文件是空的"}
    text, enc = _decode_bytes(raw)
    return {
        "ok": True,
        "text": text,
        "encoding": enc,
        "bytes": len(raw),
        "lines": len([x for x in text.splitlines() if x.strip()]),
    }


@app.post("/api/save_lyrics")
def api_save_lyrics(body: dict) -> dict:
    """公开服务模式：所有文稿均保存在访客各自的浏览器本地专属工作区，服务端不落盘。"""
    return {"ok": False, "error": "公开服务模式已禁用服务端写盘，所有歌词请保存在浏览器工作区并直接导出。"}


@app.post("/api/update_file")
def api_update_file(body: dict) -> dict:
    """公开服务模式：禁用服务端文件改写。"""
    return {"ok": False, "error": "公开服务模式已禁用服务端文件改写。"}





def _port_free(host: str, port: int) -> bool:
    import socket

    with socket.socket() as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def pick_port(host: str, want: int | None, tries: int = 20) -> int:
    """查找并返回可用端口。若指定端口已被占用，则自动向后探测可用端口。"""
    if want is not None and _port_free(host, want):
        return want
    base = want if want is not None else DEFAULT_PORT
    for p in range(base + (0 if want is None else 1), base + tries + 1):
        if _port_free(host, p):
            return p
    raise SystemExit(f"从端口 {base} 起连续尝试 {tries} 个端口均被占用，请通过 --port 指定可用端口")


def _display_width(text: str) -> int:
    """计算包含中英文字符与 ANSI 转义序列在终端中的实际显示宽度。"""
    clean = re.sub(r"\x1b\[[0-9;]*m", "", text)
    w = 0
    for ch in clean:
        eaw = unicodedata.east_asian_width(ch)
        if eaw in ("W", "F"):
            w += 2
        else:
            w += 1
    return w


def _print_startup_banner(
    url: str,
    port: int,
    default_port: int = DEFAULT_PORT,
    no_browser: bool = False,
) -> None:
    """打印服务启动信息与访问地址。"""
    use_color = sys.stdout.isatty() if hasattr(sys.stdout, "isatty") else False

    c_gray = "\033[90m" if use_color else ""
    c_bold_white = "\033[1;37m" if use_color else ""
    c_bold_cyan = "\033[1;36m" if use_color else ""
    c_green = "\033[32m" if use_color else ""
    c_yellow = "\033[33m" if use_color else ""
    c_reset = "\033[0m" if use_color else ""

    inner_width = 58
    top = f"  {c_gray}╭" + "─" * inner_width + f"╮{c_reset}"
    mid = f"  {c_gray}├" + "─" * inner_width + f"┤{c_reset}"
    bot = f"  {c_gray}╰" + "─" * inner_width + f"╯{c_reset}"

    def row(content: str = "") -> str:
        w = _display_width(content)
        pad = inner_width - 2 - w
        return f"  {c_gray}│{c_reset}  {content}" + " " * max(0, pad) + f"{c_gray}│{c_reset}"

    lines = [
        "",
        top,
        row(),
        row(f"{c_bold_white}网易云翻译助手{c_reset}  {c_gray}by FinaFina{c_reset}"),
        row(),
        row(f"{c_green}●{c_reset} 可手动访问地址：{c_bold_cyan}{url}{c_reset}"),
    ]
    if port != default_port:
        lines.append(row(f"{c_yellow}● （{default_port} 已被占用 —— 将开启另一个实例）{c_reset}"))
    if not no_browser:
        lines.append(row(f"{c_green}●{c_reset} 请等待浏览器自动打开..."))
    lines.extend([
        row(),
        mid,
        row(f"{c_gray}关闭此窗口即可停止实例{c_reset}"),
        bot,
        "",
    ])
    print("\n".join(lines))


def main() -> None:
    default_host = "0.0.0.0" if os.environ.get("SPACE_ID") else os.environ.get("HOST", "127.0.0.1")
    default_port = int(os.environ["PORT"]) if "PORT" in os.environ else (7860 if os.environ.get("SPACE_ID") else None)
    default_no_browser = bool(os.environ.get("SPACE_ID") or os.environ.get("NO_BROWSER"))

    ap = argparse.ArgumentParser(prog="gui.py")
    ap.add_argument("--host", default=default_host)
    ap.add_argument("--port", type=int, default=default_port, help="服务监听端口，默认自动探测可用端口")
    ap.add_argument("--no-browser", action="store_true", default=default_no_browser)
    args = ap.parse_args()

    # Windows 环境下切换控制台为 UTF-8 编码，避免终端输出乱码
    if os.name == "nt":
        try:
            os.system("chcp 65001 >nul")
            import ctypes

            h_out = ctypes.windll.kernel32.GetStdHandle(-11)
            mode = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetConsoleMode(h_out, ctypes.byref(mode)):
                ctypes.windll.kernel32.SetConsoleMode(h_out, mode.value | 0x0004)
        except Exception:  # noqa: BLE001
            pass
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

    port = pick_port(args.host, args.port)
    for attempt in range(12):
        url = f"http://{args.host}:{port}/"
        _print_startup_banner(url, port, DEFAULT_PORT, no_browser=args.no_browser)
        if not args.no_browser:
            threading.Timer(1.2, lambda u=url: webbrowser.open(u)).start()
        try:
            uvicorn.run(app, host=args.host, port=port, log_level="warning")
            return
        except SystemExit:
            raise
        except OSError as e:
            # 端口检测与绑定之间可能存在时间差，若发生冲突则自动换用新端口重试
            if "10048" not in str(e) and "address" not in str(e).lower():
                raise
            print(f"  端口 {port} 已被占用，正在重新分配空闲端口...")
            port = pick_port(args.host, None)
            args.port = None


if __name__ == "__main__":
    main()
