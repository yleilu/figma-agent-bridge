import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import { discoverChannels } from '../figma-client'
import { ensureRelay } from '../ensure-relay'
import {
  type ToolResult,
  textResult,
  errorMessage,
} from './shared'

export const handleConnect = async (
  params: { channel?: string },
  client: FigmaClient,
  relayHttpUrl?: string,
  port?: number,
): Promise<ToolResult> => {
  let { channel } = params

  if (channel === undefined && relayHttpUrl !== undefined) {
    if (port !== undefined) {
      const relay = await ensureRelay(relayHttpUrl, port)

      if (relay.error !== undefined) {
        return textResult(`Relay error: ${relay.error}`)
      }
    }

    const found = await discoverChannels(relayHttpUrl)

    if (found.length === 0) {
      return textResult(
        'No Figma plugins connected. Open a Figma file with the Agent Bridge plugin running, then try again.',
      )
    }

    if (found.length > 1) {
      const list = found
        .map(
          c =>
            `- ${c.channel}${c.fileName !== null ? ` (${c.fileName})` : ''}`,
        )
        .join('\n')

      return textResult(
        `Multiple Figma plugins connected. Specify a channel:\n${list}`,
      )
    }

    channel = found[0].channel
  }

  if (channel === undefined) {
    return textResult(
      'No channel specified and relay URL not configured for auto-discovery.',
    )
  }

  try {
    await client.joinChannel(channel)

    return textResult(`Connected to channel: ${channel}`)
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

/**
 * status() → { connected, channel, currentPage, selection[], viewport } (D1).
 *
 * Connection state (connected, channel) is known SERVER-side; the LIVE context
 * (currentPage / selection / viewport — what the user is looking at) is read
 * from the plugin via COMMANDS.STATUS and merged in. The plugin's live context
 * is best-effort: if the STATUS round-trip fails or returns nothing, the
 * connection state still reports honestly (never a throw, never a hallucinated
 * context). This is also the documented READ path for the viewport (set_focus is
 * the writer).
 */
export const handleStatus = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return textResult('disconnected')
  }
  const channel = client.currentChannel()

  let live: {
    currentPage?: { id: string; name: string }
    selection?: { id: string; name: string; type: string }[]
    viewport?: {
      center: { x: number; y: number }
      zoom: number
    }
  } = {}
  try {
    const raw = (await client.sendCommand(
      COMMANDS.STATUS,
      {},
    )) as typeof live | null
    if (raw !== null && typeof raw === 'object') {
      live = raw
    }
  } catch {
    // Best-effort: a failed live-context read still reports connection state.
  }

  return textResult(
    JSON.stringify({
      connected: true,
      channel,
      currentPage: live.currentPage,
      selection: live.selection,
      viewport: live.viewport,
    }),
  )
}
