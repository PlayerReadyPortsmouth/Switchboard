// hub/outboxAttach.ts
import { realpathSync, statSync, mkdirSync, readFileSync } from "fs"
import { join, sep, extname, basename } from "path"

export type OutboxResult =
  | { ok: true; absPath: string; filename: string; size: number; bytes: Buffer }
  | { ok: false; reason: "escape" | "missing" | "notfile" | "oversize" | "extension" }

export interface OutboxOpts {
  outboxBase: string          // e.g. <stateDir>/outbox
  agent: string               // taken from the transport, never from tool args
  maxBytes: number
  allowedExtensions: string[] // empty = allow any; lowercase, no leading dot
}

/** Resolve an agent-supplied relative `relPath` to a contained absolute path.
 *  Canonicalises with realpath so both `..` traversal and symlink targets that
 *  escape `<outboxBase>/<agent>/` are rejected. Pure given the filesystem. */
export function resolveOutboxFile(relPath: string, opts: OutboxOpts): OutboxResult {
  const agentRoot = join(opts.outboxBase, opts.agent)
  try { mkdirSync(agentRoot, { recursive: true }) } catch {}
  let root: string
  try { root = realpathSync(agentRoot) } catch { return { ok: false, reason: "missing" } }

  let real: string
  try { real = realpathSync(join(root, relPath)) } catch { return { ok: false, reason: "missing" } }
  // Containment: the canonical target must be the root itself or sit beneath it.
  // The `+ sep` guard stops `/outbox/ada` matching `/outbox/ada-evil`.
  if (real !== root && !real.startsWith(root + sep)) return { ok: false, reason: "escape" }

  let st
  try { st = statSync(real) } catch { return { ok: false, reason: "missing" } }
  if (!st.isFile()) return { ok: false, reason: "notfile" }
  if (st.size > opts.maxBytes) return { ok: false, reason: "oversize" }

  const ext = extname(real).replace(/^\./, "").toLowerCase()
  if (opts.allowedExtensions.length && !opts.allowedExtensions.includes(ext))
    return { ok: false, reason: "extension" }

  let bytes: Buffer
  try { bytes = readFileSync(real) } catch { return { ok: false, reason: "missing" } }
  return { ok: true, absPath: real, filename: basename(real), size: st.size, bytes }
}
