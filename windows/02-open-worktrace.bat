@echo off
chcp 936 >nul
title 珊莎工作留痕
cd /d "%~dp0.."

if not exist "node_modules\electron\dist\electron.exe" goto not_ready
call npm start
exit /b 0

:not_ready
echo 尚未完成首次准备，请先双击“01-first-run.bat”。
pause
exit /b 1
