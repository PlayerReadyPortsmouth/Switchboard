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
