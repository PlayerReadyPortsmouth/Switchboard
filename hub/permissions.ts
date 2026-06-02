/** Tracks which agent raised each permission request, so the answer routes back correctly. */
export class PermissionRouter {
  private byRequest = new Map<string, string>()
  register(requestId: string, agent: string): void { this.byRequest.set(requestId, agent) }
  agentFor(requestId: string): string | undefined { return this.byRequest.get(requestId) }
  resolve(requestId: string): string | undefined {
    const a = this.byRequest.get(requestId)
    this.byRequest.delete(requestId)
    return a
  }
}

// Permission text-reply form: "y xxxxx" / "yes xxxxx" / "n xxxxx" / "no xxxxx".
// Code is the 5-letter request id (a-z minus 'l'). Case-insensitive. Strict:
// no bare yes/no, no surrounding chatter — keeps normal chat from matching.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export function parsePermissionReply(text: string): { behavior: "allow" | "deny"; code: string } | null {
  const m = PERMISSION_REPLY_RE.exec(text)
  if (!m) return null
  return {
    behavior: m[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
    code: m[2]!.toLowerCase(),
  }
}
