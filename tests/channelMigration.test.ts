import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createDiscordConversationMigrator } from "../hub/conversations/channelMigration"
import { SqliteConversationRepository } from "../hub/conversations"

test("first Discord event creates one linked conversation and imports only reliable cache", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  const audits: unknown[] = []
  let n = 0
  const ensure = createDiscordConversationMigrator({ repo, now: () => 100, id: () => `id-${++n}`,
    cachedHistory: () => [
      { role: "user", text: "first", ts: 10, userId: "u1" },
      { role: "agent", text: "second", ts: 20, agent: "helper" },
      { role: "user", text: "ambiguous", ts: 30 },
    ], audit: detail => audits.push(detail) })
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u2", authorName: "Ada", content: "now", createdAt: 40, locationName: "general" }
  const conversation = ensure(event, "default")
  expect(conversation.title).toBe("#general")
  expect(conversation.primaryAgent).toBe("default")
  expect(repo.resolveTransportLink("discord", "c1")?.syncMode).toBe("two_way")
  expect(repo.getParticipant(conversation.id, "discord:u2")?.kind).toBe("external")
  expect(repo.listMessages(conversation.id).map(m => [m.author, m.origin, m.content])).toEqual([
    ["discord:u1", "transport", "first"], ["helper", "agent", "second"],
  ])
  expect(audits).toEqual([{ channelId: "c1", imported: 2, skipped: 1 }])
})

test("repeated ensure resolves the unique transport-link winner", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let n = 0
  const ensure = createDiscordConversationMigrator({ repo, now: () => 100, id: () => `id-${++n}` })
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u", authorName: "U", content: "hi", createdAt: 40 }
  expect(ensure(event, "a").id).toBe(ensure(event, "b").id)
  expect(repo.resolveTransportLink("discord", "c1")?.conversationId).toBe(ensure(event, "c").id)
})

test("lock contention across processes retries and produces one conversation with no orphan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-migrate-")); const file = join(dir, "db.sqlite")
  let db: Database | undefined, inspect: Database | undefined
  try {
    db = new Database(file, { create: true }); const repo = new SqliteConversationRepository(db); db.exec("PRAGMA busy_timeout=1000")
    const holder = new Worker(new URL("./fixtures/sqliteLockWorker.ts", import.meta.url).href)
    const nextMessage = () => new Promise<string>((resolve, reject) => { holder.onmessage = event => resolve(event.data); holder.onerror = reject })
    const locked = nextMessage(); holder.postMessage({ file, channelId: "race", holdMs: 150 }); expect(await locked).toBe("locked")
    let n = 0; const deps = { repo, now: () => 100, id: () => `race-${++n}` }
    const event = { adapter: "discord", eventId: "m", externalLocationId: "race", externalMessageId: "m", authorId: "u", authorName: "U", content: "x", createdAt: 1 }
    const released = nextMessage(); const a = createDiscordConversationMigrator(deps)(event, "a"); expect(await released).toBe("released"); holder.terminate()
    const b = createDiscordConversationMigrator(deps)(event, "b"); expect(a.id).toBe("worker-conversation"); expect(a.id).toBe(b.id)
    inspect = new Database(file)
    expect(inspect.query<{ n: number }, []>("SELECT count(*) AS n FROM conversations").get()?.n).toBe(1)
    expect(inspect.query<{ n: number }, []>("SELECT count(*) AS n FROM transport_links").get()?.n).toBe(1)
  } finally { inspect?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("existing links resume a partial cache import without duplicate messages or participants", () => {
  const db = new Database(":memory:"); const repo = new SqliteConversationRepository(db); let n = 0, fail = true
  const wrapped = new Proxy(repo, { get(target, key, receiver) {
    if (key === "appendMessage") return (input: Parameters<typeof repo.appendMessage>[0]) => {
      if (fail && input.content === "second") { fail = false; throw new Error("crash") }
      return repo.appendMessage(input)
    }
    const value = Reflect.get(target, key, receiver); return typeof value === "function" ? value.bind(target) : value
  } }) as SqliteConversationRepository
  const history = [
    { role: "user" as const, text: "first", ts: 1, userId: "u1" },
    { role: "user" as const, text: "second", ts: 2, userId: "u2" },
  ]
  const audits: unknown[] = []; const ensure = createDiscordConversationMigrator({ repo: wrapped, now: () => 100, id: () => `resume-${++n}`, cachedHistory: () => history, audit: detail => audits.push(detail) })
  const event = { adapter: "discord", eventId: "m", externalLocationId: "resume", externalMessageId: "m", authorId: "u3", authorName: "U", content: "x", createdAt: 3 }
  expect(() => ensure(event, "a")).toThrow("crash")
  const conversation = ensure(event, "a")
  expect(repo.listMessages(conversation.id).map(m => m.content)).toEqual(["first", "second"])
  expect(repo.getParticipant(conversation.id, "discord:u1")?.kind).toBe("external")
  expect(repo.getParticipant(conversation.id, "discord:u2")?.kind).toBe("external")
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM participants WHERE identity LIKE 'discord:%'").get()?.n).toBe(3)
  expect(audits).toEqual([{ channelId: "resume", imported: 1, skipped: 0 }])
})

// ---- legible conversation titles -------------------------------------------------

const baseEvent = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u", authorName: "ada", content: "hi", createdAt: 40 }
const migrate = (repo: SqliteConversationRepository, event: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  let n = 0
  return createDiscordConversationMigrator({ repo, now: () => 100, id: () => `id-${++n}`, ...extra })({ ...baseEvent, ...event } as any, "default")
}

test("a named guild channel titles the conversation in Discord's own #channel idiom", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  expect(migrate(repo, { locationName: "dev-agent" }).title).toBe("#dev-agent")
})

