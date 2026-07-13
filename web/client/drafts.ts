export interface Draft { text: string; clientKey: string; updatedAt: number }

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class DraftStore {
  constructor(
    private readonly storage: StorageLike = localStorage,
    private readonly createKey: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  read(conversationId: string): Draft | null {
    const raw = this.storage.getItem(this.key(conversationId))
    if (raw === null) return null
    try {
      const value = JSON.parse(raw) as Partial<Draft>
      return typeof value.text === "string" && typeof value.clientKey === "string" && typeof value.updatedAt === "number"
        ? { text: value.text, clientKey: value.clientKey, updatedAt: value.updatedAt }
        : null
    } catch {
      return null
    }
  }

  write(conversationId: string, text: string): Draft | null {
    if (text === "") {
      this.storage.removeItem(this.key(conversationId))
      return null
    }
    const current = this.read(conversationId)
    const draft = { text, clientKey: current?.text === text ? current.clientKey : this.createKey(), updatedAt: this.now() }
    this.storage.setItem(this.key(conversationId), JSON.stringify(draft))
    return draft
  }

  markSent(conversationId: string, clientKey: string): boolean {
    if (this.read(conversationId)?.clientKey !== clientKey) return false
    this.storage.removeItem(this.key(conversationId))
    return true
  }

  private key(conversationId: string): string {
    return `switchboard:draft:${conversationId}`
  }
}
