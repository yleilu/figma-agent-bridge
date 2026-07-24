import { useSpring, animated } from '@react-spring/web'
import { cx } from './cx'
import { StatusText } from './status-text'
import { TypingDots } from './typing-dots'
import { PULSE_SPRING } from './springs'
import type { RosterRow } from './roster'
import type { StatusRecord } from '@figma-agent-bridge/shared'

// busy wins while an action is in flight (spec: busy = "a Figma
// action is in flight"; error = "the LAST report flagged a
// failure" — only shown once settled).
const dotClass = (r: StatusRecord): string =>
  r.activity === 'busy'
    ? 'bg-figma-icon-warning'
    : r.level === 'error'
      ? 'bg-figma-icon-danger'
      : 'bg-figma-icon-success'

const timeAgo = (t: number): string => {
  if (!t) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 3) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

// A status dot that breathes (opacity loop) while `busy` and
// rests fully opaque otherwise. Replaces the Tailwind pulse
// keyframe with a react-spring loop so every panel animation
// runs on one engine. Shared by the roster Dot and the Fallback
// "connecting" state.
export const PulseDot = ({
  busy,
  className,
}: {
  busy: boolean
  className?: string
}) => {
  const style = useSpring({
    opacity: 1, // target; busy loops back from 0.4
    from: { opacity: busy ? 0.4 : 1 },
    loop: busy ? { reverse: true } : false,
    reset: busy, // restart the pulse when it goes busy
    immediate: !busy, // idle: snap opaque, no residual pulse
    config: PULSE_SPRING,
  })
  return (
    <animated.span
      style={{ opacity: style.opacity }}
      className={cx(
        'inline-block w-2 h-2 rounded-full',
        className,
      )}
    />
  )
}

const Dot = ({ record }: { record: StatusRecord }) => (
  <PulseDot
    busy={record.activity === 'busy'}
    className={cx('shrink-0', dotClass(record))}
  />
)

const label = (r: StatusRecord): string =>
  (r as { synthetic?: boolean }).synthetic
    ? `session ${r.sessionId?.slice(0, 6) ?? ''}`
    : (r.label ?? r.agentType ?? 'Agent')

export const Row = ({ row }: { row: RosterRow }) => {
  const r = row.record
  const busy = r.activity === 'busy'
  return (
    <div
      className={cx(
        'flex items-center gap-2 px-3 py-1 text-11',
        busy ? 'bg-figma-bg-secondary' : 'opacity-60',
        row.kind === 'child' && 'pl-7',
      )}
    >
      <Dot record={r} />
      <span className="font-semibold text-figma-text shrink-0">
        {label(r)}
      </span>
      {r.text !== null ? (
        <StatusText text={r.text} />
      ) : busy ? (
        <TypingDots />
      ) : null}
      <span className="text-figma-text-tertiary text-[10px] ml-auto shrink-0">
        {timeAgo(r.updatedAt)}
      </span>
    </div>
  )
}
