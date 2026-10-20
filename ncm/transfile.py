"""本地译文文件的解析、与官方原文的对齐、以及投稿用 LRC 的生成。

格式依据（来自真实样例 + 前端代码 + 线上数据三方印证）：

  * 样例 `Sample Track 翻译.lrc` 是**纯译文 LRC**：`[00:13.160]此处为样例译文内容`
  * 译文时间轴与原文逐行对齐
  * 原文中以 `- ` 开头的行，译文相应保留前缀
  * `transLyricContent` 是**带时间轴的 LRC**，不是纯文本
    （前端会 `line.match(/\\[.*\\]/g)` 从每行里抽时间轴来渲染）
"""

from __future__ import annotations

import pathlib
import re
from dataclasses import dataclass, field

from .lyric import CREDIT_LABELS, is_credit_line, is_non_lyric_marker, parse_lrc

_KANA = re.compile(r"[\u3040-\u30fa\u30fc-\u30ff]")
_HANGUL = re.compile(r"[\uac00-\ud7af]")
_CJK = re.compile(r"[\u4e00-\u9fff]")

# 译文文件里可能混进的元信息标签，如 [by:xxx] / [ti:xxx]
_MD_TAG = re.compile(r"^\s*\[(by|ti|al|ar|au|offset|re|ve|length|kana)\s*:", re.I)
# 元信息行的通用形状：短标签 + 冒号 + 内容
_LABEL_SEP = re.compile(r"^\s*([^:：]{1,15})\s*[:：]\s*\S")


def is_trans_metadata(text: str) -> bool:
    """判断译文文件里的一行是不是元信息（该丢掉）。

    区别于常规判断规则：中文译文行内常见冒号对话（如 "我说：你好"），
    不能仅凭冒号前无假名判定为元信息，此处仅匹配标准元标签及已知制作信息白名单。
    """
    if _MD_TAG.match(text):
        return True
    m = _LABEL_SEP.match(text)
    if not m:
        return False
    label = m.group(1).strip().lower()
    return label in CREDIT_LABELS or label.replace("・", "").replace(" ", "") in CREDIT_LABELS

# 线上译文时间轴格式通常与原文保持一致
_DOT = re.compile(r"\[\d{1,3}:\d{2}\.\d{1,3}\]")
_COLON = re.compile(r"\[\d{1,3}:\d{2}:\d{2}\]")


def detect_time_style(lrc: str) -> str:
    """判断这份 LRC 的时间轴风格：'dot' -> [mm:ss.xxx]，'colon' -> [mm:ss:xx]。

    取多数派；元信息行常是另一种格式，按行数占优者判定即可。
    """
    dot = len(_DOT.findall(lrc or ""))
    colon = len(_COLON.findall(lrc or ""))
    return "colon" if colon > dot else "dot"


def time_style_label(style: str | None) -> str:
    """把内部的时间轴写法名换成给人看的说法。"""
    return {
        "dot": "点号式 [00:12.345]",
        "colon": "冒号式 [00:12:34]",
    }.get(style or "", str(style or "未知"))


def format_time(ms: int, style: str = "dot") -> str:
    """毫秒 -> 时间轴字符串。

    style='dot'   -> [mm:ss.xxx]（官方校验接口要求的写法）
    style='colon' -> [mm:ss:xx] （部分线上原文/译文用的写法）

    注：官方校验接口对冒号格式时间轴可能提示格式不符，
    但线上确实存在大量冒号格式且存活的译文，所以校验结论不能当唯一依据。
    """
    m, rem = divmod(int(ms), 60000)
    s, milli = divmod(rem, 1000)
    if style == "colon":
        return f"[{m:02d}:{s:02d}:{milli // 10:02d}]"
    return f"[{m:02d}:{s:02d}.{milli:03d}]"


def to_style(lrc: str, style: str) -> str:
    """把整份 LRC 的时间轴统一改写成指定格式（用于规避校验接口对冒号的误报）。"""
    def rep(m: re.Match) -> str:
        mm, ss, frac = m.group(1), m.group(2), m.group(3) or ""
        if frac and len(frac) <= 2:  # 冒号写法：百分秒
            ms = int(frac.ljust(2, "0")) * 10
        else:  # 点号写法：毫秒
            ms = int(frac.ljust(3, "0")[:3]) if frac else 0
        return format_time((int(mm) * 60 + int(ss)) * 1000 + ms, style)

    return re.sub(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]", rep, lrc)


@dataclass
class Line:
    time_ms: int | None
    text: str
    raw: str = ""


@dataclass
class Parsed:
    path: str
    has_time: bool
    lines: list[Line] = field(default_factory=list)
    bilingual: bool = False


