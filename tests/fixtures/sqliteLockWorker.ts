import { Database } from "bun:sqlite"

declare var self: Worker
self.onmessage = event => {
  const db = new Database(event.data.file)
  db.exec("BEGIN IMMEDIATE")
  const now = 50
  db.query("INSERT INTO conversations(id,title,primary_agent,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("worker-conversation", "worker", "worker-agent", "worker-owner", now, now)
  db.query("INSERT INTO participants(conversation_id,identity,kind,role,created_at) VALUES (?,?,?,?,?)").run("worker-conversation", "worker-owner", "user", "owner", now)
  db.query("INSERT INTO transport_links(id,conversation_id,adapter,external_location_id,label,sync_mode,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("worker-link", "worker-conversation", "discord", event.data.channelId, null, "two_way", 1, now, now)
  self.postMessage("locked")
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, event.data.holdMs)
  db.exec("COMMIT")
  db.close()
  self.postMessage("released")
}
