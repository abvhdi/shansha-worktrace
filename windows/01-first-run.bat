@echo off
chcp 936 >nul
title 珊莎工作留痕 - 首次运行
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 goto no_node

echo [1/2] 正在准备 Windows 运行组件，第一次可能需要几分钟...
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
call npm install
if errorlevel 1 goto install_failed

echo [2/2] 正在打开珊莎工作留痕...
call npm start
exit /b 0

:no_node
echo.
echo 这台电脑还没有安装 Node.js。
echo 请先安装 Node.js LTS，再重新双击本文件：
echo https://nodejs.org/zh-cn/download
echo.
pause
exit /b 1

:install_failed
echo.
echo 运行组件安装失败，请检查网络后重试。
echo 如果仍然失败，请把这个窗口的内容截图发给开发者。
echo.
pause
exit /b 1
