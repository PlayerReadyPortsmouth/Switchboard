export interface LiaisonRecord {
  v: 1
  ts: string
  dir: "out" | "in"
  kind: "notify" | "ask" | "reply" | "deadletter" | "timeout" | "rejected"
  corrId: string
  peer: string
  localAgent?: string
  remoteAgent?: string
  text?: string
  bytes: number
  ok: boolean
  error?: string | null
}

export type LiaisonInput = Omit<LiaisonRecord, "v" | "ts" | "bytes">

export class LiaisonLog {
  constructor(private deps: { append: (line: string) => void; now: () => number }) {}
  write(input: LiaisonInput): LiaisonRecord {
    const rec: LiaisonRecord = {
      v: 1,
      ts: new Date(this.deps.now()).toISOString(),
      bytes: input.text ? Buffer.byteLength(input.text) : 0,
      ...input,
    }
    try { this.deps.append(JSON.stringify(rec) + "\n") } catch { /* best-effort */ }
    return rec
  }
}

export function parseLiaisonTail(raw: string, n: number): LiaisonRecord[] {
  const out: LiaisonRecord[] = []
  for (const line of raw.split("\n")) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s) as LiaisonRecord) } catch { /* skip junk */ }
  }
  return out.slice(-n)
}
