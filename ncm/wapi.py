"""网易云 weapi 参数加密。

复刻 NeteaseCloudMusicApi / crypto.js 的算法，不依赖 Node：

    明文 JSON
      -> AES-128-CBC(PRESET_KEY, IV)        -> base64
      -> AES-128-CBC(random_secret, IV)     -> base64   == params
    random_secret
      -> 反转字符串 -> hex -> 当大整数做模幂 -> 左补零到 256 位 hex == encSecKey

注意 weapi 只覆盖一部分接口；有写操作接口可能需要 eapi（见 eapi.py）。
"""

from __future__ import annotations

import base64
import json
import secrets

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PRESET_KEY = b"0CoJUm6Qyw8W8jud"
IV = b"0102030405060708"
PUB_KEY = "010001"
MODULUS = (
    "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a8"
    "76aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af"
    "6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741"
    "d546b8e289dc6935b3ece0462db0a22b8e7"
)
SECRET_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

_BLOCK = 16


def _pad(data: bytes) -> bytes:
    n = _BLOCK - (len(data) % _BLOCK)
    return data + bytes([n]) * n


def _aes_encrypt(text: str, key: bytes) -> str:
    enc = Cipher(algorithms.AES(key), modes.CBC(IV)).encryptor()
    ct = enc.update(_pad(text.encode("utf-8"))) + enc.finalize()
    return base64.b64encode(ct).decode("ascii")


def _rsa_encrypt(secret: str) -> str:
    hex_text = secret[::-1].encode("ascii").hex()
    base = hex_text[:256]
    ret = pow(int(base, 16), int(PUB_KEY, 16), int(MODULUS, 16))
    return format(ret, "x").rjust(256, "0")


def weapi(data: dict) -> dict:
    """把业务参数加密成 weapi 表单体 {params, encSecKey}。"""
    text = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    secret = "".join(secrets.choice(SECRET_CHARS) for _ in range(16))
    params = _aes_encrypt(_aes_encrypt(text, PRESET_KEY), secret.encode("ascii"))
    return {"params": params, "encSecKey": _rsa_encrypt(secret)}


def _self_check() -> None:
    assert len(MODULUS) == 256, f"modulus 长度应为 256，实际 {len(MODULUS)}"
    body = weapi({"foo": "中文", "n": 1})
    assert set(body) == {"params", "encSecKey"}
    assert len(body["encSecKey"]) == 256
    assert isinstance(body["params"], str) and body["params"]


if __name__ == "__main__":
    _self_check()
    print("weapi self-check ok")
