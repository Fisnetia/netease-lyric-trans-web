# NetEase Lyric Translator Web

[中文](README_zh.md)

An elegant, all-in-one web toolbox for bilingual lyric translation, timeline alignment, and lyrics editing.

## Features

- **Lyric Search & Inspector**: Search NetEase Cloud Music songs and inspect original, translated, romaji, and merged bilingual lyrics.
- **Smart Timeline Aligner**: Automatically align un-timed translation text to timed source lyrics with semantic reflow.
- **Bilingual Lyric Editor**: Side-by-side editing with synchronized scrolling, timestamp shifting, and instant preview.
- **Format Verification**: Real-time channel and formatting diagnostics for timestamp consistency and slot matching.
- **Japanese Dictionary**: Built-in online dictionary lookups and kana conversion tools.
- **Local & Privacy-Focused**: No login required. All manuscripts and drafts are stored locally in the browser.

## Quick Start

### Method 1: Portable Version (Recommended for Windows)

Download `netease-lyric-trans-portable-win64.zip` from [Releases](https://github.com/Fisnetia/netease-lyric-trans-web/releases).  
Extract and double-click `启动工作台.exe` to run. No Python installation or package setup required.

### Method 2: Run with Python

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Launch:

```bash
python gui.py
```

Then open `http://127.0.0.1:8765/` in your browser.

## License

[MIT](LICENSE)
