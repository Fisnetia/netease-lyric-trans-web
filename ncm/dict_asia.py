"""ncm.dict_asia - Dict.Asia 在线日语词典查询与解析模块。

提供日汉 (jc)、汉日 (cj) 双向查词功能，涵盖假名发音、罗马音、音调、词性、
分条详细释义、参考例句及相关派生词汇解析。
"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request
from typing import Any, Dict, List


def clean_html_text(text: str) -> str:
    """深度剥离 HTML 标签及实体，并清除冗余空白和全角空格。"""
    if not text:
        return ""
    # 清理 HTML 标签
    clean = re.sub(r"<[^>]+>", "", text)
    # 处理常见 HTML 实体
    clean = (
        clean.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    return clean.strip("　 \t\r\n")


def parse_dict_asia(html: str, query: str) -> Dict[str, Any]:
    """解析 dict.asia 词条页面的 HTML 内容为结构化数据字典。"""
    # 检查未找到标记
    if "没找到[" in html:
        return {
            "query": query,
            "found": False,
            "entries": [],
            "message": f"未在 dict.asia 查找到关于“{query}”的释义",
        }

    entries: List[Dict[str, Any]] = []
    raw_blocks = html.split('<div id="jp_comment">')[1:]

    for block in raw_blocks:
        end_idx = block.find('<div class="ad">')
        block_content = block[:end_idx] if end_idx != -1 else block

        # 1. 词头
        m_word = re.search(r'<span[^>]*class="jpword"[^>]*>([\s\S]*?)</span>', block_content)
        word = clean_html_text(m_word.group(1)) if m_word else query

        # 2. 读音/假名（移除包裹符号）
        m_kana = re.search(r'<span[^>]*title="假名"[^>]*>([\s\S]*?)</span>', block_content)
        raw_kana = clean_html_text(m_kana.group(1)) if m_kana else ""
        kana_clean = raw_kana.strip("【】 \t　")

        # 3. 罗马音
        m_roma = re.search(r'<span[^>]*title="罗马音"[^>]*>([\s\S]*?)</span>', block_content)
        raw_roma = clean_html_text(m_roma.group(1)) if m_roma else ""
        romaji_clean = raw_roma.strip("【】 \t　")

        # 4. 音调
        m_tone = re.search(r'<span[^>]*class=[\'"]tone_jp[\'"][^>]*>([\s\S]*?)</span>', block_content)
        tone = clean_html_text(m_tone.group(1)) if m_tone else ""

        # 5. 释义与例句容器
        m_explain = re.search(r'<div[^>]*class="jp_explain"[^>]*>([\s\S]*?)</div>\s*</div>', block_content)
        explain_html = m_explain.group(1) if m_explain else ""

        m_comment = re.search(r'<span[^>]*class="commentItem"[^>]*>([\s\S]*?)</span>', explain_html)
        comment_body = m_comment.group(1) if m_comment else explain_html

        # 词性
        types = re.findall(r'<p class="wordtype">([\s\S]*?)</p>', comment_body)
        wordtype = clean_html_text(" ".join([clean_html_text(t) for t in types]))

        body_text = re.sub(r'<p class="wordtype">[\s\S]*?</p>', "", comment_body)

        # 例句提取
        examples = []
        for liju_m in re.finditer(r'<p class="liju">([\s\S]*?)</p>', body_text):
            liju_raw = liju_m.group(1)
            for line in re.split(r'<br\s*/?>', liju_raw):
                clean_line = clean_html_text(line)
                if clean_line:
                    examples.append(clean_line)

        # 释义分项提取
        def_text = re.sub(r'<p class="liju">[\s\S]*?</p>', "", body_text)
        defs = []
        for d in re.split(r'<br\s*/?>', def_text):
            clean_d = clean_html_text(d)
            if clean_d:
                defs.append(clean_d)

        entries.append({
            "word": word,
            "kana": kana_clean,
            "romaji": romaji_clean,
            "tone": tone,
            "type": wordtype,
            "definitions": defs,
            "examples": examples,
        })

    # 7. 相关词汇提取
    rel_words: List[str] = []
    for rel_m in re.finditer(r'<span class="words">([\s\S]*?)</span>', html):
        links = re.findall(r'<a[^>]*href="(/jc/[^"]+)"[^>]*>([\s\S]*?)</a>', rel_m.group(1))
        for _, text in links:
            t = clean_html_text(text)
            if t and t not in rel_words and t != query:
                rel_words.append(t)

    return {
        "query": query,
        "found": len(entries) > 0,
        "entries": entries,
        "related": rel_words[:12],
    }


def query_dict_asia(word: str, mode: str = "auto") -> Dict[str, Any]:
    """向 dict.asia 发起请求并解析。

    Args:
        word: 待查词条
        mode: 查询模式，支持 'auto' (智能判断), 'jc' (日中), 'cj' (中日)
    """
    word = word.strip()
    if not word:
        return {"ok": False, "found": False, "message": "请输入要查询的词条"}

    # 检测是否包含日文假名
    has_kana = bool(re.search(r"[\u3040-\u309F\u30A0-\u30FF]", word))

    if mode == "jc":
        modes_to_try = ["jc"]
    elif mode == "cj":
        modes_to_try = ["cj"]
    else:
        # auto 模式：如果包含假名，优先日中；纯汉字/其它字符则先日中、无果再转中日
        modes_to_try = ["jc", "cj"] if not has_kana else ["jc"]

    last_res: Dict[str, Any] | None = None
    for m in modes_to_try:
        url = f"https://dict.asia/{m}/{urllib.parse.quote(word)}"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=9) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
                res = parse_dict_asia(html, word)
                res["actual_mode"] = m
                res["source_url"] = f"https://dict.asia/{m}/{urllib.parse.quote(word)}"
                if res["found"]:
                    res["ok"] = True
                    return res
                last_res = res
        except Exception as e:
            last_res = {"ok": False, "found": False, "message": f"请求 dict.asia 失败: {str(e)}"}

    if last_res:
        last_res["ok"] = True
        return last_res
    return {"ok": False, "found": False, "message": "未获取到查询结果"}
