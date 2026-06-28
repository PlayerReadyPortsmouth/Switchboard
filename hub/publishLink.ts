// hub/publishLink.ts
import { resolveOutboxFile } from "./outboxAttach"
import { join, extname, normalize, sep } from "path"

export interface Sbmd {
  v: number; mode: "download" | "page" | "view"; contentType: string; filename: string;
  title: string; scope: string; createdAt: string; expiresAt: string; producer: string
}

const MIME: Record<string, { type: string; mode: "download" | "page" | "view" }> = {
  pdf: { type: "application/pdf", mode: "view" },
  html: { type: "text/html", mode: "page" }, htm: { type: "text/html", mode: "page" },
  md: { type: "text/markdown", mode: "view" }, csv: { type: "text/csv", mode: "view" },
  txt: { type: "text/plain", mode: "view" },
  png: { type: "image/png", mode: "view" }, jpg: { type: "image/jpeg", mode: "view" },
  jpeg: { type: "image/jpeg", mode: "view" }, gif: { type: "image/gif", mode: "view" },
  webp: { type: "image/webp", mode: "view" },
}

export function inferModeAndType(filename: string): { mode: "download" | "page" | "view"; contentType: string } {
  const ext = extname(filename).replace(/^\./, "").toLowerCase()
  const m = MIME[ext]
  return m ? { mode: m.mode, contentType: m.type } : { mode: "download", contentType: "application/octet-stream" }
}

export interface PublishArgs { path: string; mode?: string; title?: string; scope?: string; ttlDays?: number }
export interface PublishOpts {
  artifactsDir: string; raHost: string; agent: string; outboxBase: string;
  maxBytes: number; defaultTtlDays: number; now: Date; randomToken: () => string
}
export interface PublishIO {
  mkdir: (dir: string) => void
  writeFile: (p: string, data: Buffer | string) => void
  rename: (from: string, to: string) => void
}
export type PublishResult = { ok: true; url: string; token: string } | { ok: false; reason: string }

const MODES = new Set(["download", "page", "view"])
const DAY_MS = 86_400_000

export function publishArtifact(args: PublishArgs, opts: PublishOpts, io: PublishIO): PublishResult {
  // Syntactic escape pre-check: resolveOutboxFile uses realpathSync which throws for
  // non-existent paths, returning "missing" before containment can be checked.
  const agentRoot = normalize(join(opts.outboxBase, opts.agent))
  const candidate = normalize(join(agentRoot, args.path))
  if (candidate !== agentRoot && !candidate.startsWith(agentRoot + sep)) {
    return { ok: false, reason: "escape" }
  }

  const r = resolveOutboxFile(args.path, {
    outboxBase: opts.outboxBase, agent: opts.agent, maxBytes: opts.maxBytes, allowedExtensions: [],
  })
  if (!r.ok) return { ok: false, reason: r.reason }
  if (r.filename === "meta.sbmd") return { ok: false, reason: "reserved_filename" }

  const inferred = inferModeAndType(r.filename)
  const mode = (args.mode && MODES.has(args.mode) ? args.mode : inferred.mode) as Sbmd["mode"]
  const ttlDays = typeof args.ttlDays === "number" && args.ttlDays > 0 ? args.ttlDays : opts.defaultTtlDays
  const token = opts.randomToken()
  const sbmd: Sbmd = {
    v: 1, mode, contentType: inferred.contentType, filename: r.filename,
    title: args.title || r.filename, scope: args.scope || "staff",
    createdAt: opts.now.toISOString(),
    expiresAt: new Date(opts.now.getTime() + ttlDays * DAY_MS).toISOString(),
    producer: `agent:${opts.agent}`,
  }
  const tmp = join(opts.artifactsDir, `${token}.tmp`)
  const finalDir = join(opts.artifactsDir, token)
  try {
    io.mkdir(tmp)
    io.writeFile(join(tmp, r.filename), r.bytes)
    io.writeFile(join(tmp, "meta.sbmd"), JSON.stringify(sbmd))
    io.rename(tmp, finalDir)
  } catch { return { ok: false, reason: "write_failed" } }
  return { ok: true, url: `https://${opts.raHost}/share/${token}`, token }
}
