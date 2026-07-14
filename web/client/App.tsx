import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent, type Ref } from "react"
import { ApiError, WorkspaceApi } from "./api"
import { ConversationStream } from "./conversationStream"
import { AgentStream } from "./agentStream"
import { DraftStore } from "./drafts"
import { AgentsWorkspace } from "./components/AgentsWorkspace"
import { AppRail } from "./components/AppRail"
import { ConversationList } from "./components/ConversationList"
import { Inspector } from "./components/Inspector"
import { Transcript, canonicalMessages } from "./components/Transcript"
import { Composer } from "./components/Composer"
import { ActivityDisclosure } from "./components/ActivityItem"
import { MobileNav, type MobilePane } from "./components/MobileNav"
import { initialWorkspaceState, workspaceReducer } from "./state"
import type { ConnectionState, Conversation, ConversationEvent, ConversationInput, ConversationUpdate, Message, PostMessageInput, Session, TransportLink } from "./types"
import type { PwaController, PwaState } from "./pwa"
import { parseWorkspaceRoute, pathForAgent, pathForConversation, type WorkspaceRoute } from "./routes"

export interface AppApi {
  session(): Promise<Session>
  listConversations(): Promise<Conversation[]>
  createConversation(input: ConversationInput): Promise<Conversation>
  archiveConversation(conversationId: string): Promise<Conversation>
  listMessages?(conversationId: string, after?: number, limit?: number): ReturnType<WorkspaceApi["listMessages"]>
  postMessage?(conversationId: string, input: PostMessageInput): Promise<Message>
  updateConversation?(conversationId: string, input: ConversationUpdate): Promise<Conversation>
  listLinks?(conversationId: string): Promise<TransportLink[]>
  listAgents?: WorkspaceApi["listAgents"]
  getAgent?: WorkspaceApi["getAgent"]
}

export interface ConversationViewApi {
  postMessage?(conversationId: string, input: PostMessageInput): Promise<Message>
  updateConversation?(conversationId: string, input: ConversationUpdate): Promise<Conversation>
  listLinks?(conversationId: string): Promise<TransportLink[]>
}

interface AppProps {
  api?: AppApi
  drafts?: DraftStore
  install?: { run(): void }
  pwa?: Pick<PwaController, "state" | "subscribe" | "install">
  streamFactory?: ((api: AppApi) => ConversationStream) | null
  agentStreamFactory?: (() => AgentStream) | null
}

