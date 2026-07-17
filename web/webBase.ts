// Single source of truth for the web workspace URL base path.
// Pure so both the build script (scripts/build-web.ts) and the client bundle can import it.
// The result ("BASE") is "/" when unset, otherwise has exactly one leading and one trailing
// slash (e.g. "/switchboard/"). Duplicate slashes at the ends are collapsed; internal slashes
// are preserved.
export function normalizeWebBase(raw: string | undefined): string {
  if (raw === undefined) return "/"
  const trimmed = raw.trim()
  const core = trimmed.replace(/^\/+/, "").replace(/\/+$/, "")
  return core === "" ? "/" : `/${core}/`
}
