// --- WebSocket message types ---

export type JoinMessage = {
  type: 'join'
  channel: string
}

export type ChannelMessage = {
  type: 'message'
  channel: string
  message: CommandMessage
}

export type BroadcastMessage = {
  type: 'broadcast'
  message: CommandMessage
}

export type SystemMessage = {
  type: 'system'
  message: {
    id: string
    result: string
  }
}

export type RegisterMessage = {
  type: 'register'
  channel: string
  fileName: string | null
  fileKey?: string | null
  version?: string
  currentPage?: string
  selected?: number
}

export type PresenceMessage = {
  type: 'presence'
  channel: string
  currentPage?: string
  selected?: number
}

export type LeaveMessage = {
  type: 'leave'
  channel: string
}

export type RelayIncoming =
  | JoinMessage
  | ChannelMessage
  | RegisterMessage
  | PresenceMessage
  | LeaveMessage
export type RelayOutgoing = BroadcastMessage | SystemMessage

// --- Command types ---

// --- Request metadata (request-envelope.md) ---
// Rides every frame. Commands carry { fileKey, sessionId?, requestId };
// replies carry { requestId }; pushes carry { fileKey, epoch } (change-feed,
// forward-compat — not implemented here). Generalizes the old flat
// targetFileKey/id.
export type Meta = {
  fileKey?: string | null
  sessionId?: string
  agentId?: string
  agentType?: string
  requestId?: string
  epoch?: string
}

export type CommandMessage = {
  // Present on a request/push (server↔plugin), omitted on a bare reply.
  command?: string
  params?: Record<string, unknown>
  meta?: Meta
  result?: unknown
  error?: string
}

// --- Channel registry ---

export type ChannelInfo = {
  channel: string
  fileName: string | null
  // Stable per-file identity carried into the availability registry (B3).
  // null when the registering plugin had no figma.fileKey.
  fileKey: string | null
  connectedAt: number
  version?: string
  // Presence enrichment: page NAME the plugin is currently viewing.
  currentPage?: string
  // Presence enrichment: count of currently selected nodes.
  selected?: number
}

// --- M2 parsed output types ---

export type ParsedNode = {
  id: string
  name: string
  type: string
  size: [number, number]
  position?: [number, number]
  layout?: {
    mode: 'H' | 'V'
    spacing: number
    padding: [number, number, number, number]
    align: [string, string]
    wrap?: boolean
  }
  sizing?: [string, string]
  fills?: string[]
  strokes?: string[]
  strokeWeight?: number
  strokeAlign?: string
  strokeDash?: number[]
  radius?: number | [number, number, number, number]
  opacity?: number
  effects?: string[]
  text?: {
    content: string
    font: string
    align?: string
    color?: string
    lineHeight?: string
    letterSpacing?: string
    decoration?: string
    case?: string
  }
  component?: {
    name: string
    id: string
    variant?: Record<string, string>
    overrides?: string[]
  }
  layoutPositioning?: string
  textAutoResize?: string
  children?: ParsedNode[]
}

export type InspectSummary = {
  name: string
  id: string
  totalLayers: number
  maxDepth: number
  typeBreakdown: Record<string, number>
  componentNames: string[]
  layoutMode: 'H' | 'V' | null
  size: [number, number]
  rootFill: string | null
}

export type PageFrameInfo = {
  id: string
  name: string
  type: string
  size: [number, number]
  position: [number, number]
  childrenCount: number
}

export type StyleInfo = {
  id: string
  name: string
  type: 'paint' | 'text' | 'effect' | 'grid'
  color?: string
  font?: string
  lineHeight?: number
  effects?: string[]
}

export type ComponentInfo = {
  id: string
  name: string
  page?: string
  variants?: Record<string, string[]>
  properties?: {
    name: string
    type: string
    default?: string | boolean
  }[]
}

export type SearchResult = {
  id: string
  name: string
  type: string
  page: string
  parent: string
  size: [number, number]
}
