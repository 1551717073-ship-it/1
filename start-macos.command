#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或更高版本，然后重新运行此脚本。'
  read -r -p '按回车退出…' ignored
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo '需要 Node.js 22 或更高版本。'
  exit 1
fi
read -r -p '输入要管理的文件夹绝对路径（直接回车使用当前项目）：' selected_root
selected_root="${selected_root:-$PWD}"
if [ ! -d "$selected_root" ]; then
  echo '该文件夹不存在。请输入路径，不需要添加引号。'
  exit 1
fi
exec node server.mjs --root "$selected_root"