interface ConversationWorkspaceProps extends AppProps {
  session?: Session | null
  onSessionLoaded?(session: Session): void
  onNavigateDestination?(destination: "conversations" | "agents"): void
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

const pathFor = pathForConversation

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

export function ConversationView({ api, conversation: suppliedConversation, messages, activity = [], drafts: suppliedDrafts, session: suppliedSession, links: suppliedLinks, inspectorOpen = true, composerRef, inspectorCloseRef, onOpenInspector, onCloseInspector = () => {}, onInspectorEscape, onArchive, onCanonicalMessage, onConversationUpdated }: {
  api: ConversationViewApi
  conversation: Conversation
  messages?: Message[]
  activity?: ConversationEvent[]
  drafts?: DraftStore
  session?: Session
  links?: TransportLink[]
  inspectorOpen?: boolean
  composerRef?: Ref<HTMLTextAreaElement>
  inspectorCloseRef?: Ref<HTMLButtonElement>
  onOpenInspector?(trigger: HTMLElement): void
  onCloseInspector?(): void
  onInspectorEscape?(): void
  onArchive?(): void
  onCanonicalMessage?(message: Message): void
  onConversationUpdated?(conversation: Conversation): void
}) {
  const draftsRef = useRef<DraftStore | null>(null)
  if (draftsRef.current === null) draftsRef.current = suppliedDrafts ?? new DraftStore()
  const drafts = suppliedDrafts ?? draftsRef.current
  const [conversation, setConversation] = useState(suppliedConversation)
  const [localMessages, setLocalMessages] = useState<Message[]>([])
  const [loadedLinks, setLoadedLinks] = useState<TransportLink[]>([])
  const [text, setText] = useState(() => drafts.read(suppliedConversation.id)?.text ?? "")
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState("")
  const [agentError, setAgentError] = useState("")
  const failedAttemptRef = useRef<PostMessageInput | null>(null)
  const sendingRef = useRef(false)
  const conversationIdRef = useRef(suppliedConversation.id)
  const requestGenerationRef = useRef(0)
  const agentRequestRef = useRef(0)
  const renderedMessages = canonicalMessages(messages ?? localMessages)
  const session = suppliedSession ?? {
    identity: suppliedConversation.createdBy,
    agents: [{ name: conversation.primaryAgent, alive: true, busy: false }],
    features: { agents: false },
    permissions: { agents: "hidden" as const },
  }
  const links = suppliedLinks ?? loadedLinks

  useLayoutEffect(() => {
    conversationIdRef.current = suppliedConversation.id
    requestGenerationRef.current++
    agentRequestRef.current++
    setConversation(suppliedConversation)
    setLocalMessages([])
    setText(drafts.read(suppliedConversation.id)?.text ?? "")
    setReplyTo(null)
    setSending(false)
    sendingRef.current = false
    setSendError("")
    setAgentError("")
    failedAttemptRef.current = null
    return () => {
      conversationIdRef.current = ""
      requestGenerationRef.current++
      agentRequestRef.current++
      sendingRef.current = false
    }
  }, [drafts, suppliedConversation.id])

  useEffect(() => { setConversation(suppliedConversation) }, [suppliedConversation])

  useEffect(() => {
    if (suppliedLinks || !api.listLinks) return
    let active = true
    setLoadedLinks([])
    void api.listLinks(suppliedConversation.id).then(next => { if (active) setLoadedLinks(next) }).catch(() => { if (active) setLoadedLinks([]) })
    return () => { active = false }
  }, [api, suppliedConversation.id, suppliedLinks])

  const changeText = (next: string) => {
    setText(next)
    drafts.write(conversation.id, next)
    if (sendError) setSendError("")
    failedAttemptRef.current = null
  }

  const deliver = async (input: PostMessageInput) => {
    if (sendingRef.current) return
    if (!api.postMessage) { setSendError("Message not sent. Sending is unavailable."); return }
    sendingRef.current = true
    setSending(true)
    setSendError("")
    const requestConversationId = conversation.id
    const generation = requestGenerationRef.current
    try {
      const canonical = await api.postMessage(requestConversationId, input)
      const cleared = drafts.markSent(requestConversationId, input.clientKey)
      if (conversationIdRef.current !== requestConversationId || generation !== requestGenerationRef.current) return
      if (messages === undefined) setLocalMessages(current => canonicalMessages([...current, canonical]))
      onCanonicalMessage?.(canonical)
      if (cleared) setText("")
      setReplyTo(null)
      failedAttemptRef.current = null
    } catch {
      if (conversationIdRef.current !== requestConversationId || generation !== requestGenerationRef.current) return
      failedAttemptRef.current = input
      setSendError("Message not sent. Check the connection, then retry.")
    } finally {
      if (conversationIdRef.current === requestConversationId && generation === requestGenerationRef.current) {
        setSending(false)
        sendingRef.current = false
      }
    }
  }

  const submit = () => {
    const content = text.trim()
    if (!content) return
    const draft = drafts.write(conversation.id, text)
    if (!draft) return
    void deliver({ content: text, clientKey: draft.clientKey, ...(replyTo ? { replyTo: replyTo.id } : {}) })
  }
  const retry = () => { if (failedAttemptRef.current) void deliver(failedAttemptRef.current) }
  const updatePrimaryAgent = async (primaryAgent: string) => {
    if (!api.updateConversation || primaryAgent === conversation.primaryAgent) return
    const requestConversationId = conversation.id
    const request = ++agentRequestRef.current
    setAgentError("")
    try {
      const canonical = await api.updateConversation(requestConversationId, { primaryAgent })
      if (conversationIdRef.current !== requestConversationId || request !== agentRequestRef.current) return
      setConversation(canonical)
      onConversationUpdated?.(canonical)
    } catch {
      if (conversationIdRef.current !== requestConversationId || request !== agentRequestRef.current) return
      setAgentError("Primary agent could not be updated. Check the connection, then try again.")
    }
  }

  return <>
    <section className="transcript-pane" aria-label="Transcript" data-region="transcript" data-message-count={renderedMessages.length}>
      <header className="pane-header transcript-header">
        <div><p className="eyebrow">{conversation.primaryAgent}</p><h2>{conversation.title}</h2></div>
        <div className="header-actions">
          {onOpenInspector ? <button type="button" className="inspector-toggle" onClick={event => onOpenInspector(event.currentTarget)}>Conversation details</button> : null}
          {onArchive ? <button type="button" className="danger-action" onClick={onArchive}>Archive conversation</button> : null}
        </div>
      </header>
      <div className="transcript-body"><Transcript messages={renderedMessages} onReply={setReplyTo} /><ActivityDisclosure events={activity} /></div>
      <Composer value={text} replyTo={replyTo} sending={sending} error={sendError} textareaRef={composerRef} onChange={changeText} onSubmit={submit} onRetry={retry} onDismissReply={() => setReplyTo(null)} />
    </section>
    <Inspector conversation={conversation} session={session} links={links} primaryAgentError={agentError} open={inspectorOpen} closeRef={inspectorCloseRef} onClose={onCloseInspector} onEscape={onInspectorEscape} onPrimaryAgentChange={api.updateConversation ? primaryAgent => { void updatePrimaryAgent(primaryAgent) } : undefined} />
  </>
}

export function ConversationWorkspace({ api: suppliedApi, drafts: suppliedDrafts, install, pwa, streamFactory = createWorkspaceStream, session: suppliedSession, onSessionLoaded, onNavigateDestination }: ConversationWorkspaceProps) {
  const apiRef = useRef<AppApi | null>(null)
  const draftsRef = useRef<DraftStore | null>(null)
  if (apiRef.current === null) apiRef.current = suppliedApi ?? new WorkspaceApi()
  if (draftsRef.current === null) draftsRef.current = suppliedDrafts ?? new DraftStore()
  const api = suppliedApi ?? apiRef.current
  const drafts = suppliedDrafts ?? draftsRef.current
  const suppliedSessionRef = useRef(suppliedSession)
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [dialog, setDialog] = useState<"new" | "archive" | null>(null)
  const [mobilePane, setMobilePane] = useState<MobilePane>(conversationIdFromLocation() ? "transcript" : "conversations")
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [links, setLinks] = useState<TransportLink[]>([])
  const [actionError, setActionError] = useState("")
  const layout = useWorkspaceLayout()
  const conversationSearchRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const inspectorCloseRef = useRef<HTMLButtonElement>(null)
  const drawerInvokerRef = useRef<HTMLElement | null>(null)
  const dialogInvokerRef = useRef<HTMLElement | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [pwaState, setPwaState] = useState<PwaState>(() => pwa?.state() ?? { installAvailable: false, online: true, issue: null })
  const loadEpochRef = useRef(0)
  const offlineFallbackRef = useRef<string | null>(null)

  useEffect(() => pwa?.subscribe(setPwaState), [pwa])

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

  const load = useCallback(async (background = false) => {
    const epoch = ++loadEpochRef.current
    const current = () => loadEpochRef.current === epoch
    if (!background) setLoadState("loading")
    try {
      const sessionRequest = suppliedSessionRef.current ?? api.session()
      const [session, conversations] = await Promise.all([sessionRequest, api.listConversations()])
      if (!current()) return
      offlineFallbackRef.current = null
      dispatch({ type: "session/loaded", session })
      onSessionLoaded?.(session)
      if (!current()) return
      dispatch({ type: "conversations/loaded", conversations })
      if (!current()) return
      dispatch({ type: "conversation/selected", conversationId: conversationIdFromLocation() })
      if (!current()) return
      dispatch({ type: "connection/changed", connection: "live" })
      if (!current()) return
      setLoadState("ready")
    } catch (error) {
      if (!current()) return
      const offlineConversationId = conversationIdFromLocation()
      if (pwa?.state().online === false && offlineConversationId && drafts.read(offlineConversationId)) {
        offlineFallbackRef.current = offlineConversationId
        const now = Date.now()
        dispatch({
          type: "session/loaded",
          session: { identity: "", agents: [], features: { agents: false }, permissions: { agents: "hidden" } },
        })
        if (!current()) return
        dispatch({ type: "conversations/loaded", conversations: [{
          id: offlineConversationId, title: offlineConversationId, primaryAgent: "", createdBy: "", createdAt: now, updatedAt: now, archivedAt: null,
        }] })
        if (!current()) return
        dispatch({ type: "conversation/selected", conversationId: offlineConversationId })
        if (!current()) return
        dispatch({ type: "connection/changed", connection: "offline" })
        if (!current()) return
        setLoadState("ready")
        return
      }
      const forbidden = error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === "missing_identity")
      if (forbidden || !background) setLoadState(forbidden ? "forbidden" : "unavailable")
      if (!current()) return
      dispatch({ type: "connection/changed", connection: "offline" })
    }
  }, [api, drafts, onSessionLoaded, pwa])

