import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ApiError } from "../api"
import { AgentStream } from "../agentStream"
import type { AgentDetail as AgentDetailValue, AgentSummary, ConnectionState, Session } from "../types"
import { AgentDetail } from "./AgentDetail"
import type { AgentActionApi } from "./AgentActionDialog"
import type { AgentConfigApi } from "./AgentConfigEditor"
import { AgentList } from "./AgentList"
import { AppRail } from "./AppRail"
import { DestinationMobileNav } from "./DestinationMobileNav"

export type AgentsApi = AgentConfigApi & AgentActionApi & {
  listAgents(): Promise<AgentSummary[]>
  getAgent(agent: string): Promise<AgentDetailValue>
}

type LoadError = "forbidden" | "unavailable" | null
type DetailError = "forbidden" | "not_found" | "unavailable" | null
type AgentsLayout = "desktop" | "tablet" | "mobile"
const createDefaultAgentStream = () => new AgentStream()

export function AgentsWorkspace({ api, session, routeAgent, connection: suppliedConnection, install, streamFactory = createDefaultAgentStream, onNavigate, onNewConversation }: {
  api: AgentsApi
  session: Session
  routeAgent: string | null
  connection: ConnectionState
  install?: { available: boolean; run(): Promise<void> }
  streamFactory?: (() => AgentStream) | null
  onNavigate(destination: "conversations" | "agents", agent?: string | null): void
  onNewConversation(): void
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selected, setSelected] = useState<AgentDetailValue | null>(null)
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loadError, setLoadError] = useState<LoadError>(null)
  const [detailError, setDetailError] = useState<DetailError>(null)
  const [connection, setConnection] = useState(suppliedConnection)
  const [announcement, setAnnouncement] = useState("")
  const [activeAgent, setActiveAgent] = useState(routeAgent)
  const [layout, setLayout] = useState<AgentsLayout>(() => readLayout())
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const detailCloseRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef<string | null>(null)
  const activeAgentRef = useRef(routeAgent)
  const listGeneration = useRef(0)
  const detailGeneration = useRef(0)

  useEffect(() => setConnection(suppliedConnection), [suppliedConnection])
  useEffect(() => { activeAgentRef.current = routeAgent; setActiveAgent(routeAgent) }, [routeAgent])
  useEffect(() => {
    const resize = () => setLayout(readLayout())
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  const loadList = useCallback(async () => {
    const generation = ++listGeneration.current
    setLoadError(null)
    try {
      const next = await api.listAgents()
      if (generation === listGeneration.current) { setAgents(next); setLoading(false) }
    } catch (error) {
      if (generation !== listGeneration.current) return
      setLoading(false)
      setLoadError(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "forbidden" : "unavailable")
    }
  }, [api])

  useEffect(() => { setLoading(true); void loadList(); return () => { listGeneration.current++ } }, [loadList])

  const loadDetail = useCallback(async (agent: string) => {
    const generation = ++detailGeneration.current
    setDetailLoading(true)
    setDetailError(null)
    try {
      const next = await api.getAgent(agent)
      if (generation === detailGeneration.current) { setSelected(next); setDetailLoading(false) }
    } catch (error) {
      if (generation !== detailGeneration.current) return
      setSelected(null); setDetailLoading(false)
      setDetailError(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "forbidden" : error instanceof ApiError && error.status === 404 ? "not_found" : "unavailable")
    }
  }, [api])

  useEffect(() => {
    if (!activeAgent) { setSelected(null); setDetailError(null); setDetailLoading(false); return }
    void loadDetail(activeAgent)
    return () => { detailGeneration.current++ }
  }, [activeAgent, loadDetail])

  useEffect(() => {
    if (!streamFactory) return
    const stream = streamFactory()
    const reload = () => {
      void loadList()
      if (activeAgentRef.current) void loadDetail(activeAgentRef.current)
    }
    void stream.start(0, { onEvent: reload, onInvalidate: reload, onState: setConnection })
    return () => stream.stop()
  }, [loadDetail, loadList, streamFactory])

  useLayoutEffect(() => {
    if (activeAgent || !restoreFocus.current) return
    const name = restoreFocus.current
    const row = rows.current.get(name)
    if (!row?.isConnected) return
    restoreFocus.current = null
    row.focus()
  }, [activeAgent, agents, loading])

  useLayoutEffect(() => {
    if (layout === "tablet" && selected && activeAgent) detailCloseRef.current?.focus()
  }, [activeAgent, layout, selected])

  const selectAgent = (agent: AgentSummary) => { restoreFocus.current = agent.name; activeAgentRef.current = agent.name; setActiveAgent(agent.name); onNavigate("agents", agent.name) }
  const showList = () => { if (activeAgent) restoreFocus.current = activeAgent; activeAgentRef.current = null; setActiveAgent(null); onNavigate("agents", null) }
  const registerRow = (name: string, element: HTMLButtonElement | null) => {
    if (!element) { rows.current.delete(name); return }
    rows.current.set(name, element)
    if (activeAgentRef.current === null && restoreFocus.current === name) {
      restoreFocus.current = null
      element.focus()
    }
  }

  if (loadError) return <main className="agents-shell agents-state-shell" data-layout={layout}><AppRail active="agents" connection={connection} features={session.features} install={install} onNew={onNewConversation} onNavigate={destination => onNavigate(destination)} /><section className="status-page"><div role="alert"><h1>{loadError === "forbidden" ? "Agent access denied" : connection === "offline" ? "Agents are unavailable offline" : "Agents are unavailable"}</h1><p>{loadError === "forbidden" ? "Ask a Switchboard administrator to grant agent access." : "Reconnect to Switchboard, then try again."}</p></div></section><DestinationMobileNav active="agents" features={session.features} onNavigate={destination => onNavigate(destination)} /></main>

  return <main className="agents-shell" data-layout={layout} data-mobile-pane={activeAgent ? "detail" : "list"}>
    <span className="sr-only" aria-live="polite">{announcement || (connection === "live" ? "Agent telemetry live." : `Agent telemetry ${connection}.`)}</span>
    <AppRail active="agents" connection={connection} features={session.features} install={install} onNew={onNewConversation} onNavigate={destination => onNavigate(destination)} />
    {loading ? <section className="agent-list agent-loading" role="status">Loading agents…</section> : <AgentList agents={agents} selected={activeAgent} query={query} onQueryChange={setQuery} onSelect={selectAgent} rowRef={registerRow} />}
    <AgentDetail agent={selected} connection={connection} sessionPermission={session.permissions.agents} api={api} loading={detailLoading} error={detailError} hidden={layout === "tablet" && !activeAgent} closeRef={detailCloseRef} onBack={showList} onReload={() => { if (activeAgentRef.current) void loadDetail(activeAgentRef.current); void loadList() }} onAnnounce={setAnnouncement} />
    <DestinationMobileNav active="agents" features={session.features} onNavigate={destination => onNavigate(destination)} />
  </main>
}

function readLayout(): AgentsLayout {
  return window.innerWidth < 768 ? "mobile" : window.innerWidth < 1200 ? "tablet" : "desktop"
}
