import { useTransition, animated } from '@react-spring/web'
import { cx } from './cx'
import { MOTION_SPRING } from './springs'

// Enter/exit crossfade+slide keyed on the status string: a new
// text mounts a fresh item while the old one leaves. Items are
// absolutely positioned so enter/leave overlap.
export const StatusText = ({ text }: { text: string }) => {
  const transitions = useTransition(text, {
    key: text,
    from: { opacity: 0, y: 6 },
    enter: { opacity: 1, y: 0 },
    leave: { opacity: 0, y: -6 },
    config: MOTION_SPRING,
  })

  return (
    <span className="relative block flex-1 h-4 overflow-hidden">
      {transitions((style, item) => (
        <animated.span
          className={cx(
            'absolute inset-x-0 truncate',
            'text-figma-text-secondary',
          )}
          style={{
            opacity: style.opacity,
            transform: style.y.to(
              v => `translateY(${v}px)`,
            ),
          }}
        >
          {item}
        </animated.span>
      ))}
    </span>
  )
}
