// hub/attachHandler.ts
import type { OutboxResult } from "./outboxAttach"
import type { SendOutcome } from "./types"

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
 *  brief failure note; both outcomes are audited against the real delivery result.
 *  Returns a SendOutcome so the shim can relay a receipt when receipts are on. */
export function makeAttachHandler(deps: AttachDeps): (f: AttachFrame) => Promise<SendOutcome> {
  return async (f: AttachFrame): Promise<SendOutcome> => {
    if (!deps.enabled) return { ok: false, error: "attachments are disabled" }
    const r = deps.resolve(f.path)
    if (!r.ok) {
      const error = REASON_TEXT[r.reason] ?? r.reason
      deps.note(f.chatId, `⚠️ attach failed: ${error}`)
      deps.audit(false, f.chatId, { path: f.path, reason: r.reason })
      return { ok: false, error }
    }
    const delivered = await deps.sendFiles(f.chatId, [{ data: r.bytes, name: f.filename ?? r.filename }], f.caption)
    if (delivered) {
      deps.audit(true, f.chatId, { file: r.filename, size: r.size })
      return { ok: true }
    }
    deps.note(f.chatId, "⚠️ attach failed: could not deliver to Discord")
    deps.audit(false, f.chatId, { file: r.filename, reason: "delivery" })
    return { ok: false, error: "could not deliver to Discord" }
  }
}
