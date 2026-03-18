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

export type PingMessage = {
  type: 'ping'
}

export type PongMessage = {
  type: 'pong'
  name: string
  version: string
}

export type RelayIncoming =
  | JoinMessage
  | ChannelMessage
  | PingMessage
export type RelayOutgoing =
  | BroadcastMessage
  | SystemMessage
  | PongMessage

// --- Command types ---

export type CommandMessage = {
  id: string
  command: string
  params?: Record<string, unknown>
  result?: unknown
  error?: string
}

// --- Channel registry ---

export type ChannelInfo = {
  channel: string
  fileName: string | null
  connectedAt: number
}
