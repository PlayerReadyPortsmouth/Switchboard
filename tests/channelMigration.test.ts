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
  expect(conversation.title).toBe("general")
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
