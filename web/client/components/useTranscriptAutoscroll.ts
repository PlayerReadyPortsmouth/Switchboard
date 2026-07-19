import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

/**
 * A reader within this many pixels of the bottom is treated as following the
 * conversation, so new messages scroll into view. Anything further up is
 * deliberate reading and is never yanked downward.
 */
export const PIN_THRESHOLD_PX = 64

type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number }

export function isPinnedToBottom(metrics: ScrollMetrics, threshold = PIN_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

/**
 * Keeps a scroll container parked at the newest content.
 *
 * Opening a conversation lands at the bottom with no animation; new messages
 * follow only while the reader is already at the bottom. Content that grows
 * after paint (attachment cards, the turn-steps spine, long code blocks) is
 * caught by observing the container's children, so the final resting position
 * is the true bottom rather than wherever the first paint happened to end.
 */
export function useTranscriptAutoscroll(conversationId: string, contentKey: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)

  const markPinned = useCallback((next: boolean) => {
    pinnedRef.current = next
    setPinned(current => (current === next ? current : next))
  }, [])

  // Always an instant jump, never an animation: opening a conversation must not
  // glide from top to bottom, and scrollTo({ behavior: "smooth" }) silently
  // no-ops in environments that disable scroll animation, which would leave the
  // reader stranded with no scroll at all. Setting scrollTop always works, and
  // having no motion at all is trivially correct under prefers-reduced-motion.
  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    markPinned(true)
  }, [markPinned])

  // Opening a conversation always starts pinned at its own bottom, so scroll
  // position never leaks in from the previously viewed conversation.
  useLayoutEffect(() => {
    markPinned(true)
    jumpToLatest()
  }, [conversationId, jumpToLatest, markPinned])

  // New content follows the bottom only when the reader is already there.
  useLayoutEffect(() => {
    if (pinnedRef.current) jumpToLatest()
  }, [contentKey, conversationId, jumpToLatest])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const onScroll = () => markPinned(isPinnedToBottom(element))
    element.addEventListener("scroll", onScroll, { passive: true })
    return () => element.removeEventListener("scroll", onScroll)
  }, [markPinned])

  // Late layout (cards, spine rows, code blocks) can leave the first paint
  // short of the true bottom; re-settle whenever the rendered height moves.
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === "undefined") return
    const settle = () => { if (pinnedRef.current) jumpToLatest() }
    const resize = new ResizeObserver(settle)
    const observeChildren = () => {
      resize.disconnect()
      for (const child of Array.from(element.children)) resize.observe(child)
    }
    observeChildren()
    let mutations: MutationObserver | undefined
    if (typeof MutationObserver !== "undefined") {
      mutations = new MutationObserver(() => { observeChildren(); settle() })
      mutations.observe(element, { childList: true })
    }
    return () => { resize.disconnect(); mutations?.disconnect() }
  }, [conversationId, jumpToLatest])

  return { scrollRef, pinned, jumpToLatest }
}
