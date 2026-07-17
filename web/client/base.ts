import { normalizeWebBase } from "../webBase"

// Reads the build-time base baked into <meta name="switchboard-base">. Absent (default build)
// resolves to "/". The `doc` param is injectable for tests.
export function readWebBase(doc: { querySelector: (selector: string) => Element | null } = document): string {
  const content = doc.querySelector('meta[name="switchboard-base"]')?.getAttribute("content")
  return normalizeWebBase(content ?? undefined)
}

// Resolved once at load; the app threads this through the router, API client, and SW registration.
export const webBase = readWebBase()
