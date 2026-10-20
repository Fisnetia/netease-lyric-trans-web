"""自动拆并：当译文行数与原文不一致时，自动将译文重排为逐行对应。

设计原理与约束：

  1. 单调约束：译文行序与原文行序保持一致。
  2. 长度自校准模型：全曲译文与原文长度比例保持相对稳定。
  3. 结构标记与语义锚点：破折号、空格、标点符号、共有汉字及词汇等。
  4. 全局 2D 状态对齐 (Mixed Split-Merge DP)：支持局部拆分 (1->K)、
     局部合并 (K->1)、重复段折叠与去重、官方重复行广播。
"""

from __future__ import annotations

import collections
import difflib
import re
from dataclasses import dataclass, field

# 标点符号与空白字符（不计入有效内容长度）
_PUNCT = re.compile(
    r"[\s、。，．！？…—\-‐–「」『』（）()\[\]【】《》〈〉:：;；\"'“”‘’·/\\|~～!?,.]"
)
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")

# 常见日中/简繁同义汉字归一化映射
_KANJI_MAP = {
    "来": "来", "來": "来", "融": "融", "春": "春", "中": "中", "待": "待",
    "夜": "夜", "灰": "灰", "知": "知", "消": "消", "赫": "赫", "忘": "忘",
    "日": "日", "間": "间", "違": "违", "誰": "谁", "愛": "爱", "敵": "敌",
    "戦": "战", "觀": "观", "観": "观", "創": "创", "殺": "杀", "惡": "恶",
    "悪": "恶", "傷": "伤", "變": "变", "変": "变", "気": "气", "樂": "乐",
    "楽": "乐", "發": "发", "発": "发", "見": "见", "話": "话", "語": "语",
    "門": "门", "開": "开", "閉": "关", "讀": "读", "読": "读", "聽": "听",
    "聴": "听", "聲": "声", "声": "声", "臉": "脸", "顔": "脸", "頭": "头",
    "單": "单", "単": "单", "廣": "广", "広": "广", "體": "体", "体": "体",
    "櫻": "樱", "桜": "樱", "風": "风", "雲": "云", "時": "时", "歩": "步",
}


def weight(text: str) -> int:
    """内容长度（去掉标点和空白）。"""
    return len(_PUNCT.sub("", text or ""))


def cjk_set(text: str) -> set[str]:
    return set(_CJK.findall(text or ""))


def norm_cjk(text: str) -> set[str]:
    """提取汉字并映射简繁/日中同形字，提升跨语种锚点命中率。"""
    res = set()
    for ch in cjk_set(text):
        res.add(_KANJI_MAP.get(ch, ch))
    return res


_jieba = None
_jieba_loaded = False


def _get_jieba():
    """按需懒加载 jieba，避免无拆句需求（如 1:1 对齐）时的冷启动耗时。"""
    global _jieba, _jieba_loaded
    if not _jieba_loaded:
        _jieba_loaded = True
        try:
            import logging
            import jieba
            jieba.setLogLevel(logging.ERROR)
            _jieba = jieba
        except ImportError:
            _jieba = None
    return _jieba


def _word_boundaries(text: str) -> set[int] | None:
    """返回所有词之间的合法切分点（字符下标）。"""
    jb = _get_jieba()
    if jb is None:
        return None
    spans = set()
    pos = 0
    for w in jb.cut(text, cut_all=False):
        pos += len(w)
        spans.add(pos)
    return spans


# 切句候选位置：标点之后、以及 "- " 这类结构标记之前
_SPLIT_AFTER = re.compile(r"[、。，．！？…；：,\.!\?;]\s*")
_STRUCT_BEFORE = re.compile(r"(?=\s*[-–—]\s)")
_PARTICLE_AFTER = set("的地得了着过里中后前时上下间边面为吧呢啊吗呀哦")
_BOUNDARY_BEFORE = set("那这每一个谁你我他她它将把被给从向在对就便也又并但而因所若")


@dataclass
class Op:
    kind: str            # split / merge / collapse / broadcast / drop / =
    detail: str
    score: float


@dataclass
class ReflowResult:
    ok: bool
    pairs: list[tuple[dict, str]] = field(default_factory=list)
    ops: list[Op] = field(default_factory=list)
    confidence: float = 0.0
    message: str = ""

    def texts(self) -> list[str]:
        return [t for _, t in self.pairs]


def _key(text: str) -> str:
    """去重用的归一化键：去掉标点和空白。"""
    return _PUNCT.sub("", text or "").strip()


