import { useLayoutEffect, useRef, useState } from 'react'
import { measuredTarget } from '../spring-height'

// Measures the INNER content wrapper's natural (border-box)
// height and returns [ref, target]. Observe the inner wrapper —
// its height is a pure function of content, invariant under
// window resize — NEVER the scroll viewport, whose height tracks
// the window figma.ui.resize mutates (that closes the feedback
// loop). Target is already ceil'd + clamped.
export const useContentHeight = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState(measuredTarget(0))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.borderBoxSize?.[0]
      const raw = box
        ? box.blockSize
        : entry.contentRect.height
      setTarget(measuredTarget(raw))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, target] as const
}
