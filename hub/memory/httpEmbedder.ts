import type { Embedder } from "./embedder"
import { type HttpFetch, defaultFetch } from "./memoryIndex"

export interface HttpEmbedderOpts {
  baseUrl: string          // OpenAI-compatible base, e.g. https://api.openai.com/v1 or a local TEI/Ollama
  apiKey?: string
  model: string            // e.g. text-embedding-3-small — also the embedding `version`
  fetch?: HttpFetch
}

/** Embedder backed by an OpenAI-compatible `/embeddings` endpoint. Works against
 *  OpenAI, Together, or a self-hosted TEI/Ollama/LM Studio — base URL + key only.
 *  The model id is the embedding-space version (stamped on every stored vector). */
export class HttpEmbedder implements Embedder {
  constructor(private o: HttpEmbedderOpts) {}
  get version(): string { return this.o.model }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return []
    const f = this.o.fetch ?? defaultFetch()
    const res = await f(`${this.o.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.o.model, input: texts }),
    })
    if (!res.ok) throw new Error(`embeddings http ${res.status}`)
    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] }
    return data.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding)
  }
}
