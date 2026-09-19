#!/bin/zsh

cd -- "$(dirname -- "$0")/.." || exit 1

if [[ ! -d "node_modules/electron" ]]; then
  osascript -e 'display alert "珊莎工作留痕需要先准备运行环境" message "首次运行会安装本地依赖，完成后会自动打开软件。" as informational'
  export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  npm install || exit 1
fi

export WORKTRACE_FORCE_PORTABLE_OCR=1
npm start
