"""网易云双语歌词工作台 (Web版) —— 官方 Embed 绿色便携版一键打包脚本。
"""

import os
import sys
import shutil
import urllib.request
import zipfile
import subprocess
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
DIST_DIR = ROOT / "dist"
CACHE_DIR = DIST_DIR / ".cache"
BUILD_DIR = DIST_DIR / "netease-lyric-trans-portable"
OUTPUT_ZIP = DIST_DIR / "netease-lyric-trans-portable-win64.zip"

PYTHON_EMBED_VERSION = "3.12.7"
PYTHON_EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_EMBED_VERSION}/python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"

REQUIRED_PACKAGES = [
    "fastapi>=0.100.0",
    "uvicorn>=0.22.0",
    "requests>=2.28.0",
    "cryptography>=41.0.0"
]

def download_file(url: str, dest: pathlib.Path, desc: str):
    if dest.exists() and dest.stat().st_size > 0:
        print(f"[{desc}] 使用本地缓存: {dest.name}")
        return
    print(f"[{desc}] 正在下载: {url} -> {dest.name} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)
    print(f"[{desc}] 下载完成（大小: {dest.stat().st_size / (1024*1024):.2f} MB）")

def step_prepare_embed_python(embed_target: pathlib.Path):
    embed_zip = CACHE_DIR / f"python-{PYTHON_EMBED_VERSION}-embed-amd64.zip"
    get_pip_py = CACHE_DIR / "get-pip.py"

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    download_file(PYTHON_EMBED_URL, embed_zip, "Python 运行时")
    download_file(GET_PIP_URL, get_pip_py, "Pip 安装引导")

    if embed_target.exists():
        shutil.rmtree(embed_target)
    embed_target.mkdir(parents=True, exist_ok=True)

    print("[解压] 释放 Python Embed 运行时...")
    with zipfile.ZipFile(embed_zip, "r") as z:
        z.extractall(embed_target)

    # 修改 python312._pth，解除 site 导入限制
    pth_file = embed_target / f"python{PYTHON_EMBED_VERSION[:4].replace('.', '')}._pth"
    if pth_file.exists():
        content = pth_file.read_text(encoding="utf-8")
        lines = [line.strip() for line in content.splitlines()]
        new_lines = []
        for line in lines:
            if line == "#import site":
                new_lines.append("import site")
            else:
                new_lines.append(line)
        if "Lib\\site-packages" not in new_lines:
            new_lines.insert(1, "Lib\\site-packages")
        pth_file.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

    py_exe = embed_target / "python.exe"

    # 安装 pip
    print("[依赖] 为便携版注入 pip 包管理器...")
    cmd_pip = [str(py_exe), str(get_pip_py), "--no-warn-script-location", "--quiet"]
    res = subprocess.run(cmd_pip, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"安装 pip 失败: {res.stderr}")

    # 安装全部业务依赖 (4 个核心包)
    print(f"[依赖] 预装核心三方库 ({', '.join(REQUIRED_PACKAGES)})...")
    cmd_reqs = [
        str(py_exe), "-m", "pip", "install"
    ] + REQUIRED_PACKAGES + [
        "-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
        "--no-warn-script-location", "--quiet"
    ]
    res_req = subprocess.run(cmd_reqs, capture_output=True, text=True)
    if res_req.returncode != 0:
        raise RuntimeError(f"安装依赖失败: {res_req.stderr}")

    print("[清理] 剔除便携环境中不必要的构建缓存...")
    for root, dirs, files in os.walk(embed_target):
        if "__pycache__" in dirs:
            shutil.rmtree(os.path.join(root, "__pycache__"), ignore_errors=True)

def step_copy_project_files(target_dir: pathlib.Path):
    print("[复制] 同步 Web 版核心代码与前端资源...")

    for dir_name in ["ncm", "web", "vendor"]:
        src_d = ROOT / dir_name
        if src_d.is_dir():
            dst_d = target_dir / dir_name
            if dst_d.exists():
                shutil.rmtree(dst_d)
            shutil.copytree(src_d, dst_d, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    copy_files = [
        "gui.py",
        "README_zh.md",
        "README.md",
    ]
    for fn in copy_files:
        src_f = ROOT / fn
        if src_f.is_file():
            shutil.copy2(src_f, target_dir / fn)

def step_create_launchers(target_dir: pathlib.Path):
    print("[创建] 编译原生 EXE 启动器 (启动工作台.exe)...")

    csc = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    ico_file = ROOT / "web" / "favicon.ico"
    if not ico_file.exists():
        ico_file = ROOT / "favicon.ico"

    cs_file = CACHE_DIR / "Launcher.cs"
    exe_file = target_dir / "启动工作台.exe"

    cs_code = """using System;
using System.Diagnostics;
using System.IO;

class Program
{
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string pyExe = Path.Combine(dir, "python", "python.exe");
        string guiPy = Path.Combine(dir, "gui.py");

        if (!File.Exists(pyExe))
        {
            Console.WriteLine("[Error] Python runtime not found at: " + pyExe);
            WaitKey();
            return 1;
        }

        Console.Title = "NCM Lyric Uploader";

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = pyExe;
        string cmdArgs = "\\"" + guiPy + "\\"";
        for (int i = 0; i < args.Length; i++)
        {
            cmdArgs += " \\"" + args[i] + "\\"";
        }
        psi.Arguments = cmdArgs;
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;

        try
        {
            using (Process proc = Process.Start(psi))
            {
                proc.WaitForExit();
                int code = proc.ExitCode;
                if (code != 0)
                {
                    Console.WriteLine();
                    Console.WriteLine("  [Server stopped with code " + code + "]  Press any key to close this window...");
                    WaitKey();
                }
                return code;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[Error] Failed to start application: " + ex.Message);
            WaitKey();
            return 1;
        }
    }

    static void WaitKey()
    {
        try
        {
            if (Environment.UserInteractive && !Console.IsInputRedirected)
            {
                Console.ReadKey();
            }
        }
        catch { }
    }
}
"""
    cs_file.write_text(cs_code, encoding="utf-8")
    if os.path.exists(csc):
        cmd = [csc, "/nologo", "/utf8output", "/target:exe"]
        if ico_file.exists():
            cmd.append(f"/win32icon:{ico_file}")
        cmd.extend([f"/out:{exe_file}", str(cs_file)])
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if res.returncode == 0:
            print("[创建] 已成功编译带图标的 启动工作台.exe")
        else:
            raise RuntimeError(f"编译 EXE 失败: {res.stderr}")

def step_create_zip(source_dir: pathlib.Path, zip_file: pathlib.Path):
    print(f"[打包] 压缩生成最终 Release 压缩包: {zip_file.name} ...")
    if zip_file.exists():
        zip_file.unlink()

    with zipfile.ZipFile(zip_file, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(source_dir):
            if "__pycache__" in dirs:
                dirs.remove("__pycache__")
            for f in files:
                fp = pathlib.Path(root) / f
                arcname = fp.relative_to(source_dir.parent)
                z.write(fp, arcname)

    size_mb = zip_file.stat().st_size / (1024 * 1024)
    print(f"============================================================")
    print(f" Web版 打包完成！")
    print(f" 文件路径: {zip_file}")
    print(f" 压缩包体积: {size_mb:.2f} MB")
    print(f"============================================================")

def main():
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    embed_target = BUILD_DIR / "python"
    step_prepare_embed_python(embed_target)
    step_copy_project_files(BUILD_DIR)
    step_create_launchers(BUILD_DIR)
    step_create_zip(BUILD_DIR, OUTPUT_ZIP)

if __name__ == "__main__":
    main()
