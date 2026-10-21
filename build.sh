#!/usr/bin/env bash
# 从源码构建并打包本插件（纯前端插件）：bash build.sh
#
# 步骤：npm ci（首次）→ 单测 → vite build（UMD）→ 组装 .kpp → kimpo-plugin-sign lint →（可选）签名。
# 产物：release/<plugin_id>-<version>.kpp（ZIP，manifest.json 位于包根）。
# 包内：manifest.json / config.schema.json 与配置预览图（若 manifest 声明了 config_schema）/
#       frontend/plugin.umd.js / frontend/locales/（插件语言包）
#
# 环境变量：
#   KIMPO_PLUGIN_SIGNING_KEY_FILE  私钥文件路径；设置了就在打包后签名（可选）
#   KIMPO_PLUGIN_LINT_FLAGS        追加给 kimpo-plugin-sign lint 的参数（可选）
#   KIMPO_PLUGIN_SKIP_LINT=1       跳过打包后的 manifest 离线预检
#   KIMPO_PLUGIN_SKIP_TESTS=1      跳过前端单测
#
# 注意：manifest.json 里的插件 ID 属于 Kimposoft 保留命名空间，官方签名只由 Kimposoft 发布。
# 自行构建的包请先把 plugin_id（以及 i18n.namespace）改成你自己的插件 ID，再以第三方身份安装；
# 否则 lint 会报保留命名空间错误。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

mf() { node -e 'const m=require("./manifest.json");const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],m);process.stdout.write(v==null?"":String(v))' "$1"; }
PLUGIN_ID=$(mf plugin_id)
VER=$(mf version)
GLOBAL_NAME=$(mf capabilities.frontend.global_name)
CONFIG_SCHEMA=$(mf config_schema)
# 前端 SDK 版本（frontend/package.json 依赖 @kimposoft/plugin-sdk 的精确版本），签名工具按同版本 go run
SDK_VERSION=$(node -p 'require("./frontend/package.json").dependencies["@kimposoft/plugin-sdk"]')

# ---- 前端构建 ----
(
  cd frontend
  [ -d node_modules ] || npm ci --no-audit --no-fund
  [ "${KIMPO_PLUGIN_SKIP_TESTS:-}" = "1" ] || npm test
  npx vite build
  # UMD 全局名必须与 manifest capabilities.frontend.global_name 一致
  grep -q "$GLOBAL_NAME" dist/plugin.umd.js || { echo "plugin.umd.js 里找不到全局名 $GLOBAL_NAME" >&2; exit 1; }
)

# ---- 打包 ----
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/frontend"
cp manifest.json "$STAGE/"
cp frontend/dist/plugin.umd.js "$STAGE/frontend/plugin.umd.js"
cp -R frontend/locales "$STAGE/frontend/locales"
if [ -n "$CONFIG_SCHEMA" ]; then
  cp "$CONFIG_SCHEMA" "$STAGE/$CONFIG_SCHEMA"
  # 配置项枚举缩略图（config schema 顶层字段的 x-enum-previews）随包分发，路径相对包根
  node -e '
    const s=require(require("path").resolve(process.argv[1]));
    for (const p of Object.values(s.properties||{})) for (const f of Object.values(p["x-enum-previews"]||{})) console.log(f);
  ' "$CONFIG_SCHEMA" | while read -r rel; do
    mkdir -p "$STAGE/$(dirname "$rel")"
    cp "$rel" "$STAGE/$rel"
  done
fi
mkdir -p release
OUT="$HERE/release/$PLUGIN_ID-$VER.kpp"
rm -f "$OUT"
(cd "$STAGE" && zip -qrX "$OUT" .)

# ---- 签名 / 预检工具定位：PATH 里的 kimpo-plugin-sign → 按 SDK 版本 go run（需要 Go）----
SIGN_TOOL=()
if command -v kimpo-plugin-sign >/dev/null 2>&1; then
  SIGN_TOOL=(kimpo-plugin-sign)
elif command -v go >/dev/null 2>&1; then
  SIGN_TOOL=(env GOWORK=off go run "github.com/kimposoft/kimpo-plugin-sdk/cmd/kimpo-plugin-sign@v$SDK_VERSION")
fi

# ---- manifest 离线预检（lint）：按宿主安装期规则检查 manifest 与包内文件，error 级问题直接失败 ----
if [ "${KIMPO_PLUGIN_SKIP_LINT:-}" != "1" ]; then
  if [ ${#SIGN_TOOL[@]} -gt 0 ]; then
    # shellcheck disable=SC2086
    "${SIGN_TOOL[@]}" lint ${KIMPO_PLUGIN_LINT_FLAGS:-} "$OUT" >&2
  else
    echo "提示：没找到 kimpo-plugin-sign（也没有 Go），跳过 manifest 预检" >&2
  fi
fi

# ---- 可选签名：设置了 KIMPO_PLUGIN_SIGNING_KEY_FILE 才签，否则产出未签名包 ----
if [ -n "${KIMPO_PLUGIN_SIGNING_KEY_FILE:-}" ]; then
  [ ${#SIGN_TOOL[@]} -gt 0 ] || { echo "签名失败：没找到 kimpo-plugin-sign（把它加进 PATH，或安装 Go）" >&2; exit 1; }
  "${SIGN_TOOL[@]}" sign -key "$KIMPO_PLUGIN_SIGNING_KEY_FILE" "$OUT" >&2
fi
echo "$OUT"
