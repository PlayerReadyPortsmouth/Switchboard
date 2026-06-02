export function encode(obj: unknown): string {
  return JSON.stringify(obj) + "\n"
}

/** Accumulates byte chunks and yields parsed objects on each complete line. */
export class LineDecoder {
  private buf = ""
  push(data: string): unknown[] {
    this.buf += data
    const out: unknown[] = []
    let nl: number
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.trim()) out.push(JSON.parse(line))
    }
    return out
  }
}
