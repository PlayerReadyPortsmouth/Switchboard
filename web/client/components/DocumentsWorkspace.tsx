import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError } from "../api"
import type { DocumentSummary, Session, UploadDocumentResult } from "../types"
import { DocumentCard } from "./DocumentCard"

export type DocumentsApi = {
  listDocuments(scope: "mine" | "org"): Promise<DocumentSummary[]>
  uploadDocument(file: File, options?: { title?: string; visibility?: "private" | "org" }): Promise<UploadDocumentResult>
  setDocumentVisibility(token: string, visibility: "private" | "org"): Promise<{ ok: true }>
  deleteDocument(token: string): Promise<{ ok: true }>
}

type Scope = "mine" | "org"
type LoadError = "forbidden" | "unavailable" | null

export function DocumentsWorkspace({ api, session }: { api: DocumentsApi; session: Session }) {
  const [scope, setScope] = useState<Scope>("mine")
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<LoadError>(null)
  const [dragging, setDragging] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async (next: Scope) => {
    const token = ++generation.current
    setLoading(true)
    setLoadError(null)
    try {
      const rows = await api.listDocuments(next)
      if (token === generation.current) { setDocuments(rows); setLoading(false) }
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
    for (const file of list) await api.uploadDocument(file)
    await load(scope)
  }, [api, load, scope])

  const toggleVisibility = useCallback(async (target: DocumentSummary) => {
    await api.setDocumentVisibility(target.token, target.visibility === "org" ? "private" : "org")
    await load(scope)
  }, [api, load, scope])

  const remove = useCallback(async (target: DocumentSummary) => {
    await api.deleteDocument(target.token)
    await load(scope)
  }, [api, load, scope])

  return (
    <main className="documents-shell">
      <header className="documents-header">
        <h1>Documents</h1>
        <div className="documents-tabs" role="tablist" aria-label="Document scope">
          <button type="button" role="tab" aria-selected={scope === "mine"} onClick={() => setScope("mine")}>Mine</button>
          <button type="button" role="tab" aria-selected={scope === "org"} onClick={() => setScope("org")}>Org-wide</button>
        </div>
        <label className="documents-upload">
          <span>Upload a document</span>
          <input type="file" onChange={event => { void upload(event.currentTarget.files); event.currentTarget.value = "" }} />
        </label>
      </header>
      <section
        className={dragging ? "documents-dropzone dragging" : "documents-dropzone"}
        onDragOver={event => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files) }}
      >
        {loading ? <p role="status">Loading documents…</p>
          : loadError ? <p role="alert">{loadError === "forbidden" ? "You do not have access to documents." : "Documents are unavailable. Try again."}</p>
          : documents.length === 0 ? <p className="documents-empty">No documents yet.</p>
          : <ul className="documents-list">
              {documents.map(document => {
                const viewerIsOwner = document.ownerId === session.identity
                return (
                  <li key={document.token}>
                    <DocumentCard
                      token={document.token}
                      title={document.title}
                      contentType={document.contentType}
                      mode={document.mode}
                      visibility={document.visibility}
                      ownerName={document.ownerName}
                      sizeBytes={document.sizeBytes}
                      viewerIsOwner={viewerIsOwner}
                      onVisibilityToggle={() => void toggleVisibility(document)}
                      onDelete={() => void remove(document)}
                    />
                  </li>
                )
              })}
            </ul>}
      </section>
    </main>
  )
}