  useEffect(() => {
    void load()
    return () => { loadEpochRef.current++ }
  }, [load])
  useEffect(() => {
    if (pwaState.online && offlineFallbackRef.current) void load(true)
  }, [load, pwaState.online])
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
  useEffect(() => {
    if (!selected || !api.listLinks) { setLinks([]); return }
    let active = true
    setLinks([])
    void api.listLinks(selected.id).then(next => { if (active) setLinks(next) }).catch(() => { if (active) setLinks([]) })
    return () => { active = false }
  }, [api, selected?.id])
  const latestTurnState = [...state.activity].reverse().find(event => event.kind === "turn_state")?.state
  const displayedConnection = pwa && !pwaState.online ? "offline" : state.connection
  const workspaceAnnouncement = pwa && !pwaState.online
    ? `Offline — drafts stay on this device. Messages are not submitted.${latestTurnState ? ` Turn ${latestTurnState}.` : ""}`
    : `${connectionLabels[state.connection]}.${latestTurnState ? ` Turn ${latestTurnState}.` : ""}`

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
      {pwaState.issue ? <div className="pwa-issue" role="status" aria-labelledby="pwa-issue-title" data-source={pwaState.issue.source}>
        <strong id="pwa-issue-title">{pwaState.issue.source === "install" ? "Install Switchboard" : "Offline support"}</strong>
        <span>{pwaState.issue.message}</span>
      </div> : null}
      <AppRail
        active="conversations"
        features={state.session.features}
        connection={displayedConnection}
        install={pwa ? { available: pwaState.installAvailable, run: () => pwa.install() } : install ? { available: true, run: async () => install.run() } : undefined}
        onNew={() => openDialog("new")}
        onNavigate={destination => destination === "conversations" ? navigate(null) : onNavigateDestination?.("agents")}
      />
      <ConversationList
        conversations={state.conversations}
        selectedId={state.selectedConversationId}
        open={mobilePane === "conversations"}
        closeDisabled={!selected}
        showHeaderNew={layout === "mobile"}
        searchRef={conversationSearchRef}
        onEscape={layout === "mobile" && selected ? closeConversationDrawer : undefined}
        onNew={() => openDialog("new")}
        onSelect={item => selectConversation(item)}
        onClose={closeConversationDrawer}
      />
      {selected ? <ConversationView
        api={api}
        conversation={selected}
        messages={state.messages}
        activity={state.activity}
        drafts={drafts}
        session={state.session}
        links={links}
        inspectorOpen={inspectorOpen || mobilePane === "inspector"}
        composerRef={composerRef}
        inspectorCloseRef={inspectorCloseRef}
        onOpenInspector={openInspector}
        onCloseInspector={closeInspector}
        onInspectorEscape={layout !== "desktop" ? closeInspector : undefined}
        onArchive={() => openDialog("archive")}
        onCanonicalMessage={message => dispatch({ type: "messages/received", messages: [message] })}
        onConversationUpdated={updated => dispatch({ type: "conversations/loaded", conversations: state.conversations.map(item => item.id === updated.id ? updated : item) })}
      /> : <>
        <section className="transcript-pane" aria-label="Transcript" data-region="transcript" data-message-count="0"><div className="transcript-empty"><span className="signal-map" aria-hidden="true"><i /></span><h2>Select a conversation</h2><p>Choose a conversation from the list to open its workspace.</p></div></section>
        <Inspector conversation={null} session={state.session} open={false} onClose={closeInspector} />
      </>}
      <MobileNav pane={mobilePane} hasConversation={Boolean(selected)} onChange={changeMobilePane} />
      {dialog === "new" ? <NewConversationDialog session={state.session} error={actionError} onCancel={closeDialog} onCreate={createConversation} /> : null}
      {dialog === "archive" && selected ? <ConfirmArchiveDialog title={selected.title} error={actionError} onCancel={closeDialog} onArchive={archiveConversation} /> : null}
    </main>
  )
}

