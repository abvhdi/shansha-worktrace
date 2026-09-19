#!/bin/zsh

cd -- "$(dirname -- "$0")/.." || exit 1

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "还需要安装 Node.js" message "请先在 nodejs.org 安装 LTS 版本，然后再双击这个文件。" as warning'
  open "https://nodejs.org/zh-cn/download"
  exit 1
fi

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install || exit 1
export WORKTRACE_FORCE_PORTABLE_OCR=1
npm start
