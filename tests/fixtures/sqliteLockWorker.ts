import { Database } from "bun:sqlite"
import { SqliteApprovalHistoryRepository } from "../../hub/approvalRepository"

type ApprovalRaceOperation =
  | { op: "reserve"; input: Parameters<SqliteApprovalHistoryRepository["reserveDecision"]>[0] }
  | { op: "expire"; id: string; now: number }

type ApprovalRaceMessage = {
  kind: "approval_race"
  file: string
  barrier: SharedArrayBuffer
  operation: ApprovalRaceOperation
}

type LegacyLockMessage = {
  file: string
  channelId: string
  holdMs: number
}

function isApprovalRaceMessage(
  message: ApprovalRaceMessage | LegacyLockMessage,
): message is ApprovalRaceMessage {
  return "kind" in message && message.kind === "approval_race"
}

function serializeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) }
  }
  return { name: "Error", message: "unknown_worker_error" }
}

function runApprovalRace(message: ApprovalRaceMessage): void {
  const db = new Database(message.file)
  let response:
    | { kind: "result"; result: unknown }
    | { kind: "error"; error: { name: string; message: string; code?: string } }
  try {
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")
    const repo = new SqliteApprovalHistoryRepository(db)
    const barrier = new Int32Array(message.barrier)
    self.postMessage({ kind: "ready" })
    Atomics.wait(barrier, 0, 0)
    const result = message.operation.op === "reserve"
      ? repo.reserveDecision(message.operation.input)
      : { kind: "expire_result" as const, record: repo.expire(message.operation.id, message.operation.now) }
    response = { kind: "result", result }
  } catch (error) {
    response = { kind: "error", error: serializeError(error) }
  } finally {
    db.close()
  }
  self.postMessage(response!)
}

function runLegacyLock(message: LegacyLockMessage): void {
  const db = new Database(message.file)
  let released = false
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("BEGIN IMMEDIATE")
    const now = 50
    db.query("INSERT INTO conversations(id,title,primary_agent,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("worker-conversation", "worker", "worker-agent", "worker-owner", now, now)
    db.query("INSERT INTO participants(conversation_id,identity,kind,role,created_at) VALUES (?,?,?,?,?)").run("worker-conversation", "worker-owner", "user", "owner", now)
    db.query("INSERT INTO transport_links(id,conversation_id,adapter,external_location_id,label,sync_mode,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("worker-link", "worker-conversation", "discord", message.channelId, null, "two_way", 1, now, now)
    self.postMessage("locked")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, message.holdMs)
    db.exec("COMMIT")
    released = true
  } finally {
    db.close()
  }
  if (released) self.postMessage("released")
}

declare var self: Worker
self.onmessage = event => {
  const message = event.data as ApprovalRaceMessage | LegacyLockMessage
  if (isApprovalRaceMessage(message)) {
    runApprovalRace(message)
    return
  }
  runLegacyLock(message)
}
