import { useEffect, useRef } from 'react'
import { useSpring } from '@react-spring/web'
import {
  MIN_WINDOW_HEIGHT,
  nextHeight,
} from '../spring-height'
import { WINDOW_SPRING } from '../springs'

const postHeight = (height: number) =>
  parent.postMessage(
    { pluginMessage: { type: 'resize', height } },
    '*',
  )

// Springs the OUTER Figma window from MIN toward the measured
// inner-content `target`, posting a rounded + deduped px each
// animated frame. The spring holds the current height
// internally, so api.start always animates from where it is now
// -> the new target, and onChange emits every interpolated frame.
export const useWindowResize = (target: number) => {
  const lastSent = useRef(-1)

  const [, api] = useSpring(() => ({
    height: MIN_WINDOW_HEIGHT,
    config: WINDOW_SPRING,
    onChange: result => {
      const h = nextHeight(
        result.value.height,
        lastSent.current,
      )
      if (h === null) return
      lastSent.current = h
      postHeight(h)
    },
  }))

  useEffect(() => {
    api.start({ height: target })
  }, [target, api])
}
