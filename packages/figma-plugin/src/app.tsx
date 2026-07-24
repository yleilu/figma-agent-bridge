import { useEffect } from 'react'
import { useRelay } from './hooks/useRelay'
import { useDiscovery } from './hooks/useDiscovery'
import { useContentHeight } from './hooks/useContentHeight'
import { useWindowResize } from './hooks/useWindowResize'
import { buildRoster } from './roster'
import { selectPanelView } from './panel-view'
import { AnimatedRoster } from './roster-list'
import { PulseDot } from './row'
import { MAX_WINDOW_HEIGHT } from './spring-height'
import { cx } from './cx'

const Fallback = ({
  status,
}: {
  status: 'connecting' | 'disconnected'
}) => {
  const connecting = status === 'connecting'
  const [dot, title, sub] = connecting
    ? [
        'bg-figma-icon-warning',
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
        <PulseDot
          busy={connecting}
          className={dot}
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

const VersionMismatch = ({
  plugin,
  server,
}: {
  plugin: string
  server: string
}) => (
  <div className="flex flex-col gap-1 p-3.5 text-11">
    <div className="flex items-center gap-2">
      <span className="inline-block w-2 h-2 rounded-full bg-figma-icon-danger" />
      <span className="font-semibold text-figma-text">
        Version mismatch
      </span>
    </div>
    <div className="text-figma-text-secondary pl-4">
      Your plugin (
      <span className="text-figma-text">{plugin}</span>)
      doesn't match the server (
      <span className="text-figma-text">{server}</span>).
      Update either side so they match.
    </div>
  </div>
)

export const App = () => {
  const { status, connect, agentStatus, mismatch } =
    useRelay()
  const { port } = useDiscovery()
  useEffect(() => {
    if (status === 'disconnected' && port !== null) {
      connect(port)
    }
  }, [status, port, connect])

  const rows = buildRoster(agentStatus)
  const view = selectPanelView(
    status,
    mismatch,
    rows.length,
  )

  const [contentRef, target] = useContentHeight()
  useWindowResize(target)
  const atCap = target >= MAX_WINDOW_HEIGHT

  return (
    <div
      className={cx(
        'max-h-screen bg-figma-bg text-figma-text',
        atCap ? 'overflow-y-auto' : 'overflow-hidden',
      )}
    >
      <div ref={contentRef}>
        {view.kind === 'connecting' && (
          <Fallback status="connecting" />
        )}
        {view.kind === 'offline' && (
          <Fallback status="disconnected" />
        )}
        {view.kind === 'mismatch' && (
          <VersionMismatch
            plugin={view.plugin}
            server={view.server}
          />
        )}
        {view.kind === 'idle' && <Idle />}
        {view.kind === 'roster' && (
          <AnimatedRoster rows={rows} />
        )}
      </div>
    </div>
  )
}
