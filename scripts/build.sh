#!/bin/sh
# 构建页面与服务：受限脚本项目无打包步骤，这里做可重复的构建校验——
# 1) 全部服务端源码语法检查；2) 页面关键元素齐备；3) 准备数据目录。
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "[build] 语法检查 src/**/*.js"
for f in src/*.js; do
  node --check "$f"
done

echo "[build] 校验复核页面关键元素"
for marker in "飞控令牌移交复核台" "提交复核" "按标识读回" "DOUBLE_CONSUME" "BRANCH_MISMATCH"; do
  if ! grep -q "$marker" src/public/index.html; then
    echo "[build] 页面缺少关键内容: $marker" >&2
    exit 1
  fi
done

mkdir -p data
echo "[build] 完成：页面 src/public/index.html，服务 src/server.js"