test("a thread is titled with BOTH its parent channel and its own name", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  expect(migrate(repo, { locationName: "deploy questions", threadParentName: "dev-agent" }).title)
    .toBe("#dev-agent › deploy questions")
})

test("a DM is titled by its author, never by a snowflake", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  expect(migrate(repo, { isDM: true, authorName: "ada" }).title).toBe("DM · ada")
})

test("an unavailable name falls back to the pre-existing Discord <id> title", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  expect(migrate(repo, {}).title).toBe("Discord c1")
  const dm = new SqliteConversationRepository(new Database(":memory:"))
  expect(migrate(dm, { isDM: true, authorName: "  " }).title).toBe("Discord c1")
})

test("a name that already carries a # is not double-prefixed, and a long name is clipped", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  expect(migrate(repo, { locationName: "#already-hashed" }).title).toBe("#already-hashed")
  const long = new SqliteConversationRepository(new Database(":memory:"))
  const title = migrate(long, { locationName: "x".repeat(120) }).title
  expect(title.length).toBeLessThanOrEqual(50)
  expect(title.endsWith("…")).toBe(true)
})

test("a renamed channel corrects the stored title on the next inbound message", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  const first = migrate(repo, { locationName: "dev-agent" })
  expect(first.title).toBe("#dev-agent")
  const second = migrate(repo, { locationName: "dev-agent-v2" })
  expect(second.id).toBe(first.id)
  expect(repo.getConversation(first.id)?.title).toBe("#dev-agent-v2")
})

test("a legacy 'Discord <snowflake>' title self-backfills once the name is carried", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  // Migrated before names were plumbed through: no locationName, so the old fallback.
  const before = migrate(repo, {})
  expect(before.title).toBe("Discord c1")
  // Next inbound message on the same channel, now carrying the name — no manual DB edit.
  const after = migrate(repo, { locationName: "dev-agent" })
  expect(after.id).toBe(before.id)
  expect(repo.getConversation(before.id)?.title).toBe("#dev-agent")
})

test("an unchanged title is never rewritten, so repeat messages cause no write churn", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let updates = 0
  const spy = new Proxy(repo, { get(target, key, receiver) {
    if (key === "updateConversation") return (...args: Parameters<typeof repo.updateConversation>) => { updates++; return repo.updateConversation(...args) }
    const value = Reflect.get(target, key, receiver); return typeof value === "function" ? value.bind(target) : value
  } }) as SqliteConversationRepository
  const first = migrate(spy, { locationName: "dev-agent" })
  const stamp = repo.getConversation(first.id)?.updatedAt
  for (let i = 0; i < 3; i++) migrate(spy, { locationName: "dev-agent" })
  expect(updates).toBe(0)
  // updated_at is the web sidebar's sort key — a no-op rename must not reshuffle the list.
  expect(repo.getConversation(first.id)?.updatedAt).toBe(stamp)
})

test("a human-chosen title survives later Discord messages", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  const conversation = migrate(repo, { locationName: "dev-agent" })
  repo.updateConversation(conversation.id, { title: "ReadyAPP" }, 200)
  migrate(repo, { locationName: "dev-agent-renamed" })
  expect(repo.getConversation(conversation.id)?.title).toBe("ReadyAPP")
})

test("a name that becomes unavailable never downgrades a real title back to the snowflake", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  const conversation = migrate(repo, { locationName: "dev-agent" })
  migrate(repo, {})
  expect(repo.getConversation(conversation.id)?.title).toBe("#dev-agent")
})

test("mirror participants default off: no web identity joins a migrated conversation", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let n = 0
  const ensure = createDiscordConversationMigrator({ repo, now: () => 100, id: () => `id-${++n}` })
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u", authorName: "U", content: "hi", createdAt: 40 }
  const conversation = ensure(event, "a")
  expect(repo.listConversations("ops@example.com")).toEqual([])
  expect(repo.getParticipant(conversation.id, "ops@example.com")).toBeNull()
})

test("mirror participants join as members so the conversation lists for that web identity", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let n = 0
  const ensure = createDiscordConversationMigrator({ repo, now: () => 100, id: () => `id-${++n}`,
    mirrorParticipants: () => ["ops@example.com", "  ", "*", "second@example.com"] })
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u", authorName: "U", content: "hi", createdAt: 40 }
  const conversation = ensure(event, "a")
  expect(repo.getParticipant(conversation.id, "ops@example.com")).toMatchObject({ kind: "user", role: "member" })
  expect(repo.getParticipant(conversation.id, "second@example.com")?.role).toBe("member")
  // Blank and the "*" role wildcard are never stored as identities.
  expect(repo.getParticipant(conversation.id, "*")).toBeNull()
  expect(repo.listConversations("ops@example.com").map(c => c.id)).toEqual([conversation.id])
})

test("enabling the mirror backfills a conversation migrated before it was switched on", () => {
  const repo = new SqliteConversationRepository(new Database(":memory:"))
  let n = 0
  const deps = { repo, now: () => 100, id: () => `id-${++n}` }
  const event = { adapter: "discord", eventId: "m1", externalLocationId: "c1", externalMessageId: "m1", authorId: "u", authorName: "U", content: "hi", createdAt: 40 }
  const before = createDiscordConversationMigrator(deps)(event, "a")
  expect(repo.listConversations("ops@example.com")).toEqual([])
  // Same channel, next inbound message, mirror now enabled — no manual DB edit.
  const after = createDiscordConversationMigrator({ ...deps, mirrorParticipants: () => ["ops@example.com"] })(event, "a")
  expect(after.id).toBe(before.id)
  expect(repo.listConversations("ops@example.com").map(c => c.id)).toEqual([before.id])
})
