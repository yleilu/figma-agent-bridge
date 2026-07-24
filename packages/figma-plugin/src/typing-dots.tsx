import { useTrail, animated } from '@react-spring/web'
import { cx } from './cx'
import { DOTS_SPRING } from './springs'

const DOTS = [0, 1, 2]

// Staggered typing indicator for the busy / no-narrative state.
// useTrail auto-staggers the three dots; the ping-pong loop
// bounces them into a traveling wave.
export const TypingDots = () => {
  const trail = useTrail(DOTS.length, {
    loop: { reverse: true },
    from: { opacity: 0.3, y: 2 },
    to: { opacity: 1, y: -2 },
    config: DOTS_SPRING,
  })

  return (
    <span className="inline-flex gap-1 items-center">
      {trail.map((style, i) => (
        <animated.span
          key={DOTS[i]}
          className={cx(
            'w-1 h-1 rounded-full',
            'bg-figma-icon-tertiary',
          )}
          style={{
            opacity: style.opacity,
            transform: style.y.to(
              v => `translateY(${v}px)`,
            ),
          }}
        />
      ))}
    </span>
  )
}
