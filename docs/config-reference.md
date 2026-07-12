# Configuration reference

## Canonical conversations

`conversationDbFile` optionally selects the SQLite file used for canonical conversations. A leading `~` is expanded to the hub user's home directory. When omitted, the exact default is `<stateDir>/switchboard.sqlite`.

Conversation HTTP routes trust the `X-Switchboard-User` request header as the authenticated identity. Deploy the web listener only behind a trusted proxy that strips any client-supplied copy of this header and sets it from the authenticated session; do not expose these routes directly to untrusted clients.

SQLite uses write-ahead logging while the hub is running. A consistent live backup must include both the configured database file and its `-wal` file, captured consistently, or be made with SQLite's backup command. After a clean hub shutdown, the database file can be backed up normally.