export function App({ api: suppliedApi, drafts: suppliedDrafts, install, pwa, streamFactory = createWorkspaceStream, agentStreamFactory = () => new AgentStream() }: AppProps) {
  const apiRef = useRef<AppApi | null>(null)
  const draftsRef = useRef<DraftStore | null>(null)
  if (apiRef.current === null) apiRef.current = suppliedApi ?? new WorkspaceApi()
  if (draftsRef.current === null) draftsRef.current = suppliedDrafts ?? new DraftStore()
  const api = suppliedApi ?? apiRef.current
  const drafts = suppliedDrafts ?? draftsRef.current
  const agentsApi = useMemo(() => api.listAgents && api.getAgent ? {
    listAgents: () => api.listAgents!(),
    getAgent: (name: string) => api.getAgent!(name),
  } : null, [api])
  const [route, setRoute] = useState<WorkspaceRoute>(() => parseWorkspaceRoute(location.pathname))
  const [session, setSession] = useState<Session | null>(null)
  const [sessionState, setSessionState] = useState<LoadState>("loading")
  const sessionGeneration = useRef(0)

  useEffect(() => {
    const onPopState = () => setRoute(parseWorkspaceRoute(location.pathname))
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  const rememberSession = useCallback((next: Session) => { setSession(next); setSessionState("ready") }, [])
  const loadSession = useCallback(async () => {
    const generation = ++sessionGeneration.current
    setSessionState("loading")
    try {
      const next = await api.session()
      if (generation !== sessionGeneration.current) return
      setSession(next)
      setSessionState("ready")
    } catch (error) {
      if (generation !== sessionGeneration.current) return
      const forbidden = error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === "missing_identity")
      setSessionState(forbidden ? "forbidden" : "unavailable")
    }
  }, [api])

  useEffect(() => {
    if (route.destination !== "agents" || session) return
    void loadSession()
    return () => { sessionGeneration.current++ }
  }, [loadSession, route.destination, session])

  const navigate = useCallback((destination: "conversations" | "agents", agent: string | null = null) => {
    const path = destination === "agents" ? pathForAgent(agent) : pathForConversation(null)
    history.pushState(null, "", path)
    setRoute(parseWorkspaceRoute(path))
  }, [])

  if (route.destination === "not_found") return <NotFound />
  if (route.destination === "agents") {
    if (sessionState === "forbidden") return <main className="status-page"><section role="alert"><h1>Workspace access denied</h1><p>Ask a Switchboard administrator to grant your identity access.</p></section></main>
    if (sessionState === "unavailable") return <main className="status-page"><section role="alert"><h1>Switchboard is unavailable</h1><p>Check the service connection, then try again.</p><button type="button" onClick={() => void loadSession()}>Try again</button></section></main>
    if (sessionState === "loading" || !session) return <main className="status-page"><div role="status"><span className="status-node" />Loading your workspace…</div></main>
    if (!session.features.agents || session.permissions.agents === "hidden" || !agentsApi) return <NotFound />
    return <AgentsWorkspace
      api={agentsApi}
      session={session}
      routeAgent={route.agent}
      connection={navigator.onLine ? "live" : "offline"}
      install={install ? { available: true, run: async () => install.run() } : undefined}
      streamFactory={agentStreamFactory}
      onNavigate={navigate}
      onNewConversation={() => navigate("conversations")}
    />
  }

  return <ConversationWorkspace api={api} drafts={drafts} install={install} pwa={pwa} streamFactory={streamFactory} session={session} onSessionLoaded={rememberSession} onNavigateDestination={destination => navigate(destination)} />
}

function NotFound() {
  return <main className="status-page"><section><h1>Not found</h1><p>This Switchboard destination does not exist or is not enabled.</p><a href="/">Return to conversations</a></section></main>
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener("cancel", handleCancel)
    dialog.addEventListener("keydown", handleKeyDown)
    dialog.showModal()
    return () => {
      dialog.removeEventListener("cancel", handleCancel)
      dialog.removeEventListener("keydown", handleKeyDown)
      if (dialog.open) dialog.close()
    }
  }, [])
  return dialogRef
}
