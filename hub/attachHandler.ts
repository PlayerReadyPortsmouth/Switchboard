// hub/attachHandler.ts
import type { OutboxResult } from "./outboxAttach"

export interface AttachFrame { chatId: string; path: string; caption?: string; filename?: string }

export interface AttachDeps {
  enabled: boolean
  resolve: (relPath: string) => OutboxResult            // bound to agent + opts by the caller
  sendFiles: (chatId: string, attachments: { data: Buffer; name: string }[], caption?: string) => Promise<boolean>
  note: (chatId: string, text: string) => void          // channel-visible failure note
  audit: (ok: boolean, chatId: string, detail: Record<string, unknown>) => void
}

const REASON_TEXT: Record<string, string> = {
  escape: "path is outside your outbox",
  missing: "file not found",
  notfile: "not a regular file",
  oversize: "file is too large",
  extension: "file type not allowed",
}

/** Build the attach-frame handler. Disabled → ignore (double-gate). Otherwise
 *  validate the path, read the file bytes, then either send the file or post a
 *  brief failure note; both outcomes are audited against the real delivery result. */
export function makeAttachHandler(deps: AttachDeps): (f: AttachFrame) => void {
  return async (f: AttachFrame): Promise<void> => {
    if (!deps.enabled) return
    const r = deps.resolve(f.path)
    if (!r.ok) {
      deps.note(f.chatId, `⚠️ attach failed: ${REASON_TEXT[r.reason] ?? r.reason}`)
      deps.audit(false, f.chatId, { path: f.path, reason: r.reason })
      return
    }
    const delivered = await deps.sendFiles(f.chatId, [{ data: r.bytes, name: f.filename ?? r.filename }], f.caption)
    if (delivered) {
      deps.audit(true, f.chatId, { file: r.filename, size: r.size })
    } else {
      deps.note(f.chatId, "⚠️ attach failed: could not deliver to Discord")
      deps.audit(false, f.chatId, { file: r.filename, reason: "delivery" })
    }
  }
}
