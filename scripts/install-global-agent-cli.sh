#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.local/bin"
TARGET_PATH="${TARGET_DIR}/codex-feishu-agent"

mkdir -p "${TARGET_DIR}"

cat >"${TARGET_PATH}" <<EOF
#!/usr/bin/env bash
exec node "${REPO_ROOT}/scripts/agent-manager-cli.mjs" "\$@"
EOF

chmod +x "${TARGET_PATH}"

echo "Installed global CLI:"
echo "  ${TARGET_PATH}"
echo ""
echo "You can now run:"
echo "  codex-feishu-agent help"
