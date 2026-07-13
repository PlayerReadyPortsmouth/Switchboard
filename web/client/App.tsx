import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react"
import { ApiError, WorkspaceApi } from "./api"
import { ConversationStream } from "./conversationStream"
import { DraftStore } from "./drafts"
import { AppRail } from "./components/AppRail"
import { ConversationList } from "./components/ConversationList"
import { Inspector } from "./components/Inspector"
import { MobileNav, type MobilePane } from "./components/MobileNav"
import { initialWorkspaceState, workspaceReducer } from "./state"
import type { ConnectionState, Conversation, ConversationInput, Session } from "./types"

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
type WorkspaceLayout = "desktop" | "tablet" | "mobile"
type FocusRequest =
  | { target: "conversation-search" | "composer" | "inspector-close" }
  | { target: "element"; element: HTMLElement }

const connectionLabels: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
}

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
  const layout = useWorkspaceLayout()
  const conversationSearchRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const inspectorCloseRef = useRef<HTMLButtonElement>(null)
  const drawerInvokerRef = useRef<HTMLElement | null>(null)
  const dialogInvokerRef = useRef<HTMLElement | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)

  useLayoutEffect(() => {
    if (!focusRequest) return
    const target = focusRequest.target === "element"
      ? focusRequest.element
      : focusRequest.target === "conversation-search"
        ? conversationSearchRef.current
        : focusRequest.target === "composer"
          ? composerRef.current
          : inspectorCloseRef.current
    if (target?.isConnected) target.focus()
    setFocusRequest(null)
  }, [focusRequest])

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
  const workspaceAnnouncement = `${connectionLabels[state.connection]}.${latestTurnState ? ` Turn ${latestTurnState}.` : ""}`

  const openDialog = (next: "new" | "archive") => {
    dialogInvokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setActionError("")
    setDialog(next)
  }
  const closeDialog = () => {
    const invoker = dialogInvokerRef.current
    setActionError("")
    setDialog(null)
    if (invoker) setFocusRequest({ target: "element", element: invoker })
  }

  const closeInspector = () => {
    const invoker = drawerInvokerRef.current
    setInspectorOpen(false)
    setMobilePane(selected ? "transcript" : "conversations")
    if (invoker) setFocusRequest({ target: "element", element: invoker })
  }

  const closeConversationDrawer = () => {
    const invoker = drawerInvokerRef.current
    setMobilePane("transcript")
    if (invoker) setFocusRequest({ target: "element", element: invoker })
  }

  const openInspector = (trigger: HTMLElement) => {
    drawerInvokerRef.current = trigger
    setInspectorOpen(true)
    setMobilePane("inspector")
    if (layout !== "desktop") setFocusRequest({ target: "inspector-close" })
  }

  const changeMobilePane = (pane: MobilePane, trigger: HTMLButtonElement) => {
    drawerInvokerRef.current = trigger
    setMobilePane(pane)
    setInspectorOpen(pane === "inspector")
    if (pane === "conversations") setFocusRequest({ target: "conversation-search" })
    else if (pane === "inspector") setFocusRequest({ target: "inspector-close" })
    else setFocusRequest({ target: "composer" })
  }

  const navigate = (conversationId: string | null, replace = false) => {
    history[replace ? "replaceState" : "pushState"](null, "", pathFor(conversationId))
    dispatch({ type: "conversation/selected", conversationId })
    setMobilePane(conversationId ? "transcript" : "conversations")
  }

  const selectConversation = (conversation: Conversation) => {
    navigate(conversation.id)
    if (layout === "mobile") setFocusRequest({ target: "composer" })
  }

  const createConversation = async (input: ConversationInput) => {
    setActionError("")
    try {
      const created = await api.createConversation(input)
      dispatch({ type: "conversations/loaded", conversations: [created, ...state.conversations] })
      setDialog(null)
      navigate(created.id)
      setFocusRequest({ target: "composer" })
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
      setFocusRequest({ target: "conversation-search" })
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
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-workspace-announcer data-turn-announcer>{workspaceAnnouncement}</span>
      <AppRail connection={state.connection} install={install} onNew={() => openDialog("new")} onConversations={() => navigate(null)} />
      <ConversationList
        conversations={state.conversations}
        selectedId={state.selectedConversationId}
        open={mobilePane === "conversations"}
        closeDisabled={!selected}
        searchRef={conversationSearchRef}
        onEscape={layout === "mobile" && selected ? closeConversationDrawer : undefined}
        onNew={() => openDialog("new")}
        onSelect={item => selectConversation(item)}
        onClose={closeConversationDrawer}
      />
      <section className="transcript-pane" aria-label="Transcript" data-region="transcript" data-message-count={state.messages.length}>
        {selected ? (
          <>
            <header className="pane-header transcript-header">
              <div><p className="eyebrow">{selected.primaryAgent}</p><h2>{selected.title}</h2></div>
              <div className="header-actions">
                <button type="button" className="inspector-toggle" onClick={event => openInspector(event.currentTarget)}>Conversation details</button>
                <button type="button" className="danger-action" onClick={() => openDialog("archive")}>Archive conversation</button>
              </div>
            </header>
            <div className="transcript-body"><p>Conversation messages will appear here.</p></div>
            <label className="composer-shell"><span className="sr-only">Message</span><textarea ref={composerRef} key={selected.id} aria-label="Message" defaultValue={drafts.read(selected.id)?.text ?? ""} onInput={event => drafts.write(selected.id, event.currentTarget.value)} placeholder="Message the conversation" /></label>
          </>
        ) : (
          <div className="transcript-empty"><span className="signal-map" aria-hidden="true"><i /></span><h2>Select a conversation</h2><p>Choose a conversation from the list to open its workspace.</p></div>
        )}
      </section>
      <Inspector conversation={selected} session={state.session} open={inspectorOpen || mobilePane === "inspector"} closeRef={inspectorCloseRef} onClose={closeInspector} onEscape={layout !== "desktop" ? closeInspector : undefined} />
      <MobileNav pane={mobilePane} hasConversation={Boolean(selected)} onChange={changeMobilePane} />
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
  const pendingRef = useRef(false)
  const dialogRef = useModalDialog(() => { if (!pendingRef.current) onCancel() })
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pendingRef.current) return
    pendingRef.current = true
    setSubmitting(true)
    try {
      await onArchive()
    } finally {
      pendingRef.current = false
      if (dialogRef.current?.isConnected) setSubmitting(false)
    }
  }
  return (
    <div className="dialog-backdrop">
      <dialog ref={dialogRef} aria-labelledby="archive-conversation-title">
        <form onSubmit={event => { void submit(event) }}>
          <h2 id="archive-conversation-title">Archive conversation</h2>
          <p>Archive “{title}”? It will leave this workspace list.</p>
          {error ? <p role="alert" className="form-error">{error}</p> : null}
          <div className="dialog-actions"><button type="button" disabled={submitting} onClick={onCancel}>Cancel</button><button type="submit" className="danger-fill" disabled={submitting}>{submitting ? "Archiving…" : "Archive"}</button></div>
        </form>
      </dialog>
    </div>
  )
}

function useWorkspaceLayout(): WorkspaceLayout {
  const read = (): WorkspaceLayout => window.innerWidth < 768 ? "mobile" : window.innerWidth < 1200 ? "tablet" : "desktop"
  const [layout, setLayout] = useState<WorkspaceLayout>(read)
  useEffect(() => {
    const update = () => setLayout(read())
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [])
  return layout
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
