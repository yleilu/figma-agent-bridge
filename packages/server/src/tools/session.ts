import type { FigmaClient } from '../figma-client'
import { discoverChannels } from '../figma-client'
import { ensureRelay } from '../ensure-relay'
import { type ToolResult, textResult } from './shared'

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
    const message =
      err instanceof Error ? err.message : String(err)

    return textResult(`Error: ${message}`)
  }
}

export const handleStatus = async (
  client: FigmaClient,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return textResult('disconnected')
  }
  const channel = client.currentChannel()
  return textResult(`connected to channel: ${channel}`)
}
