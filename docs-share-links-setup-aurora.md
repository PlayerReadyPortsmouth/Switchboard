# Runbook: standing up a second Switchboard instance with ReadyApp share-links

**Audience:** a colleague (e.g. Stephen Parkinson / "Ai Whisperer") running their own Switchboard
hub on their own infrastructure, who wants their agents to be able to call `publish_link` and get
back a working `https://readyapp.player-ready.co.uk/share/<token>` URL — the same gated-link
system Aurora's instance already uses.

**Owner of each step is marked** — some steps must be run by Aurora (RA VPS root/admin access),
some by the colleague (their own box).

## 0. How this actually works (read this first)

`publish_link` in Switchboard is **local-filesystem-only** — it has no SSH/SCP/network push
built in (see `docs/config-reference.md` §7.1). The design explicitly assumes producer and
renderer share one filesystem. On Aurora's side, Switchboard and the ReadyApp renderer already
run on the same VPS (`readyapp-newvps`, `57.129.139.18`), both pointed at `/srv/share-artifacts`.

For a **second, independently-hosted** Switchboard to produce links the *same* renderer can
serve, its `hub.shareLinks.artifactsDir` needs to resolve to that exact same directory. Since
the app can't do this over the network itself, we make the OS do it: mount
`/srv/share-artifacts` from the ReadyApp VPS onto the colleague's box over SSHFS, at the local
path their `hub.config.json` points at. Switchboard then writes local files as normal, completely
unaware they're landing on a remote box.

```
┌─────────────────────────┐        SSHFS mount        ┌──────────────────────────────┐
│ Colleague's box          │  (restricted sftp user)   │ readyapp-newvps 57.129.139.18 │
│                          │ ──────────────────────────▶ /srv/share-artifacts          │
│ Switchboard hub          │   writes land here as if  │  ├── <token>/meta.sbmd        │
│  shareLinks.artifactsDir │   local                    │  └── <token>/<file>           │
│  = /mnt/ra-share-artifacts                            │                                │
│                          │                            │ ReadyApp API (pm2: api)       │
│                          │                            │  GET /share/:token            │
│                          │                            │  ARTIFACTS_DIR=/srv/share-... │
└─────────────────────────┘                            └──────────────────────────────┘
```

**Important constraint to set expectations with your colleague up front:** the renderer gates
on `requireRole(staffRoles)` against **ReadyApp's own Entra tenant** (`docs/config-reference.md`
§8). Only people who already have a ReadyApp staff account (ADMIN/AP_COORDINATOR/STAFF/TUTOR)
can open the resulting links — this is for delivering things *to* Aurora's team, not a general
file-sharing tool for the colleague's own org.

---

## 1. [Aurora, on the RA VPS] Provision a restricted account for the mount

Do **not** hand out the existing `ubuntu@57.129.139.18` account or a full-shell key — that's a
much bigger trust grant than this needs. Create a dedicated SFTP-only user, chrooted to just
`/srv/share-artifacts`, that can read+write inside it and nothing else on the box.

```bash
# On readyapp-newvps, as root/sudo
sudo groupadd sftp-share 2>/dev/null || true
sudo useradd -m -d /srv/share-artifacts -s /usr/sbin/nologin -g sftp-share skippy4-share

# Chroot requires the chroot dir (and everything above the writable part) to be
# root-owned, not the sftp user's — create a writable subdir inside it instead
# of trying to chroot directly to /srv/share-artifacts if it's not root:root 755.
sudo chown root:root /srv/share-artifacts
sudo chmod 755 /srv/share-artifacts

# Give the group write access to the artifacts dir itself (files inside need to
# be group-writable for both Switchboard hubs to create/delete tokens there)
sudo chgrp sftp-share /srv/share-artifacts
sudo chmod 775 /srv/share-artifacts
sudo setfacl -d -m g:sftp-share:rwx /srv/share-artifacts   # default ACL so new files inherit group-write

sudo mkdir -p /home/skippy4-share/.ssh
sudo chmod 700 /home/skippy4-share/.ssh
```

Add to `/etc/ssh/sshd_config` (or a drop-in under `/etc/ssh/sshd_config.d/`):

