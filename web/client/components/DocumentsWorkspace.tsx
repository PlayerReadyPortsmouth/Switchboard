import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ApiError } from "../api"
import type { ConnectionState, DocumentSummary, Session, UploadDocumentResult } from "../types"
import { AppRail } from "./AppRail"
import { DestinationMobileNav } from "./DestinationMobileNav"
import { DocumentRow } from "./DocumentRow"
import { DocumentViewer, type DocumentViewerApi } from "./DocumentViewer"

export type DocumentsApi = DocumentViewerApi & {
  listDocuments(scope: "mine" | "org"): Promise<DocumentSummary[]>
  uploadDocument(file: File, options?: { title?: string; visibility?: "private" | "org" }): Promise<UploadDocumentResult>
  setDocumentVisibility(token: string, visibility: "private" | "org"): Promise<{ ok: true }>
  deleteDocument(token: string): Promise<{ ok: true }>
}

type Scope = "mine" | "org"
type LoadError = "forbidden" | "unavailable" | null
type DocumentsLayout = "desktop" | "tablet" | "mobile"

/** The Documents library: the app-shell rail, a list pane, and an in-page viewer pane. Mirrors
 *  `AgentsWorkspace` — same rail/connection/install props, same tablet/mobile pane collapse —
 *  so the three destinations read as one product. */
