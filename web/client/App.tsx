import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { ApiError, WorkspaceApi } from "./api"
import { ConversationStream } from "./conversationStream"
import { DraftStore } from "./drafts"
import { AppRail } from "./components/AppRail"
import { ConversationList } from "./components/ConversationList"
import { Inspector } from "./components/Inspector"
import { MobileNav, type MobilePane } from "./components/MobileNav"
import { initialWorkspaceState, workspaceReducer } from "./state"
import type { Conversation, ConversationInput, Session } from "./types"

export interface AppApi {
  session(): Promise<Session>
  listConversations(): Promise<Conversation[]>
  createConversation(input: ConversationInput): Promise<Conversation>
  archiveConversation(conversationId: string): Promise<Conversation>
  listMessages?(conversationId: string, after?: number, limit?: number): ReturnType<WorkspaceApi["listMessages"]>
}

interface AppProps {
  api?: AppApi
  drafts?: DraftStore
  install?: { run(): void }
  streamFactory?: (api: AppApi) => ConversationStream
}

type LoadState = "loading" | "ready" | "forbidden" | "unavailable"

const conversationIdFromLocation = () => {
  const match = location.pathname.match(/^\/conversations\/([^/]+)$/)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

const pathFor = (conversationId: string | null) => conversationId ? `/conversations/${encodeURIComponent(conversationId)}` : "/"

export function createWorkspaceStream(api: AppApi): ConversationStream {
  if (!api.listMessages) throw new Error("Conversation message API is unavailable")
  return new ConversationStream({
    fetchGap: (after, conversationId) => api.listMessages!(conversationId, after),
    online: () => navigator.onLine,
    open: (url, handlers) => {
      const source = new EventSource(url)
      source.addEventListener("open", handlers.open)
      source.addEventListener("message", event => handlers.message(event.data))
      source.addEventListener("error", handlers.error)
      return source
    },
  })
}

export function App({ api: suppliedApi, drafts: suppliedDrafts, install, streamFactory = createWorkspaceStream }: AppProps) {
  const apiRef = useRef<AppApi | null>(null)
  const draftsRef = useRef<DraftStore | null>(null)
  if (apiRef.current === null) apiRef.current = suppliedApi ?? new WorkspaceApi()
  if (draftsRef.current === null) draftsRef.current = suppliedDrafts ?? new DraftStore()
  const api = suppliedApi ?? apiRef.current
  const drafts = suppliedDrafts ?? draftsRef.current
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [dialog, setDialog] = useState<"new" | "archive" | null>(null)
  const [mobilePane, setMobilePane] = useState<MobilePane>(conversationIdFromLocation() ? "transcript" : "conversations")
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [actionError, setActionError] = useState("")

  const load = useCallback(async () => {
    setLoadState("loading")
    try {
      const [session, conversations] = await Promise.all([api.session(), api.listConversations()])
      dispatch({ type: "session/loaded", session })
      dispatch({ type: "conversations/loaded", conversations })
      dispatch({ type: "conversation/selected", conversationId: conversationIdFromLocation() })
      dispatch({ type: "connection/changed", connection: "live" })
      setLoadState("ready")
    } catch (error) {
      const forbidden = error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === "missing_identity")
      setLoadState(forbidden ? "forbidden" : "unavailable")
      dispatch({ type: "connection/changed", connection: "offline" })
    }
  }, [api])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onPopState = () => {
      const conversationId = conversationIdFromLocation()
      dispatch({ type: "conversation/selected", conversationId })
      setMobilePane(conversationId ? "transcript" : "conversations")
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  useEffect(() => {
    if (!state.selectedConversationId || !api.listMessages || !streamFactory) return
    const stream = streamFactory(api)
    void stream.start(state.selectedConversationId, 0, {
      onMessages: messages => dispatch({ type: "messages/received", messages }),
      onEvent: event => {
        if (event.kind === "message_committed" && event.message) dispatch({ type: "messages/received", messages: [event.message] })
        dispatch({ type: "activity/received", event })
      },
      onState: connection => dispatch({ type: "connection/changed", connection }),
    })
    return () => stream.stop()
  }, [api, state.selectedConversationId, streamFactory])

  const selected = useMemo(() => state.conversations.find(item => item.id === state.selectedConversationId) ?? null, [state.conversations, state.selectedConversationId])
  const latestTurnState = [...state.activity].reverse().find(event => event.kind === "turn_state")?.state

  const openDialog = (next: "new" | "archive") => { setActionError(""); setDialog(next) }
  const closeDialog = () => { setActionError(""); setDialog(null) }

  const navigate = (conversationId: string | null, replace = false) => {
    history[replace ? "replaceState" : "pushState"](null, "", pathFor(conversationId))
    dispatch({ type: "conversation/selected", conversationId })
    setMobilePane(conversationId ? "transcript" : "conversations")
  }

  const createConversation = async (input: ConversationInput) => {
    setActionError("")
    try {
      const created = await api.createConversation(input)
      dispatch({ type: "conversations/loaded", conversations: [created, ...state.conversations] })
      setDialog(null)
      navigate(created.id)
    } catch {
      setActionError("Conversation could not be created. Check the title and agent, then try again.")
    }
  }

  const archiveConversation = async () => {
    if (!selected) return
    setActionError("")
    try {
      await api.archiveConversation(selected.id)
      dispatch({ type: "conversations/loaded", conversations: state.conversations.filter(item => item.id !== selected.id) })
      setDialog(null)
      navigate(null)
    } catch {
      setActionError("Conversation could not be archived. Try again.")
    }
  }

  if (loadState === "loading") return <main className="status-page"><div role="status"><span className="status-node" />Loading your workspace…</div></main>
  if (loadState === "forbidden") return <main className="status-page"><section role="alert"><h1>Workspace access denied</h1><p>Ask a Switchboard administrator to grant your identity access.</p></section></main>
  if (loadState === "unavailable") return <main className="status-page"><section role="alert"><h1>Switchboard is unavailable</h1><p>Check the service connection, then try again.</p><button type="button" onClick={() => void load()}>Try again</button></section></main>
  if (!state.session) return null

  return (
    <main className="workspace-shell" data-mobile-pane={mobilePane}>
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-turn-announcer>{latestTurnState ? `Turn ${latestTurnState}.` : ""}</span>
      <AppRail connection={state.connection} install={install} onNew={() => openDialog("new")} onConversations={() => navigate(null)} />
      <ConversationList conversations={state.conversations} selectedId={state.selectedConversationId} open={mobilePane === "conversations"} closeDisabled={!selected} onNew={() => openDialog("new")} onSelect={item => navigate(item.id)} onClose={() => setMobilePane("transcript")} />
      <section className="transcript-pane" aria-label="Transcript" data-region="transcript" data-message-count={state.messages.length}>
        {selected ? (
          <>
            <header className="pane-header transcript-header">
              <div><p className="eyebrow">{selected.primaryAgent}</p><h2>{selected.title}</h2></div>
              <div className="header-actions">
                <button type="button" className="inspector-toggle" onClick={() => { setInspectorOpen(true); setMobilePane("inspector") }}>Conversation details</button>
                <button type="button" className="danger-action" onClick={() => openDialog("archive")}>Archive conversation</button>
              </div>
            </header>
            <div className="transcript-body"><p>Conversation messages will appear here.</p></div>
            <label className="composer-shell"><span className="sr-only">Message</span><textarea key={selected.id} aria-label="Message" defaultValue={drafts.read(selected.id)?.text ?? ""} onInput={event => drafts.write(selected.id, event.currentTarget.value)} placeholder="Message the conversation" /></label>
          </>
        ) : (
          <div className="transcript-empty"><span className="signal-map" aria-hidden="true"><i /></span><h2>Select a conversation</h2><p>Choose a conversation from the list to open its workspace.</p></div>
        )}
      </section>
      <Inspector conversation={selected} session={state.session} open={inspectorOpen || mobilePane === "inspector"} onClose={() => { setInspectorOpen(false); setMobilePane(selected ? "transcript" : "conversations") }} />
      <MobileNav pane={mobilePane} hasConversation={Boolean(selected)} onChange={pane => { setMobilePane(pane); setInspectorOpen(pane === "inspector") }} />
      {dialog === "new" ? <NewConversationDialog session={state.session} error={actionError} onCancel={closeDialog} onCreate={createConversation} /> : null}
      {dialog === "archive" && selected ? <ConfirmArchiveDialog title={selected.title} error={actionError} onCancel={closeDialog} onArchive={archiveConversation} /> : null}
    </main>
  )
}

function NewConversationDialog({ session, error, onCancel, onCreate }: { session: Session; error: string; onCancel(): void; onCreate(input: ConversationInput): Promise<void> }) {
  const [title, setTitle] = useState("")
  const [primaryAgent, setPrimaryAgent] = useState(session.agents[0]?.name ?? "")
  const [submitting, setSubmitting] = useState(false)
  const dialogRef = useModalDialog(onCancel)
  return (
    <div className="dialog-backdrop">
      <dialog ref={dialogRef} aria-labelledby="new-conversation-title">
        <form onSubmit={async event => { event.preventDefault(); setSubmitting(true); await onCreate({ title: title.trim(), primaryAgent }); setSubmitting(false) }}>
          <h2 id="new-conversation-title">New conversation</h2>
          <p>Start a durable workspace with a primary agent.</p>
          <label>Title<input autoFocus required value={title} onChange={event => setTitle(event.currentTarget.value)} /></label>
          <label>Primary agent<select required value={primaryAgent} onChange={event => setPrimaryAgent(event.currentTarget.value)}>{session.agents.map(agent => <option key={agent.name} value={agent.name}>{agent.name}{agent.busy ? " — busy" : ""}</option>)}</select></label>
          {error ? <p role="alert" className="form-error">{error}</p> : null}
          <div className="dialog-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" disabled={submitting || !title.trim() || !primaryAgent}>Create conversation</button></div>
        </form>
      </dialog>
    </div>
  )
}

function ConfirmArchiveDialog({ title, error, onCancel, onArchive }: { title: string; error: string; onCancel(): void; onArchive(): Promise<void> }) {
  const dialogRef = useModalDialog(onCancel)
  return (
    <div className="dialog-backdrop">
      <dialog ref={dialogRef} aria-labelledby="archive-conversation-title">
        <form onSubmit={event => { event.preventDefault(); void onArchive() }}>
          <h2 id="archive-conversation-title">Archive conversation</h2>
          <p>Archive “{title}”? It will leave this workspace list.</p>
          {error ? <p role="alert" className="form-error">{error}</p> : null}
          <div className="dialog-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="submit" className="danger-fill">Archive</button></div>
        </form>
      </dialog>
    </div>
  )
}

function useModalDialog(onCancel: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handleCancel = (event: Event) => { event.preventDefault(); cancelRef.current() }
    dialog.addEventListener("cancel", handleCancel)
    dialog.showModal()
    return () => {
      dialog.removeEventListener("cancel", handleCancel)
      if (dialog.open) dialog.close()
    }
  }, [])
  return dialogRef
}