def distinct_texts(texts: list[str]) -> list[str]:
    """保序去重（按归一化键）。"""
    seen: dict[str, str] = {}
    for t in texts:
        k = _key(t)
        if k and k not in seen:
            seen[k] = t
    return list(seen.values())


def trans_mass(texts: list[str]) -> int:
    """一组译文的有效内容量：重复行只算一份。"""
    return sum(weight(t) for t in distinct_texts(texts))


_OPEN = "([{（【「『"
_CLOSE = ")]}）】」』"


def _is_tight(ch: str) -> bool:
    """中日韩字符（含假名/谚文）：与相邻片段之间不需要空格。"""
    o = ord(ch)
    return (
        0x3040 <= o <= 0x30FF
        or 0x3400 <= o <= 0x4DBF
        or 0x4E00 <= o <= 0x9FFF
        or 0xAC00 <= o <= 0xD7AF
    )


def join_texts(parts: list[str]) -> str:
    """把若干译文片段接起来。"""
    out = ""
    for raw in parts:
        piece = raw.strip()
        if not piece:
            continue
        if not out:
            out = piece
            continue
        if out[-1] in _OPEN or piece[0] in _CLOSE:
            out += piece
        elif _is_tight(out[-1]) and _is_tight(piece[0]):
            out += piece
        else:
            out += " " + piece
    return out


_LEAD_MARK = re.compile(r"\s*([-–—*・「『（(【])")


def _cut_context(text: str, o_texts: list[str]) -> dict:
    k = len(o_texts)
    weights = [weight(x) for x in o_texts]
    total = sum(weights) or 1

    targets, acc = [], 0
    for w in weights[:-1]:
        acc += w
        targets.append(len(text) * acc / total)

    punct_pos = {m.end() for m in _SPLIT_AFTER.finditer(text)}
    struct_pos = {m.start() for m in _STRUCT_BEFORE.finditer(text) if m.start() > 0}
    space_pos = {i for i, ch in enumerate(text) if ch in " \u3000" and i > 0}

    for j in range(1, k):
        m = _LEAD_MARK.match(o_texts[j])
        if not m:
            continue
        tok = m.group(1)
        for mm in re.finditer(re.escape(tok), text):
            if mm.start() > 0:
                struct_pos.add(mm.start())

    o_kanjis = [norm_cjk(x) for x in o_texts]
    word_bounds = _word_boundaries(text)

    return {
        "k": k,
        "targets": targets,
        "struct": struct_pos,
        "space": space_pos,
        "punct": punct_pos,
        "o_kanjis": o_kanjis,
        "word_bounds": word_bounds,
    }


def _cut_score(p: int, idx: int, tgt: float, ctx: dict, text: str) -> float:
    """切点打分：强吸附标点、空格、词边界、助词，结合汉字归属加成。"""
    s = abs(p - tgt)

    # 1. 中文词边界保护（严格惩罚切在多字词内部）
    word_bounds = ctx.get("word_bounds")
    if word_bounds is not None and p not in word_bounds:
        s += 12.0

    # 2. 自然语法与结构边界吸附（大幅强化，杜绝切碎汉字词汇）
    if p in ctx["struct"]:
        s -= 14.0
    elif p in ctx["space"]:
        s -= 9.0
    elif p in ctx["punct"]:
        s -= 7.0
    else:
        if text[p - 1] in _PARTICLE_AFTER:
            s -= 4.0
        if text[p] in _BOUNDARY_BEFORE:
            s -= 2.5

    # 3. 跨语种汉字归属分析
    o_kanjis = ctx.get("o_kanjis") or []
    if o_kanjis:
        left_k = norm_cjk(text[:p])
        right_k = norm_cjk(text[p:])
        k_bonus = 0.0
        if idx < len(o_kanjis):
            k_bonus += len(left_k & o_kanjis[idx]) * 1.5
        if idx + 1 < len(o_kanjis):
            k_bonus += len(right_k & o_kanjis[idx + 1]) * 1.5
            misplaced = len(left_k & (o_kanjis[idx + 1] - o_kanjis[idx]))
            s += misplaced * 4.0
        s -= k_bonus

    return s


