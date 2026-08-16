@echo off
chcp 65001 >nul
title 状态客户端
echo 正在启动状态客户端...
python "%~dp0status_client.py"
if errorlevel 1 (
    echo.
    echo 启动失败！请确保已安装 Python。
    echo 下载地址: https://www.python.org/downloads/
    echo 安装时请勾选 "Add Python to PATH"
    pause
)
