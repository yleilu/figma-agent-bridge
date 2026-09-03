import { useEffect, useRef } from 'react'
import { useTransition, animated } from '@react-spring/web'
import { MOTION_SPRING } from './springs'
import { Row } from './row'
import type { RosterRow } from './roster'

// Fallback natural height if a row's ref isn't measured on the
// very first frame (px-3 py-1 text-11 => 4px*2 padding + 16px
// line). Real height is measured per row; this only guards frame
// zero.
const ROW_VPAD = 4
const LINE_HEIGHT = 16
const ROW_HEIGHT_FALLBACK = ROW_VPAD * 2 + LINE_HEIGHT

// Roster rows enter/leave as a collapse: height 0 <-> measured
// with a crossfade. The window-edge spring (useWindowResize)
// follows the measured content this produces, so add/remove reads
// as one motion. Height cache is keyed by record.key (stable)
// because buildRoster returns fresh row objects each render.
export const AnimatedRoster = ({
  rows,
}: {
  rows: RosterRow[]
}) => {
  const heights = useRef<Record<string, number>>({})
  const first = useRef(true)

  const transitions = useTransition(rows, {
    keys: row => row.record.key,
    from: { opacity: 0, height: 0 },
    enter: row => async next => {
      await next({
        opacity: 1,
        height:
          heights.current[row.record.key] ??
          ROW_HEIGHT_FALLBACK,
      })
    },
    leave: { opacity: 0, height: 0 },
    config: MOTION_SPRING,
    // Rows already present when the panel opens appear settled —
    // only later add/remove animates.
    immediate: first.current,
  })

  useEffect(() => {
    first.current = false
  }, [])

  return (
    <div className="py-1.5">
      {transitions((style, row) => (
        <animated.div
          className="overflow-hidden"
          style={{
            opacity: style.opacity,
            height: style.height,
          }}
        >
          <div
            ref={el => {
              if (el)
                heights.current[row.record.key] =
                  el.offsetHeight
            }}
          >
            <Row row={row} />
          </div>
        </animated.div>
      ))}
    </div>
  )
}