def split_text(text: str, o_texts: list[str]) -> list[str]:
    """把一段译文按对应原文各行的长度比例切成若干段。"""
    k = len(o_texts)
    if k <= 1:
        return [text]

    # 空格快判：若译文中恰好有 k-1 个空格（自然划分为 k 段），且无汉字归属倒错，
    # 存在空格分界时直接切分，无需分词
    pieces = [p.strip() for p in re.split(r"[ \u3000]+", text.strip()) if p.strip()]
    if len(pieces) == k and all(len(p) >= 1 for p in pieces):
        o_kanjis = [norm_cjk(x) for x in o_texts]
        valid = True
        for idx in range(k - 1):
            left_k = norm_cjk(pieces[idx])
            if idx + 1 < len(o_kanjis):
                later_k = set().union(*o_kanjis[idx + 1:]) - o_kanjis[idx]
                if len(left_k & later_k) >= 1:
                    valid = False
                    break
        if valid:
            return pieces

    ctx = _cut_context(text, o_texts)

    cuts, prev = [], 0
    for idx, tgt in enumerate(ctx["targets"]):
        remain = k - 1 - idx
        pool = [p for p in range(prev + 1, len(text) - remain + 1)]
        if not pool:
            pool = [prev + 1]
        best = min(pool, key=lambda p: (_cut_score(p, idx, tgt, ctx, text), p))
        cuts.append(best)
        prev = best

    parts, start = [], 0
    for c in cuts + [len(text)]:
        parts.append(text[start:c].strip())
        start = c
    return parts


def explain_split(text: str, o_texts: list[str], top: int = 6):
    """列出第一刀的最佳候选及得分，用来自查。"""
    if len(o_texts) <= 1:
        return [], 0.0
    ctx = _cut_context(text, o_texts)
    tgt = ctx["targets"][0]
    rows = []
    for p in range(1, len(text)):
        score = _cut_score(p, 0, tgt, ctx, text)
        if p in ctx["struct"]:
            tags = "结构-14.0"
        elif p in ctx["space"]:
            tags = "空格-9.0"
        elif p in ctx["punct"]:
            tags = "标点-7.0"
        elif text[p - 1] in _PARTICLE_AFTER:
            tags = "助词-3.5"
        else:
            tags = "-"
        rows.append((p, score, tags, text[:p].strip()[:26]))
    rows.sort(key=lambda r: (r[1], r[0]))
    return rows[:top], tgt


# --------------------------------------------------------------------------
# 核心 2D 对齐代价评估与状态转移
# --------------------------------------------------------------------------
def _evaluate_group(
    trans_chunk: list[str],
    orig_chunk: list[str],
    ratio: float,
) -> tuple[float, str]:
    """评估一组译文 ↔ 一组原文 的匹配代价及操作类型。"""
    k_t = len(trans_chunk)
    k_o = len(orig_chunk)

    uniq_t = distinct_texts(trans_chunk)
    uniq_o = distinct_texts(orig_chunk)

    is_rep_t = (k_t > 1 and len(uniq_t) == 1)
    is_rep_o = (k_o > 1 and len(uniq_o) == 1)

    can_broadcast = (
        is_rep_o and k_t == 1 and k_o > 1
        and (weight(trans_chunk[0]) <= 1.35 * max(1.0, ratio * weight(orig_chunk[0])))
    )

    t_m = sum(weight(x) for x in uniq_t)
    o_m = sum(weight(x) for x in uniq_o) if can_broadcast else sum(weight(x) for x in orig_chunk)

    if o_m == 0:
        return 1.0, "match"

    expected = max(1.0, ratio * o_m)
    len_cost = abs(t_m - expected) / expected

    oc = norm_cjk("".join(orig_chunk))
    tc = norm_cjk("".join(trans_chunk))
    overlap = (len(tc & oc) / len(oc)) if oc else 0.0

    bonus = 0.0
    if k_t == 1 and k_o > 1:
        if can_broadcast:
            kind = "broadcast"
            base_pen = 0.15 * (k_o - 1)
        else:
            kind = "split"
            base_pen = 0.30 * (k_o - 1)
            text = trans_chunk[0]
            if " " in text or "　" in text:
                bonus += 0.10
            if any(p in text for p in "，,、；;"):
                bonus += 0.08
    elif k_t > 1 and k_o == 1:
        if is_rep_t:
            kind = "collapse"
            base_pen = 0.20 * (k_t - 1)
        else:
            kind = "merge"
            base_pen = 0.40 * (k_t - 1)
            o_clean = re.sub(r"^[-–—*・「『（(【\s]+", "", orig_chunk[0])
            if re.search(r"\S[ \u3000]+\S", o_clean):
                bonus += 0.06
    else:
        kind = "1:1"
        base_pen = 0.0

    # 符号锚点匹配加成
    o_joined = "".join(orig_chunk)
    t_joined = "".join(trans_chunk)
    o_quote = any(q in o_joined for q in "「」\"'")
    t_quote = any(q in t_joined for q in "「」\"'")
    if o_quote and t_quote:
        bonus += 0.15

    # 边界惩罚：切出非法单括号或首尾标点
    frag = 0.0
    first = trans_chunk[0].lstrip() if trans_chunk else ""
    last = trans_chunk[-1].rstrip() if trans_chunk else ""
    if first[:1] in ")]}）】」』,，。、!?！？;；":
        frag += 0.35
    if last[-1:] in "([{（【「『":
        frag += 0.35

    total_cost = len_cost - 0.40 * overlap + base_pen - bonus + frag
    return total_cost, kind


