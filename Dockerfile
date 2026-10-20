FROM python:3.11-slim

# 创建非 root 用户 (UID 1000) 符合 Hugging Face Spaces 安全规范
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1

WORKDIR $HOME/app

# 安装依赖
COPY --chown=user:user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# 复制项目代码
COPY --chown=user:user . .

# 暴露端口
EXPOSE 7860

# 启动服务
CMD ["python", "gui.py", "--host", "0.0.0.0", "--port", "7860", "--no-browser"]