def _looks_like_translation(text: str) -> bool:
    """判断文本是否符合中文译文特征（含中文字符且不含假名或谚文）。"""
    return bool(_CJK.search(text)) and not _KANA.search(text) and not _HANGUL.search(text)


def parse_text(text: str, label: str = "custom") -> Parsed:
    """宽容解析文本内容（支持无轴纯文本、带轴纯译文 LRC、双语 LRC）。"""
    timed = parse_lrc(text or "")

    if not timed:
        lines = [
            Line(None, ln.strip())
            for ln in text.splitlines()
            if ln.strip() and not is_trans_metadata(ln.strip()) and not is_credit_line(ln.strip())
        ]
        return Parsed(label, has_time=False, lines=lines)

    groups: dict[int, list[dict]] = {}
    order: list[int] = []
    for item in timed:
        if item["time_ms"] not in groups:
            groups[item["time_ms"]] = []
            order.append(item["time_ms"])
        groups[item["time_ms"]].append(item)

    multi = sum(1 for t in order if len(groups[t]) > 1)
    bilingual = multi >= max(1, len(order) // 3)

    lines: list[Line] = []
    for t in order:
        items = groups[t]
        if bilingual and len(items) > 1:
            pick = next((x for x in items if _looks_like_translation(x["text"])), items[-1])
        else:
            pick = items[0]
        txt = (pick.get("text") or "").strip()
        if not txt or is_trans_metadata(txt) or is_credit_line(txt):
            continue
        lines.append(Line(t, txt, raw=pick.get("raw", "")))
    return Parsed(label, has_time=True, lines=lines, bilingual=bilingual)


def load(path: str | pathlib.Path) -> Parsed:
    """宽容解析译文文件。"""
    p = pathlib.Path(path)
    text = p.read_text("utf-8-sig")
    return parse_text(text, label=str(p))


@dataclass
class Alignment:
    pairs: list[tuple[dict, Line]] = field(default_factory=list)
    missing: list[dict] = field(default_factory=list)
    extra: list[Line] = field(default_factory=list)
    exact: int = 0
    fuzzy: int = 0
    positional: bool = False
    reflow: object | None = None  # 自动拆并的结果（ReflowResult），未启用则为 None

    @property
    def ok(self) -> bool:
        return not self.missing and not self.extra

    def trans_lrc(self, style: str = "dot") -> str:
        """按原文行的顺序输出投稿用译文 LRC。

        style 默认 'dot'；实际投稿时应当传 detect_time_style(原文) 的结果，
        与线上 22 首抽样观察到的规律（译文格式 = 原文格式）保持一致。
        """
        return "\n".join(
            f"{format_time(orig['time_ms'], style)}{line.text}" for orig, line in self.pairs
        )


def is_empty_slot(text: str) -> bool:
    """判断是否为无需填入译文、内容留空的占位槽位（作词/作曲等演职员元信息、或间奏/前奏等旋律标记行）。"""
    t = (text or "").strip()
    if not t:
        return True
    return is_credit_line(t) or is_non_lyric_marker(t)


def translatable(original_lrc: str) -> list[dict]:
    """需要**占位**的行：所有带时间轴的行。

    包含作词/作曲等元信息行、-music- 这类标记行、以及纯空白行。
    带时间轴的原文行保留槽位（元信息与标记行留空），
    使输出译文与原文时间轴保持对应。
    真正需要用户译文的行用 `content_slots()` 取。
    """
    return parse_lrc(original_lrc)


def _apply_reflow(    al: Alignment,
    texts: list[str],
    orig: list[dict],
    source_lines: list[str] | None = None,
) -> bool:
    """尝试自动拆并；成功则写入 al 并返回 True，失败返回 False。

    给了 source_lines（你自己对照的原文）时优先用它做**同语言字符级对齐** ——
    那比跨语言的长度启发式可靠得多。失败再退回启发式。
    """
    from . import reflow as _rf

    rr = None
    if source_lines is not None and len(source_lines) == len(texts):
        rr = _rf.reflow_with_source(texts, source_lines, orig)
        if not rr.ok or not rr.pairs:
            rr = None
    if rr is None:
        rr = _rf.reflow(texts, orig)
    if not rr.ok:
        return False
    # reflow 返回的是 (原文行, 字符串)，这里要包装成 Line 以对齐 Alignment 的类型
    al.pairs = [(ln, Line(None, txt)) for ln, txt in rr.pairs]
    al.exact = len(rr.pairs)
    al.missing = []
    al.extra = []
    al.reflow = rr
    return True


# 移除译文文件名中的后缀词，以便推导配套原文文件名
_FILE_SUFFIX = re.compile(
    r"[\s_\-]*[\(\（\[\【]?\s*(翻译|譯文|译文|中文翻译|trans|translation)\s*[\)\）\]\】]?\s*$",
    re.I,
)
_SRC_TAGS = ("原文", "原词", "原詞", "对照", "對照", "歌词原文", "source", "src", "jp", "kr")

# 使用参考原文进行字符对齐的最低置信度阈值。
# 若相似度偏低，退回启发式位置对齐，避免因底稿版本差异造成错位。
SOURCE_CONF_MIN = 0.5


def find_source_file(trans_path: str | pathlib.Path) -> pathlib.Path | None:
    """查找与译文配套的参考原文文件。

    约定：`X 翻译.lrc` 配 `X 原文.txt`
    （也接受 原词/原詞/歌词原文/source/src/jp/kr，扩展名 .txt 或 .lrc）。
    """
    p = pathlib.Path(trans_path)
    base = _FILE_SUFFIX.sub("", p.stem).strip() or p.stem
    d = p.parent
    for tag in _SRC_TAGS:
        for ext in (".txt", ".lrc"):
            for sep in (" ", "_", "-", ""):
                cand = d / f"{base}{sep}{tag}{ext}"
                if cand.exists() and cand.resolve() != p.resolve():
                    return cand
    return None


def load_source_lines(path: str | pathlib.Path, expect: int | None = None) -> list[str]:
    """读你自己对照的原文，返回逐行文本（LRC 会自动剥掉时间轴）。

    若指定期望行数，优先采用行数匹配的解析方式。
    """
    text = pathlib.Path(path).read_text("utf-8-sig")
    timed = parse_lrc(text)
    if timed:
        raw = [x["text"] for x in timed if x["text"].strip()]
    else:
        raw = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if expect is None or len(raw) == expect:
        return raw
    filt = [ln for ln in raw if not is_trans_metadata(ln) and not is_credit_line(ln)]
    if len(filt) == expect:
        return filt
    return raw


def content_slots(slots: list[dict]) -> list[dict]:
    """槽位里**真正需要用户译文**的部分（排除元信息行与标记行）。

    官方要求译文与原文逐行对应，所以带时间轴的行都要占位。
    但用户无需对作词作曲或间奏提供翻译，这些槽位会自动填入空内容保留时间轴。
    """
    return [s for s in slots if not is_empty_slot(s["text"])]


def _assemble(slots: list[dict], pairs: list[tuple[dict, Line]]) -> list[tuple[dict, Line]]:
    """把只覆盖正文行的对齐结果摊回完整槽位序列，元信息与标记行给空译文。"""
    it = iter(pairs)
    out: list[tuple[dict, Line]] = []
    for s in slots:
        if is_empty_slot(s["text"]):
            out.append((s, Line(s["time_ms"], "")))   # 空行，但保留时间轴
        else:
            try:
                out.append(next(it))
            except StopIteration:
                out.append((s, Line(s["time_ms"], "")))
    return out


def align(
    parsed: Parsed,
    original_lrc: str,
    *,
    tolerance_ms: int = 60,
    auto_reflow: bool = False,
    source_lines: list[str] | None = None,
) -> Alignment:
    """把译文对齐到官方原文。

    有时间轴：先按时间轴精确匹配，再按最近邻（容差内）兜底。
    无时间轴：按顺序逐行对齐。

    对齐仅在正文歌词行进行；标记行保留时间轴槽位但内容留空，
    最终会得到一个空行（保留时间轴），这样译文行数与原文严格相等。

    auto_reflow=True 时，若行数对不上，会自动拆并而不是直接报错放弃。
    提供参考原文时，优先进行同语言字符级对齐
    （比长度启发式可靠得多），此时 auto_reflow 不再是必需。
    """
    slots = translatable(original_lrc)          # 含标记行（占位）
    orig = content_slots(slots)                 # 只对正文行做对齐
    al = _align_core(
        parsed,
        orig,
        tolerance_ms=tolerance_ms,
        auto_reflow=auto_reflow,
        source_lines=source_lines,
    )
    if len(slots) != len(orig):
        al.pairs = _assemble(slots, al.pairs)
        al.missing = [o for o in al.missing]
    return al


def _align_core(
    parsed: Parsed,
    orig: list[dict],
    *,
    tolerance_ms: int = 60,
    auto_reflow: bool = False,
    source_lines: list[str] | None = None,
) -> Alignment:
    al = Alignment()

    if not parsed.has_time:
        al.positional = True
        texts = [ln.text for ln in parsed.lines]

        # 提供了参考原文时优先进行字符级对齐，以应对分行拆合或重复段差异；
        # 字符匹配率符合阈值时采信该结果，否则平稳回退。
        if source_lines is not None and len(source_lines) == len(texts):
            from . import reflow as _rf

            rr = _rf.reflow_with_source(texts, source_lines, orig)
            if rr.ok and rr.pairs and rr.confidence >= SOURCE_CONF_MIN:
                al.pairs = [(ln, Line(None, txt)) for ln, txt in rr.pairs]
                al.exact = len(al.pairs)
                al.reflow = rr
                return al

        if len(parsed.lines) == len(orig):
            al.pairs = list(zip(orig, parsed.lines))
            al.exact = len(al.pairs)
            return al
        if (auto_reflow or source_lines is not None) and _apply_reflow(
            al, texts, orig, source_lines
        ):
            return al
        n = min(len(parsed.lines), len(orig))
        al.pairs = list(zip(orig[:n], parsed.lines[:n]))
        al.missing = orig[n:]
        al.extra = parsed.lines[n:]
        return al

    # 时间轴 -> 原文行（允许同一时间轴多行，按出现顺序消费）
    bucket: dict[int, list[dict]] = {}
    for o in orig:
        bucket.setdefault(o["time_ms"], []).append(o)
    used: set[int] = set()

    pending: list[Line] = []
    for line in parsed.lines:
        t = line.time_ms
        if t in bucket and bucket[t]:
            o = bucket[t].pop(0)
            used.add(id(o))
            al.pairs.append((o, line))
            al.exact += 1
        else:
            pending.append(line)

    # 邻近时间轴容差匹配
    remaining = [o for o in orig if id(o) not in used]
    for line in pending:
        cands = [o for o in remaining if id(o) not in used]
        if not cands:
            al.extra.append(line)
            continue
        best = min(cands, key=lambda o: abs(o["time_ms"] - line.time_ms))
        if abs(best["time_ms"] - line.time_ms) <= tolerance_ms:
            used.add(id(best))
            al.pairs.append((best, line))
            al.fuzzy += 1
        else:
            al.extra.append(line)

    al.missing = [o for o in orig if id(o) not in used]
    al.pairs.sort(key=lambda pair: pair[0]["time_ms"])

    # 带时间轴但未完全匹配时，尝试自动重排
    if (auto_reflow or source_lines is not None) and (al.missing or al.extra):
        _apply_reflow(al, [ln.text for ln in parsed.lines], orig, source_lines)
    return al


def merged_rows(al: Alignment) -> list[tuple[dict | None, Line | None]]:
    """把对齐结果摊平成一串 (原文行, 译文行)，缺的一侧为 None。"""
    rows: list[tuple[float, dict | None, Line | None]] = []
    for o, line in al.pairs:
        rows.append((o["time_ms"], o, line))
    for o in al.missing:
        rows.append((o["time_ms"], o, None))
    for line in al.extra:
        rows.append((line.time_ms if line.time_ms is not None else float("inf"), None, line))
    rows.sort(key=lambda r: r[0])
    return [(o, line) for _, o, line in rows]


def mismatch_view(al: Alignment, *, context: int = 1, max_regions: int = 8) -> list[str]:
    """生成不匹配区域的原文与译文逐行对照视图。

    只报告问题区域（附近各留 context 行上下文），不做任何自动改写 ——
    平台要求译文与原文时间轴保持对应，
    替用户猜着拆句会破坏译文质量，也过不了官方那关。
    """
    rows = merged_rows(al)
    bad = [i for i, (o, line) in enumerate(rows) if o is None or line is None]
    if not bad:
        return []

    regions: list[list[int]] = []
    cur = [bad[0]]
    for i in bad[1:]:
        if i - cur[-1] <= 2 * context + 1:
            cur.append(i)
        else:
            regions.append(cur)
            cur = [i]
    regions.append(cur)

    out: list[str] = []
    for reg in regions[:max_regions]:
        lo = max(0, reg[0] - context)
        hi = min(len(rows), reg[-1] + context + 1)
        out.append(f"  ── 第 {reg[0] + 1}~{reg[-1] + 1} 行附近 ──")
        for i in range(lo, hi):
            o, line = rows[i]
            flag = "!!" if (o is None or line is None) else "  "
            o_t = format_time(o["time_ms"]) if o else "  --:--.---  "
            o_x = o["text"][:46] if o else "（原文此处没有对应行）"
            l_t = format_time(line.time_ms) if (line and line.time_ms is not None) else "  --:--.---  "
            l_x = line.text[:46] if line else "（缺译）"
            out.append(f"  {flag} 原 {o_t} {o_x}")
            out.append(f"  {flag} 译 {l_t} {l_x}")
    if len(regions) > max_regions:
        out.append(f"  ...另有 {len(regions) - max_regions} 处问题区域，已省略")
    return out
