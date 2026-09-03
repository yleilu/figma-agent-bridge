import { useEffect, useRef } from 'react'
import { nextHeight } from '../spring-height'

const postHeight = (height: number) =>
  parent.postMessage(
    { pluginMessage: { type: 'resize', height } },
    '*',
  )

// The window edge FOLLOWS the measured content 1:1 — it has no
// spring of its own. The content is already animated (rows and the
// selection bar collapse on MOTION_SPRING), so the frame and the
// content move as a single object.
//
// A second spring here could never match: it would be chasing a
// target that is itself still moving, so it always settles LATE no
// matter how it is tuned — which read as the window edge lagging
// behind the selection bar. Smoothing belongs to the content, not
// to the frame: the window is always exactly the size of what it
// holds, and anything that should ease does so by animating its
// own height.
export const useWindowResize = (target: number) => {
  // Last integer handed to the main thread — the dedupe key, so a
  // settled layout stops posting.
  const lastSent = useRef(-1)

  useEffect(() => {
    const h = nextHeight(target, lastSent.current)
    if (h === null) return
    lastSent.current = h
    postHeight(h)
  }, [target])
}
