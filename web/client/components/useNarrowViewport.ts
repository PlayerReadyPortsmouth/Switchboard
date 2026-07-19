import { useEffect, useState } from "react"

/** The workspace's mobile breakpoint, matching `@media (max-width: 767px)` in styles.css and
 *  the `mobile` tier of App's `useWorkspaceLayout`. Kept as innerWidth + a resize listener
 *  rather than matchMedia purely for consistency with that hook. */
export const NARROW_MAX_WIDTH = 767

/** Is the viewport in the mobile tier? Re-evaluates on resize, so rotating a phone or
 *  dragging a desktop window across the breakpoint is picked up. */
export function useNarrowViewport(): boolean {
  const read = () => window.innerWidth <= NARROW_MAX_WIDTH
  const [narrow, setNarrow] = useState(read)
  useEffect(() => {
    const update = () => setNarrow(read())
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [])
  return narrow
}