def reflow(trans_texts: list[str], orig_lines: list[dict]) -> ReflowResult:
    """把译文重排成与 orig_lines 一一对应（全局 2D 动态规划）。"""
    M, N = len(orig_lines), len(trans_texts)
    if M == 0 or N == 0:
        return ReflowResult(False, message="原文或译文为空")

    o_texts = [x["text"] for x in orig_lines]

    tot_o = sum(weight(x) for x in distinct_texts(o_texts)) or 1
    tot_t = sum(weight(x) for x in distinct_texts(trans_texts)) or 1
    ratio = tot_t / tot_o

    # 快速自检：如果行数一致且直接 1:1 的质量非常高，直接返回
    if M == N:
        costs = [_evaluate_group([trans_texts[i]], [o_texts[i]], ratio)[0] for i in range(M)]
        avg_cost = sum(costs) / M
        worst_cost = max(costs)
        # 只有在平均代价极低且最差行也良好时才直接采信，防止假性 m==n 全歌错位
        if avg_cost < 0.28 and worst_cost < 0.75:
            return ReflowResult(
                True,
                pairs=list(zip(orig_lines, trans_texts)),
                confidence=1.0,
                message="行数一致且逐行质量良好，无需拆并",
            )

    INF = float("inf")
    dp = [[INF] * (N + 1) for _ in range(M + 1)]
    back = [[None] * (N + 1) for _ in range(M + 1)]
    dp[0][0] = 0.0

    MAX_SPLIT = 5   # 1 句译文最多拆成多少行原文
    MAX_MERGE = 8   # 多少句译文最多合/折叠到 1 行原文

    for i in range(M + 1):
        for j in range(N + 1):
            if dp[i][j] == INF:
                continue
            cur = dp[i][j]

            # 转移 1：1 对 1
            if i + 1 <= M and j + 1 <= N:
                c, kind = _evaluate_group([trans_texts[j]], [o_texts[i]], ratio)
                if cur + c < dp[i + 1][j + 1]:
                    dp[i + 1][j + 1] = cur + c
                    back[i + 1][j + 1] = (i, j, kind, 1, 1, c)

            # 转移 2：1 译文拆为 k 原文 (split / broadcast)
            if j + 1 <= N:
                for k in range(2, min(MAX_SPLIT + 1, M - i + 1)):
                    c, kind = _evaluate_group([trans_texts[j]], o_texts[i : i + k], ratio)
                    if cur + c < dp[i + k][j + 1]:
                        dp[i + k][j + 1] = cur + c
                        back[i + k][j + 1] = (i, j, kind, k, 1, c)

            # 转移 3：k 译文合为 1 原文 (merge / collapse)
            if i + 1 <= M:
                for k in range(2, min(MAX_MERGE + 1, N - j + 1)):
                    c, kind = _evaluate_group(trans_texts[j : j + k], [o_texts[i]], ratio)
                    if cur + c < dp[i + 1][j + k]:
                        dp[i + 1][j + k] = cur + c
                        back[i + 1][j + k] = (i, j, kind, 1, k, c)

    if dp[M][N] == INF:
        return ReflowResult(False, message="找不到可行的划分")

    # 回溯最优对齐路径
    curr_i, curr_j = M, N
    steps = []
    while curr_i > 0 or curr_j > 0:
        prev = back[curr_i][curr_j]
        if prev is None:
            return ReflowResult(False, message="回溯失败")
        pi, pj, kind, ko, kt, step_cost = prev
        steps.append((pi, curr_i, pj, curr_j, kind, step_cost))
        curr_i, curr_j = pi, pj

    steps.reverse()

    ops: list[Op] = []
    pairs: list[tuple[dict, str]] = []

    for pi, ci, pj, cj, kind, step_cost in steps:
        chunk_orig = orig_lines[pi:ci]
        chunk_trans = trans_texts[pj:cj]

        if kind == "1:1":
            pairs.append((chunk_orig[0], chunk_trans[0]))
        elif kind == "split":
            parts = split_text(chunk_trans[0], [x["text"] for x in chunk_orig])
            for ln, pt in zip(chunk_orig, parts):
                pairs.append((ln, pt))
            ops.append(
                Op(
                    "split",
                    f"把 1 行译文拆成 {len(chunk_orig)} 段，对应原文 [{pi + 1}..{ci}]："
                    f"{chunk_trans[0][:34]!r}",
                    max(0.0, step_cost),
                )
            )
        elif kind == "broadcast":
            # 官方重复句广播：不拆碎，整句填入各行
            for ln in chunk_orig:
                pairs.append((ln, chunk_trans[0]))
            ops.append(
                Op(
                    "broadcast",
                    f"官方 [{pi + 1}..{ci}] 为重复演唱，已广播填入单句译文：{chunk_trans[0][:34]!r}",
                    max(0.0, step_cost),
                )
            )
        elif kind == "collapse":
            uniq = distinct_texts(chunk_trans)
            merged = join_texts(uniq)
            pairs.append((chunk_orig[0], merged))
            ops.append(
                Op(
                    "collapse",
                    f"原文第 {pi + 1} 行合并了重复段，译文 {len(chunk_trans)} 行已去重只留："
                    f"{merged[:34]!r}",
                    max(0.0, step_cost),
                )
            )
        elif kind == "merge":
            o_text = chunk_orig[0]["text"] if isinstance(chunk_orig[0], dict) else getattr(chunk_orig[0], "text", "")
            o_clean = re.sub(r"^[-–—*・「『（(【\s]+", "", o_text)
            if re.search(r"\S[ \u3000]+\S", o_clean):
                merged = " ".join(p.strip() for p in chunk_trans if p.strip())
            else:
                merged = join_texts(chunk_trans)
            pairs.append((chunk_orig[0], merged))
            ops.append(
                Op(
                    "merge",
                    f"把 {len(chunk_trans)} 行译文合并对应第 {pi + 1} 行原文："
                    f"{' | '.join(x[:20] for x in chunk_trans)}",
                    max(0.0, step_cost),
                )
            )

    if ops:
        avg = sum(o.score for o in ops) / len(ops)
        confidence = max(0.0, min(1.0, 1.0 - avg / 0.85))
    else:
        confidence = 1.0

    return ReflowResult(True, pairs=pairs, ops=ops, confidence=confidence, message="已自动重排")


