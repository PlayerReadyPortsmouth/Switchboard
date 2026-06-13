import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from "fs"
import { join } from "path"

/** A memory scope = a folder under the vault root. The four shapes the hub uses. */
export type Scope =
  | "global"
  | `users/${string}`
  | `agents/${string}`
  | `channels/${string}`

export interface Note {
  path: string        // absolute file path
  scope: Scope
  title: string
  tags: string[]
  body: string
  source: string      // "distiller" | "agent:<name>" | …
  created: string     // ISO
  updated: string     // ISO
}

/** Filename-safe, Obsidian-friendly slug derived from a title. */
export function slugTitle(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return s.slice(0, 80) || "note"
}

/** Serialize a note to Obsidian-flavoured markdown (YAML front-matter + body). */
export function serializeNote(n: Omit<Note, "path">): string {
  const fm = [
    "---",
    `title: ${JSON.stringify(n.title)}`,
    `scope: ${JSON.stringify(n.scope)}`,
    `tags: [${n.tags.join(", ")}]`,
    `created: ${JSON.stringify(n.created)}`,
    `updated: ${JSON.stringify(n.updated)}`,
    `source: ${JSON.stringify(n.source)}`,
    "---",
    "",
  ].join("\n")
  return fm + n.body.replace(/\s+$/, "") + "\n"
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.startsWith('"')) { try { return JSON.parse(t) as string } catch { return t.slice(1, -1) } }
  return t
}

/** Parse a note file's front-matter + body. Missing fields degrade gracefully. */
export function parseNote(path: string, raw: string): Note {
  const fm: Record<string, string> = {}
  let body = raw
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  if (m) {
    body = m[2]
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":")
      if (i < 0) continue
      fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  const tags = fm.tags
    ? fm.tags.replace(/^\[|\]$/g, "").split(",").map((t) => unquote(t)).filter(Boolean)
    : []
  return {
    path,
    scope: (fm.scope ? unquote(fm.scope) : "global") as Scope,
    title: fm.title ? unquote(fm.title) : "(untitled)",
    tags,
    body: body.replace(/^\n+/, "").replace(/\s+$/, ""),
    source: fm.source ? unquote(fm.source) : "unknown",
    created: fm.created ? unquote(fm.created) : new Date(0).toISOString(),
    updated: fm.updated ? unquote(fm.updated) : new Date(0).toISOString(),
  }
}

/** Read/write the markdown memory vault. One file = one note, named by title slug
 *  within its scope folder; writing the same title upserts (preserving `created`). */
export class MemoryStore {
  constructor(private root: string) {}

  scopeDir(scope: Scope): string { return join(this.root, scope) }
  notePath(scope: Scope, title: string): string {
    return join(this.scopeDir(scope), `${slugTitle(title)}.md`)
  }

  write(
    scope: Scope,
    note: { title: string; tags?: string[]; body: string; source: string },
  ): string {
    const path = this.notePath(scope, note.title)
    const now = new Date().toISOString()
    let created = now
    try { created = parseNote(path, readFileSync(path, "utf8")).created } catch {}
    mkdirSync(this.scopeDir(scope), { recursive: true })
    const contents = serializeNote({
      scope, title: note.title, tags: note.tags ?? [], body: note.body,
      source: note.source, created, updated: now,
    })
    const tmp = path + ".tmp"
    writeFileSync(tmp, contents)
    renameSync(tmp, path)
    return path
  }

  read(path: string): Note { return parseNote(path, readFileSync(path, "utf8")) }

  list(scopes: Scope[]): Note[] {
    const out: Note[] = []
    for (const scope of scopes) {
      let files: string[] = []
      try { files = readdirSync(this.scopeDir(scope)) } catch { continue }
      for (const f of files) {
        if (!f.endsWith(".md")) continue
        try { out.push(this.read(join(this.scopeDir(scope), f))) } catch {}
      }
    }
    return out
  }

  /** Every note in the vault (recursive), for index (re)builds at boot. The
   *  `.index/` sidecar dir is skipped. */
  allNotes(): Note[] {
    const out: Note[] = []
    const walk = (dir: string): void => {
      let entries: { name: string; isDirectory(): boolean }[] = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith(".md")) { try { out.push(this.read(full)) } catch {} }
      }
    }
    walk(this.root)
    return out
  }
}
