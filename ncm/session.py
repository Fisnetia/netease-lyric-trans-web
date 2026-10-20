"""只读网易云 HTTP 客户端。

负责传输层：URL 拼接、WeAPI 参数加密以及统一异常处理。
运行于纯匿名模式，无需任何登录凭据或本地 Cookie 文件。
"""

from __future__ import annotations

import time
from urllib.parse import urlencode

import requests

from .wapi import MODULUS, PRESET_KEY, weapi  # noqa: F401

BASE = "https://music.163.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


class NcmError(RuntimeError):
    """接口返回异常。"""


class NcmClient:
    def __init__(self, timeout: int = 15):
        self.timeout = timeout
        self.http = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=25, pool_maxsize=25, max_retries=1
        )
        self.http.mount("https://", adapter)
        self.http.mount("http://", adapter)
        self.http.headers.update(
            {
                "User-Agent": UA,
                "Referer": f"{BASE}/",
                "Origin": BASE,
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
            }
        )

    def keepalive_ping(self) -> bool:
        """轻量保活探测。"""
        try:
            r = self.http.get(
                f"{BASE}/api/rep/ugc/song/info/id/get",
                params={"songId": 0},
                timeout=5,
            )
            return r.status_code < 500
        except Exception:
            return False

    def weapi_post(
        self,
        path: str,
        data: dict,
        *,
        query: dict | None = None,
        retries: int = 2,
    ) -> dict:
        """POST /weapi/<path>，加密请求体。"""
        url = f"{BASE}/weapi/{path.lstrip('/')}"
        if query:
            url += "?" + urlencode(query)
        if "csrf_token" not in data:
            data = {**data, "csrf_token": ""}
        last: Exception | None = None
        for attempt in range(retries + 1):
            try:
                r = self.http.post(url, data=weapi(data), timeout=self.timeout)
                r.raise_for_status()
                return r.json()
            except Exception as exc:
                last = exc
                if attempt < retries:
                    time.sleep(1.5 * (attempt + 1))
        raise NcmError(f"请求 {url} 失败: {last}") from last

    def get_json(self, path: str, params: dict | None = None) -> dict:
        url = f"{BASE}/{path.lstrip('/')}"
        r = self.http.get(url, params=params or {}, timeout=self.timeout)
        r.raise_for_status()
        return r.json()
