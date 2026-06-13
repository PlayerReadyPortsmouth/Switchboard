/** Turns text into vectors for similarity recall. The seam that lets the rest of
 *  the memory system stay agnostic about *how* embeddings are produced. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
}

/** Local, no-API-key embedder: runs a small ONNX sentence-transformer in-process
 *  via @huggingface/transformers. The model is loaded lazily on first use (and
 *  downloaded/cached on first run), so importing this module is cheap and unit
 *  tests that inject a fake Embedder never pull the model in. */
export class TransformersEmbedder implements Embedder {
  private pipe: ((texts: string[], opts: object) => Promise<{ tolist(): number[][] }>) | null = null
  constructor(private model = "Xenova/all-MiniLM-L6-v2") {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return []
    if (!this.pipe) {
      const { pipeline } = await import("@huggingface/transformers")
      this.pipe = (await pipeline("feature-extraction", this.model)) as unknown as typeof this.pipe
    }
    const out = await this.pipe!(texts, { pooling: "mean", normalize: true })
    return out.tolist()
  }
}