# --------------------------------------------------------------------------
# 带用户对照原文的字符级对齐
# --------------------------------------------------------------------------
def reflow_with_source(
    trans_texts: list[str],
    src_texts: list[str],
    official_lines: list[dict],
) -> ReflowResult:
    """用用户对照原文做字符级对齐。"""
    if len(src_texts) != len(trans_texts):
        return ReflowResult(
            False,
            message=f"你给的原文 {len(src_texts)} 行 ≠ 译文 {len(trans_texts)} 行，无法一一对应",
        )
    m = len(official_lines)
    if m == 0 or not src_texts:
        return ReflowResult(False, message="原文或译文为空")

    a_text = "".join(src_texts)
    b_text = "".join(x["text"] for x in official_lines)
    if not a_text or not b_text:
        return ReflowResult(False, message="文本为空")

    def spans(lines: list[str]) -> list[tuple[int, int]]:
        out, pos = [], 0
        for s in lines:
            out.append((pos, pos + len(s)))
            pos += len(s)
        return out

    a_spans = spans(src_texts)
    b_spans = spans([x["text"] for x in official_lines])

    b_line_of = [0] * len(b_text)
    for j, (bs, be) in enumerate(b_spans):
        for p in range(bs, be):
            b_line_of[p] = j

    def _fold_kana(s: str) -> str:
        # 片假名映射为平假名（Unicode 码点相差 0x60，严格 1:1 等长，不改变字符下标）
        return "".join(
            chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c
            for c in s
        )

    # 字符级对齐：平假名/片假名归一化（等长），过滤单字符孤立噪点
    sm = difflib.SequenceMatcher(None, _fold_kana(a_text), _fold_kana(b_text), autojunk=False)
    a_to_b: list[int | None] = [None] * len(a_text)
    for blk in sm.get_matching_blocks():
        if blk.size <= 0:
            continue
        for k in range(blk.size):
            a_to_b[blk.a + k] = blk.b + k

    matched = sum(1 for v in a_to_b if v is not None)
    ratio = matched / max(1, len(a_text))

    per_b: list[list[tuple[int, str, bool]]] = [[] for _ in range(m)]
    unassigned: list[int] = []
    assigned_of: dict[int, int] = {}
    ops: list[Op] = []

    for i, (as_, ae) in enumerate(a_spans):
        hits = [a_to_b[p] for p in range(as_, ae) if a_to_b[p] is not None]
        if not hits:
            unassigned.append(i)
            continue

        # 统计落在各 official 行的命中次数，过滤单字符离群噪点
        counts = collections.Counter(b_line_of[p] for p in hits)
        total_hits = len(hits)
        significant = [
            ln for ln, cnt in counts.items()
            if cnt >= 2
            or (cnt >= 1 and total_hits <= 3)
            or (cnt / total_hits >= 0.15)
            or (cnt / max(1, len(official_lines[ln]["text"])) >= 0.30)
        ]
        if not significant:
            significant = [counts.most_common(1)[0][0]]

        significant.sort()
        # 确保 touched 行是连续的，若不连续则取主峰
        if significant[-1] - significant[0] >= len(significant):
            most_freq = counts.most_common(1)[0][0]
            touched = [most_freq]
        else:
            touched = significant

        if len(touched) == 1:
            per_b[touched[0]].append((i, trans_texts[i], False))
            assigned_of[i] = touched[0]
            continue

        parts = split_text(trans_texts[i], [official_lines[j]["text"] for j in touched])
        for j, part in zip(touched, parts):
            per_b[j].append((i, part, False))
            assigned_of[i] = j
        ops.append(
            Op(
                "split",
                f"你的原文[{i + 1}] 跨了官方第 {touched[0] + 1}..{touched[-1] + 1} 行，"
                f"已切开：{' | '.join(p[:16] for p in parts)}",
                max(0.0, 1.0 - ratio),
            )
        )

    for i in unassigned:
        prev = [k for k in assigned_of if k < i]
        if not prev:
            ops.append(
                Op(
                    "drop",
                    f"你的原文[{i + 1}] 在官方原文里找不到对应（疑似文件头），已丢弃："
                    f"{trans_texts[i][:30]!r}",
                    0.0,
                )
            )
            continue
        per_b[assigned_of[max(prev)]].append((i, trans_texts[i], True))

    pairs: list[tuple[dict, str]] = []
    for j, items in enumerate(per_b):
        if not items:
            pairs.append((official_lines[j], ""))
            continue
        items.sort(key=lambda t: t[0])

        kept: list[tuple[int, str]] = []
        seen_repeat = False
        dropped_repeats = 0
        for i, txt, is_rep in items:
            if is_rep:
                if seen_repeat:
                    dropped_repeats += 1
                    continue
                seen_repeat = True
            kept.append((i, txt))

        pieces = [txt for _, txt in kept]
        uniq = distinct_texts(pieces)
        if len(uniq) < len(pieces):
            merged = join_texts(uniq)
            kind = "collapse"
        else:
            o_text = official_lines[j]["text"]
            o_clean = re.sub(r"^[-–—*・「『（(【\s]+", "", o_text)
            if re.search(r"\S[ \u3000]+\S", o_clean):
                merged = " ".join(p.strip() for p in pieces if p.strip())
            else:
                merged = join_texts(pieces)
            kind = "merge" if len(pieces) > 1 else "="
        pairs.append((official_lines[j], merged))
        if kind != "=" or dropped_repeats:
            src_desc = " | ".join(f"原文[{i + 1}]" for i, _, _ in items)
            extra = f"，另丢弃 {dropped_repeats} 遍重复" if dropped_repeats else ""
            ops.append(
                Op(
                    kind if kind != "=" else "collapse",
                    f"官方第 {j + 1} 行 ← 你的 {src_desc}{extra}：{merged[:34]!r}",
                    max(0.0, 1.0 - ratio),
                )
            )

    confidence = min(1.0, ratio)
    return ReflowResult(True, pairs=pairs, ops=ops, confidence=confidence, message="按你的原文对轴")
