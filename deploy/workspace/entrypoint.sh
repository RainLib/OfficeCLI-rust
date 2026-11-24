#!/bin/sh
set -eu

root=${FOLDLY_ROOT:-/var/lib/foldly/workspace}
public_url=${FOLDLY_PUBLIC_URL:-http://localhost:7400}
port=${FOLDLY_INTERNAL_PORT:-7400}
cli=/opt/foldly/app/cli.mjs

case "${1:-serve}" in
  health)
    exec gosu node node -e '
      const fs = require("node:fs");
      const config = JSON.parse(fs.readFileSync(process.argv[1] + "/config.json", "utf8"));
      const request = require("node:http").get(new URL("/workspace/api/status", config.callbackUrl), {
        headers: { Host: new URL(config.publicUrl).host },
        signal: AbortSignal.timeout(2500),
      }, response => {
        response.resume();
        if (response.statusCode !== 200) {
          console.error(`Workspace health returned HTTP ${response.statusCode}`);
          process.exitCode = 1;
        }
      });
      request.on("error", error => {
        console.error(error.message);
        process.exitCode = 1;
      });
    ' "$root"
    ;;
esac

if [ -n "${FOLDLY_DATABASE_URL_FILE:-}" ]; then
  if [ -n "${FOLDLY_DATABASE_URL:-}" ] || [ ! -s "$FOLDLY_DATABASE_URL_FILE" ]; then
    echo "请配置一个有效的工作台数据库连接文件。" >&2
    exit 1
  fi
  FOLDLY_DATABASE_URL=$(cat "$FOLDLY_DATABASE_URL_FILE")
  export FOLDLY_DATABASE_URL
  unset FOLDLY_DATABASE_URL_FILE
fi

if [ "${1:-serve}" != serve ]; then exec gosu node node "$cli" "$@"; fi

if [ ! -e "$root/config.json" ]; then
  password_file=${FOLDLY_ADMIN_PASSWORD_FILE:-/run/secrets/foldly_admin_password}
  if [ ! -s "$password_file" ]; then
    echo "首次启动需要管理员密码文件：$password_file" >&2
    exit 1
  fi
  set -- init --root "$root" --public-url "$public_url" --port "$port" \
    --bind-host :: --engine-port "${FOLDLY_ENGINE_PORT:-7401}" \
    --collab-port "${FOLDLY_COLLAB_PORT:-7402}" --admin "${FOLDLY_ADMIN:-admin}" \
    --name "${FOLDLY_WORKSPACE_NAME:-Foldly 工作空间}"
  if [ "${FOLDLY_SELECTION_MCP:-false}" = true ]; then set -- "$@" --selection-mcp; fi
  if [ -n "${FOLDLY_DATABASE:-}" ]; then set -- "$@" --database "$FOLDLY_DATABASE"; fi
  OFFICECLI_BOOTSTRAP_PASSWORD="$(cat "$password_file")" gosu node node "$cli" "$@"
fi

# Restored workspaces retain their domain, ports, identity and keys.
gosu node node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1] + "/config.json", "utf8"));
  if (config.publicUrl !== new URL(process.argv[2]).origin || config.port !== Number(process.argv[3])) {
    console.error("请将 FOLDLY_PUBLIC_URL 和 FOLDLY_INTERNAL_PORT 设置为已有工作空间的地址与端口。");
    process.exit(1);
  }
  const expected = process.env.FOLDLY_DATABASE;
  if (expected && expected !== (config.database?.kind ?? "sqlite")) {
    console.error("FOLDLY_DATABASE 与已初始化的工作区不一致。请用备份恢复到新工作区，再切换入口。");
    process.exit(1);
  }
' "$root" "$public_url" "$port"
exec gosu node node "$cli" start --root "$root" --bind-host :: --drain-on-stop
