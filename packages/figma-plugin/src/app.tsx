import { useEffect } from 'react'
import { useRelay } from './hooks/useRelay'
import { useDiscovery } from './hooks/useDiscovery'
import { buildRoster, type RosterRow } from './roster'
import { cx } from './cx'
import { BRAND } from '@figma-agent-bridge/branding'
import { LogoMark } from './logo-mark'
import type { StatusRecord } from '@figma-agent-bridge/shared'

// busy wins while an action is in flight (spec: busy = "a Figma action is in flight";
// error = "the LAST report flagged a failure" — only shown once settled).
const dotClass = (r: StatusRecord): string =>
  r.activity === 'busy'
    ? 'bg-figma-icon-warning'
    : r.level === 'error'
      ? 'bg-figma-icon-danger'
      : 'bg-figma-icon-success'

// Relative timestamp. Approximate — refreshes on the next state change (frequent while
// active); a settled row's time is stamped at its last update. (A 5s tick could keep it
// live; deferred.)
const timeAgo = (t: number): string => {
  if (!t) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 3) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

const Dot = ({ record }: { record: StatusRecord }) => (
  <span
    className={cx(
      'inline-block w-2 h-2 rounded-full shrink-0',
      dotClass(record),
      record.activity === 'busy' && 'animate-pulse',
    )}
  />
)

const Skeleton = () => (
  <span className="inline-flex gap-1 items-center">
    {[0, 1, 2].map(i => (
      <span
        key={i}
        className="w-1 h-1 rounded-full bg-figma-icon-tertiary animate-pulse"
      />
    ))}
  </span>
)

const label = (r: StatusRecord): string =>
  (r as { synthetic?: boolean }).synthetic
    ? `session ${r.sessionId?.slice(0, 6) ?? ''}`
    : (r.label ?? r.agentType ?? 'Agent')

const Row = ({ row }: { row: RosterRow }) => {
  const r = row.record
  const busy = r.activity === 'busy'
  // idle rows are muted (spec §Lifecycle: "the whole row dims"); busy rows get the
  // full-width no-radius band (adjacent busy rows merge — design-system rule).
  return (
    <div
      className={cx(
        'flex items-center gap-2 px-3 py-1 text-11',
        busy ? 'bg-figma-bg-secondary' : 'opacity-60',
        // a child's dot indents to sit under its header's label
        // (native layers-panel nesting). The header renders like a
        // flat row — no caret; the child indent carries the grouping.
        row.kind === 'child' && 'pl-7',
      )}
    >
      <Dot record={r} />
      <span className="font-semibold text-figma-text shrink-0">
        {label(r)}
      </span>
      {r.text === null ? (
        <Skeleton />
      ) : (
        <span className="text-figma-text-secondary truncate">
          {r.text}
        </span>
      )}
      <span className="text-figma-text-tertiary text-[10px] ml-auto shrink-0">
        {timeAgo(r.updatedAt)}
      </span>
    </div>
  )
}

const Fallback = ({
  status,
}: {
  status: 'connecting' | 'disconnected'
}) => {
  const [dot, title, sub] =
    status === 'connecting'
      ? [
          'bg-figma-icon-warning animate-pulse',
          'Connecting…',
          'reaching the bridge',
        ]
      : [
          'bg-figma-icon-danger',
          'Bridge offline',
          'start the MCP / relay to connect',
        ]
  return (
    <div className="flex flex-col gap-1 p-3.5 text-11">
      <div className="flex items-center gap-2">
        <span
          className={cx(
            'inline-block w-2 h-2 rounded-full',
            dot,
          )}
        />
        <span className="font-semibold text-figma-text">
          {title}
        </span>
      </div>
      <div className="text-figma-text-secondary pl-4">
        {sub}
      </div>
    </div>
  )
}

const Idle = () => (
  <div className="flex flex-col gap-1 p-3.5 text-11">
    <div className="flex items-center gap-2">
      <span className="inline-block w-2 h-2 rounded-full bg-figma-icon-tertiary" />
      <span className="font-semibold text-figma-text">
        No agent active
      </span>
    </div>
    <div className="text-figma-text-secondary pl-4">
      waiting for an agent to start work
    </div>
  </div>
)

export const App = () => {
  const { status, connect, agentStatus } = useRelay()
  // REUSE the existing discovery + auto-connect from the current app.tsx
  // (its useDiscovery() usage + the auto-connect useEffect) VERBATIM — do
  // not change the connect wiring, only the render.
  const { port } = useDiscovery()
  useEffect(() => {
    if (status === 'disconnected' && port !== null) {
      connect(port)
    }
  }, [status, port, connect])

  const rows = buildRoster(agentStatus)

  return (
    <div className="min-h-full max-h-screen overflow-y-auto bg-figma-bg text-figma-text">
      <div className="flex items-center gap-2 border-b border-figma-border px-3 py-2">
        <LogoMark decorative />
        <span className="text-11 font-semibold text-figma-text">
          {BRAND.name}
        </span>
      </div>
      {status === 'connecting' && (
        <Fallback status="connecting" />
      )}
      {status === 'disconnected' && (
        <Fallback status="disconnected" />
      )}
      {status === 'connected' &&
        (rows.length === 0 ? (
          <Idle />
        ) : (
          <div className="py-1.5">
            {rows.map(row => (
              <Row
                key={row.record.key}
                row={row}
              />
            ))}
          </div>
        ))}
    </div>
  )
}