export function DocumentsWorkspace({ api, session, routeToken, connection, install, onNavigate, onNewConversation }: {
  api: DocumentsApi
  session: Session
  routeToken?: string | null
  connection?: ConnectionState
  install?: { available: boolean; run(): Promise<void> }
  onNavigate?(destination: "conversations" | "agents" | "documents", token?: string | null): void
  onNewConversation?(): void
}) {
  const [scope, setScope] = useState<Scope>("mine")
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<LoadError>(null)
  const [actionError, setActionError] = useState("")
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [activeToken, setActiveToken] = useState<string | null>(routeToken ?? null)
  const [layout, setLayout] = useState<DocumentsLayout>(() => readLayout())
  const generation = useRef(0)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const restoreFocus = useRef<string | null>(null)
  const scopeProbed = useRef<string | null>(null)
  const viewerCloseRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { setActiveToken(routeToken ?? null) }, [routeToken])
  useEffect(() => {
    const resize = () => setLayout(readLayout())
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [])

  const load = useCallback(async (next: Scope) => {
    const token = ++generation.current
    setLoading(true)
    setLoadError(null)
    try {
      const listed = await api.listDocuments(next)
      if (token === generation.current) { setDocuments(listed); setLoading(false) }
    } catch (error) {
      if (token !== generation.current) return
      setLoading(false)
      setLoadError(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "forbidden" : "unavailable")
    }
  }, [api])

  useEffect(() => { void load(scope); return () => { generation.current++ } }, [load, scope])

  const upload = useCallback(async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    setActionError("")
    setUploading(true)
    try {
      for (const file of list) await api.uploadDocument(file)
    } catch (error) {
      setActionError(error instanceof ApiError && error.status === 413 ? "That file is too large to upload." : "The upload failed. Try again.")
    } finally {
      setUploading(false)
    }
    await load(scope)
  }, [api, load, scope])

  const toggleVisibility = useCallback(async (target: DocumentSummary) => {
    setActionError("")
    try {
      await api.setDocumentVisibility(target.token, target.visibility === "org" ? "private" : "org")
    } catch { setActionError("The visibility change did not stick. Try again."); return }
    await load(scope)
  }, [api, load, scope])

  const remove = useCallback(async (target: DocumentSummary) => {
    setActionError("")
    try {
      await api.deleteDocument(target.token)
    } catch { setActionError("That document could not be deleted. Try again."); return }
    if (target.token === activeToken) select(null)
    await load(scope)
  }, [api, activeToken, load, scope])

  function select(token: string | null) {
    if (token === null && activeToken) restoreFocus.current = activeToken
    setActiveToken(token)
    onNavigate?.("documents", token)
  }

  // Returning from the viewer puts focus back on the row that opened it.
  useLayoutEffect(() => {
    if (activeToken || !restoreFocus.current) return
    const row = rows.current.get(restoreFocus.current)
    if (!row?.isConnected) return
    restoreFocus.current = null
    row.focus()
  }, [activeToken, documents])

  useLayoutEffect(() => {
    if (layout !== "desktop" && activeToken) viewerCloseRef.current?.focus()
  }, [activeToken, layout])

  // A deep link (from a transcript attachment card, or a pasted URL) can name a document that
  // is not in the default "mine" scope — anything an agent published, or a colleague's org-wide
  // file. Probe the org shelf once per token before giving up, so following an attachment lands
  // on the document instead of an empty viewer.
  useEffect(() => {
    if (loading || loadError || !activeToken) return
    if (documents.some(item => item.token === activeToken)) { scopeProbed.current = null; return }
    if (scope === "org" || scopeProbed.current === activeToken) return
    scopeProbed.current = activeToken
    setScope("org")
  }, [activeToken, documents, loadError, loading, scope])

  const selected = documents.find(item => item.token === activeToken) ?? null
  const changeScope = (next: Scope) => { if (next === scope) return; setScope(next); select(null) }

  return (
    <main className="documents-shell" data-layout={layout} data-mobile-pane={activeToken ? "viewer" : "list"}>
      {onNavigate ? <AppRail
        active="documents"
        connection={connection ?? "live"}
        features={session.features}
        install={install}
        onNew={() => onNewConversation?.()}
        onNavigate={destination => onNavigate(destination)}
      /> : null}
      <section className="document-list" aria-label="Documents" data-region="document-navigation">
        <header className="list-header">
          <h1>Documents</h1>
          <span className="agent-count">{loading ? "…" : `${documents.length} ${documents.length === 1 ? "file" : "files"}`}</span>
        </header>
        <div className="documents-tabs" role="tablist" aria-label="Document scope">
          <button type="button" role="tab" aria-selected={scope === "mine"} onClick={() => changeScope("mine")}>Mine</button>
          <button type="button" role="tab" aria-selected={scope === "org"} onClick={() => changeScope("org")}>Org-wide</button>
        </div>
        <div
          className="documents-dropzone"
          data-dragging={dragging}
          onDragOver={event => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files) }}
        >
          <p className="documents-dropzone-hint">{dragging ? "Drop to upload" : uploading ? "Uploading…" : "Drag files here"}</p>
          <label className="documents-upload">
            <span>Upload a document</span>
            <input type="file" multiple onChange={event => { void upload(event.currentTarget.files); event.currentTarget.value = "" }} />
          </label>
        </div>
        {actionError ? <p className="documents-error" role="alert">{actionError}</p> : null}
        {loading ? <p className="documents-status" role="status">Loading documents…</p>
          : loadError ? <p className="documents-status documents-error" role="alert">{loadError === "forbidden" ? "You do not have access to documents." : "Documents are unavailable. Try again."}</p>
          : documents.length === 0 ? (
            <div className="empty-state">
              <h2>{scope === "org" ? "Nothing shared org-wide yet" : "Your library is empty"}</h2>
              <p>{scope === "org"
                ? "Documents appear here once someone marks them org-wide. Publish one of yours to start the shelf."
                : "Drag a file into the box above, or ask an agent to publish one from a conversation. Everything you add stays private until you say otherwise."}</p>
            </div>
          )
          : <ul className="documents-list">
              {documents.map(item => (
                <li key={item.token}>
                  <DocumentRow
                    document={item}
                    selected={item.token === activeToken}
                    viewerIsOwner={item.ownerId === session.identity}
                    rowRef={element => { if (element) rows.current.set(item.token, element); else rows.current.delete(item.token) }}
                    onSelect={() => select(item.token)}
                    onVisibilityToggle={() => void toggleVisibility(item)}
                    onDelete={() => void remove(item)}
                  />
                </li>
              ))}
            </ul>}
      </section>
      <DocumentViewer
        document={selected}
        api={api}
        hidden={layout !== "desktop" && !activeToken}
        closeRef={viewerCloseRef}
        onBack={() => select(null)}
      />
      {onNavigate ? <DestinationMobileNav active="documents" features={session.features} onNavigate={destination => onNavigate(destination)} /> : null}
    </main>
  )
}

function readLayout(): DocumentsLayout {
  return window.innerWidth < 768 ? "mobile" : window.innerWidth < 1200 ? "tablet" : "desktop"
}