```
Match User skippy4-share
    ChrootDirectory /srv/share-artifacts
    ForceCommand internal-sftp
    X11Forwarding no
    AllowTcpForwarding no
    PermitTunnel no
```

```bash
sudo systemctl reload sshd
```

Get the colleague's **public key** (from the chat log, Skippy-4's key):

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICypscjyI7xZ2xoaAaXvgAxr59ur2JacRKnOyUX7MJBM skippy4@vps-97bdaf8e
```

**Verify the fingerprint out-of-band before trusting it** — the chat log itself flags that a
prior paste got mangled in Discord (`SHA256:4mbmpDN1NnhVsRXVNBgVL/BllRqFvQxWWBrxISQwCNE` was the
value pulled directly off `/home/ubuntu/.ssh/skippy4_ed25519.pub` on `51.195.136.61` last time —
re-confirm this fingerprint matches what's on that box before installing it, don't trust the
Discord paste alone):

```bash
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICypscjyI7xZ2xoaAaXvgAxr59ur2JacRKnOyUX7MJBM skippy4@vps-97bdaf8e" \
  | sudo tee /home/skippy4-share/.ssh/authorized_keys
sudo chmod 600 /home/skippy4-share/.ssh/authorized_keys
sudo chown -R skippy4-share:sftp-share /home/skippy4-share/.ssh
```

Confirm the account **cannot** get a shell:

```bash
ssh -i <their-private-key> skippy4-share@57.129.139.18   # should refuse a shell / drop to sftp prompt
sftp -i <their-private-key> skippy4-share@57.129.139.18  # should work, and `ls` should show only artifact dirs
```

## 2. [Aurora] Hand back connection details

Give the colleague:
- Host: `57.129.139.18` (or a hostname alias if you use one)
- User: `skippy4-share`
- Remote path once connected: `/` (their chroot root **is** `/srv/share-artifacts` — don't give
  them the absolute host path, it doesn't apply inside the chroot)
- Confirmed fingerprint of their key (from step 1)

## 3. [Colleague] Set up their own Switchboard hub

If they don't already have one running:

```bash
git clone <switchboard-repo-url> switchboard
cd switchboard
# Install Bun if not already present: https://bun.sh
bun install
mkdir -p ~/.switchboard
echo "DISCORD_BOT_TOKEN=<their own bot token>" > ~/.switchboard/.env
chmod 600 ~/.switchboard/.env
cp config/agents.example.json config/agents.json
```

Set `guildIds` in `config/hub.config.json` to their own Discord server, and enable the "Server
Members" + "Message Content" privileged intents on their bot in the Discord Developer Portal.
This is a **separate bot/hub** from Aurora's — nothing here is shared except the artifacts
directory.

## 4. [Colleague] Mount the shared directory over SSHFS

```bash
sudo apt-get install -y sshfs   # or the equivalent for their OS
sudo mkdir -p /mnt/ra-share-artifacts
sudo chown $(whoami) /mnt/ra-share-artifacts

sshfs -o IdentityFile=/home/ubuntu/.ssh/skippy4_ed25519,allow_other,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 \
  skippy4-share@57.129.139.18:/ /mnt/ra-share-artifacts
