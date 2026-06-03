#!/usr/bin/env bash
# Launch a persistent Switchboard agent. Thin wrapper around start-agent.ts, which
# loads the agent's config (model / appendSystemPrompt / claudeArgs) and the
# hub's <stateDir>/.env before exec'ing `claude --channels`.
#
# Usage: scripts/start-agent.sh <agent-name> [extra claude args...]
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun run "$DIR/start-agent.ts" "$@"
