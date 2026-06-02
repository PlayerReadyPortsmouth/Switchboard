#!/usr/bin/env bash
# Launch a persistent Switchboard agent: a `claude --channels` session whose
# channel server is the Switchboard shim, pointed at this agent's hub socket.
#
# Usage: scripts/start-agent.sh <agent-name> [extra claude args...]
set -euo pipefail

AGENT="${1:?usage: start-agent.sh <agent-name> [claude args...]}"; shift || true
STATE_DIR="${SWITCHBOARD_STATE_DIR:-$HOME/.switchboard}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export AGENT_NAME="$AGENT"
export HUB_SOCKET="$STATE_DIR/${AGENT}.sock"

if [[ ! -S "$HUB_SOCKET" ]]; then
  echo "hub socket $HUB_SOCKET not found — start the hub first (bun run hub)" >&2
  exit 1
fi

# The shim is registered as a local channel MCP server via --channels.
# CLAUDE_CHANNEL_COMMAND tells claude how to spawn our shim for this session.
exec claude --channels "command:bun run $REPO_DIR/shim/server.ts" "$@"