```

Verify:

```bash
touch /mnt/ra-share-artifacts/write-test && rm /mnt/ra-share-artifacts/write-test
# should succeed with no error
```

**Persist across reboot** — add to `/etc/fstab` (adjust paths/user):

```
skippy4-share@57.129.139.18:/ /mnt/ra-share-artifacts fuse.sshfs _netdev,IdentityFile=/home/ubuntu/.ssh/skippy4_ed25519,allow_other,reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,x-systemd.automount 0 0
```

If their Switchboard hub runs under systemd/pm2, make sure the mount unit is a dependency (or at
minimum starts before the hub) so the hub doesn't boot with an empty/missing directory and start
writing tokens to a local dir by mistake if the mount silently failed. A cheap guard: have the
hub's start script `mountpoint -q /mnt/ra-share-artifacts || exit 1` before `bun run hub`.

## 5. [Colleague] Configure `shareLinks` in `hub.config.json`

```jsonc
"shareLinks": {
  "enabled": true,
  "artifactsDir": "/mnt/ra-share-artifacts",
  "raHost": "readyapp.player-ready.co.uk",
  "defaultTtlDays": 30,
  "maxBytes": 26214400,
  "cleanupIntervalMs": 86400000
}
```

`artifactsDir` is the **local mount point**, not a remote path — Switchboard has no idea it's
remote. `raHost` only affects the display URL text; it doesn't need to match anything the
renderer reads.

Grant the specific agent(s) that should be able to publish access — no extra config needed
beyond `shareLinks.enabled: true`; any agent can call `publish_link` once the tool is exposed
(there's no per-agent `shareLinks` allowlist in the current code — if you want to restrict which
of *their* agents can publish, that'd need a small code change; flag this if it matters to them).

Restart the hub (`bun run hub`, or however it's supervised) to pick up the new config —
`shareLinks` isn't in the `!reload` hot-swap safe-key list, so this needs a full restart, not a
live `!reload`.

## 6. Verify end-to-end

From the colleague's Discord, get an agent to call `publish_link` on a small test file (e.g. a
markdown note) with a short `ttl_days` (e.g. `1`) so it self-cleans quickly.

Check:
1. The tool returns `Published: https://readyapp.player-ready.co.uk/share/<token>`.
2. On the RA VPS: `ls /srv/share-artifacts/<token>/` shows `meta.sbmd` + the file, and
   `cat .../meta.sbmd` shows `"producer": "agent:<their-agent-name>"`.
3. Opening the link **while logged into ReadyApp as staff** renders/downloads correctly.
4. Opening the link **not logged in, or logged in as a portal/parent account**, gets rejected
   (401/403) — confirms the auth gate is actually staff-only and the mount didn't accidentally
   expose the directory some other way.
5. After the TTL passes, either hub's cleanup sweep (both run independently, harmlessly — see
   below) removes the directory within ~1 sweep interval + up to 24h depending on
   `cleanupIntervalMs`.

## 7. Operational notes

- **Two cleanup sweeps, one directory — this is fine.** Both Switchboard hubs run their own
  `publishCleanup` sweep against the *same* shared directory (`hub/publishCleanup.ts` — see
  `docs/config-reference.md` §7.5). Each sweep evaluates every entry purely from its
  `meta.sbmd` content, regardless of which hub wrote it, so having two sweeps running
  redundantly against the same directory is harmless — not a race that causes data loss, just
  mildly duplicated work.
- **Token collisions are not a practical concern** — 128 bits of randomness per token,
  independently generated by each hub.
- **If the SSHFS mount drops** (network blip, RA VPS reboot), local writes under
  `/mnt/ra-share-artifacts` will either fail loudly (mount point returns I/O errors) or, if
  `sshfs` fully disconnects and the mountpoint reverts to a local empty directory, could
  silently start writing artifacts that never reach the renderer. Prefer `reconnect` (as above)
  and monitor for `mountpoint -q` failing; don't rely on the FUSE mount alone for anything
  latency- or reliability-critical.
- **Least privilege check** — periodically confirm the `skippy4-share` account still can't get
  a shell (`Match User` block in `sshd_config` intact) and is still chrooted (test with `sftp`
  as in step 1). If this account is ever compromised, the blast radius should be limited to
  read/write on `/srv/share-artifacts` only.
- **Revoking access**: remove the key from `/home/skippy4-share/.ssh/authorized_keys` (or
  `userdel -r skippy4-share`) on the RA VPS. Nothing on the colleague's side needs cleanup for
  this to take effect — the mount will just start failing.

## 8. Known gaps to flag to your colleague

- **DOCX has no dedicated viewer** despite it being mentioned informally as supported — under
  `mode: "view"` it falls through to a plain download, same as any unrecognized content type.
  Only PDF (inline), Markdown (rendered via `marked`), CSV (basic HTML table), and plain text
  get an actual in-browser view. If they specifically want a rendered DOCX experience, that's
  unbuilt on the renderer side.
- **Links only work for existing ReadyApp staff Entra accounts** (see §0) — this is not a
  general-purpose file-sharing service for the colleague's own team unless those people already
  have ReadyApp staff logins.
- **No per-agent allowlist for `publish_link`** — once `shareLinks.enabled` is true on their
  hub, every agent on that hub can publish. If that's too broad, it needs a small code change
  (not present today).
