# Web workspace operations

The responsive workspace is served by the hub at `/`; `/agents` is its transport-independent agent-management destination. The compatibility dashboard remains available at `/legacy` throughout the Phase 4 rollout.

## Enable the Agents destination

The destination is default-off. Enable it explicitly in `config/hub.config.json`:

```json
{
  "workspace": {
    "features": { "agents": true },
    "viewers": ["viewer@example.com"],
    "operators": ["operator@example.com"]
  }
}
```

`workspace.viewers` can inspect sanitized status, sessions, and configuration. `workspace.operators` can also preview and confirm configuration and runtime actions. Either list accepts `"*"` to match every trusted identity; an operator match takes precedence over a viewer match. For compatibility, if both lists are absent, every trusted identity is an operator. Once either list is present, access is explicit and unmatched identities cannot discover the Agents API or route.

Switchboard does not authenticate the configured `webIdentityHeader` (default `X-Switchboard-User`). Deploy behind a trusted authenticating proxy that removes caller-supplied copies and writes exactly one verified identity header. Do not expose the header boundary directly to untrusted clients.

## Configure and operate agents

Configuration has Guided and Advanced JSON modes backed by one draft. Guided changes appear immediately in JSON, and valid JSON updates the guided fields. Configured opaque runtime values remain redacted; they can be preserved, replaced with a new value, or removed without revealing the previous value.

Every change is previewed and classified before confirmation:

- **Apply changes** applies safe changes without restarting the agent.
- **Apply and restart agent** confirms a hard change and respawns that agent.
- **Save pending hub restart** persists a full-restart change. Switchboard never restarts the hub automatically.

Runtime actions use a separate impact preview. **Reset** clears resumable context. **Restart** restarts the process while keeping its session file. **Remove** saves the configuration removal, but the running agent remains until the hub restarts. Confirmation is disabled while the browser is offline; local configuration drafts are retained for retry.

## Rollout and rollback

Build and start the same Bun application with `bun run hub`, then visit `/agents`. The Agents service, authorization, audit path, and ordered event stream do not depend on Discord; the destination works with `discord.enabled: false`, and `/legacy` shares this transport-independent service. Discord remains fully functional through its existing compatibility path, which does not yet call `AgentOperationsService`. Future Slack, Teams, and other adapters should converge on these application boundaries instead of duplicating agent operations.

To roll back the new destination, set `workspace.features.agents` to `false` and restart the hub. Agent configuration remains intact, and `/legacy` stays available. Keep `/legacy` until Approvals, Operations, Settings, Phase 4B capability parity, and the operational soak gate are complete.
