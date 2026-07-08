import {
  COMMANDS,
  APP_VERSION,
  majorMinor,
} from '@figma-agent-bridge/shared'
import type { ChannelInfo } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import { discoverChannels } from '../figma-client'
import { ensureRelay } from '../ensure-relay'
import {
  type ToolResult,
  textResult,
  errorMessage,
} from './shared'

// Returns an actionable error if the channel's plugin reports a version whose
// major.minor differs from the server's (a breaking difference, per B2), else null.
// `undefined` info (channel not in the registry) → no error (best-effort); a plugin
// that reports no version at all is treated as incompatible.
const protocolMismatch = (
  info: ChannelInfo | undefined,
): string | null => {
  if (info === undefined) {
    return null
  }
  const theirs = info.version
  if (
    theirs !== undefined &&
    majorMinor(theirs) === majorMinor(APP_VERSION)
  ) {
    return null
  }
  const got = theirs ?? '(none)'
  return (
    `Figma plugin version '${got}' is incompatible with server version ` +
    `'${APP_VERSION}' (major.minor mismatch) — reinstall/update the Figma plugin ` +
    `(or update the MCP server if it is the older side).`
  )
}

// --- target resolution (B3): match a connect request to exactly ONE file ---
// fileKey is the stable identity and wins; fileName is the fallback; with
// neither given we never guess — return `unspecified` so connect asks the
// caller to name a file (B3). Anything other than a single match asks too.
export type TargetResolution =
  | { ok: true; info: ChannelInfo }
  | {
      ok: false
      reason: 'none' | 'ambiguous' | 'unspecified'
    }

export const resolveTarget = (
  available: ChannelInfo[],
  target: { fileKey?: string; fileName?: string },
): TargetResolution => {
  const { fileKey, fileName } = target
  // No target named → never guess (B3), even for a single open file.
  if (fileKey === undefined && fileName === undefined) {
    return {
      ok: false,
      reason:
        available.length === 0 ? 'none' : 'unspecified',
    }
  }
  const matches =
    fileKey !== undefined
      ? available.filter(c => c.fileKey === fileKey)
      : available.filter(c => c.fileName === fileName)
  if (matches.length === 1) {
    return { ok: true, info: matches[0] }
  }
  return {
    ok: false,
    reason: matches.length === 0 ? 'none' : 'ambiguous',
  }
}

// Human-readable listing of every connected file for an ASK error.
const listAvailable = (available: ChannelInfo[]): string =>
  available
    .map(c => {
      const label = c.fileName ?? '(unsaved file)'
      const key = c.fileKey ?? '(no fileKey)'
      return `- ${label} [fileKey: ${key}, channel: ${c.channel}]`
    })
    .join('\n')

// The ASK message: never fall back to the only/first file — name what was
// asked for and hand back the choices so the agent picks by fileKey.
const askMessage = (
  reason: 'none' | 'ambiguous' | 'unspecified',
  target: { fileKey?: string; fileName?: string },
  available: ChannelInfo[],
): string => {
  const by =
    target.fileKey !== undefined
      ? `fileKey '${target.fileKey}'`
      : target.fileName !== undefined
        ? `fileName '${target.fileName}'`
        : 'the open files'
  const head =
    reason === 'unspecified'
      ? `No target file specified.`
      : reason === 'ambiguous'
        ? `Multiple connected Figma files match ${by}.`
        : `No connected Figma file matches ${by}.`
  return (
    `${head} Choose one and call connect again with its { fileKey } ` +
    `(never guessing):\n${listAvailable(available)}`
  )
}

// The registry snapshot returned to the agent on connect + status.
const availableView = (
  available: ChannelInfo[],
): {
  fileKey: string | null
  fileName: string | null
  connectedAt: number
}[] =>
  available.map(c => ({
    fileKey: c.fileKey,
    fileName: c.fileName,
    connectedAt: c.connectedAt,
  }))

const connectResult = (r: {
  channel: string
  fileKey: string | null
  fileName: string | null
  available: ChannelInfo[]
}): ToolResult =>
  textResult(
    JSON.stringify({
      connected: true,
      fileKey: r.fileKey,
      fileName: r.fileName,
      channel: r.channel,
      available: availableView(r.available),
    }),
  )

export const handleConnect = async (
  params: {
    fileKey?: string
    fileName?: string
    channel?: string
  },
  client: FigmaClient,
  relayHttpUrl?: string,
  port?: number,
): Promise<ToolResult> => {
  const { fileKey, fileName, channel } = params

  // Explicit channel override (escape hatch): join it directly — no discovery
  // match. Kept so a caller that already knows the channel can bypass targeting.
  if (channel !== undefined) {
    let info: ChannelInfo | undefined
    let available: ChannelInfo[] = []
    if (relayHttpUrl !== undefined) {
      available = await discoverChannels(relayHttpUrl)
      info = available.find(c => c.channel === channel)
      const mismatch = protocolMismatch(info)
      if (mismatch !== null) {
        return textResult(mismatch)
      }
    }
    try {
      await client.joinChannel(
        channel,
        info?.fileKey ?? null,
      )
      return connectResult({
        channel,
        fileKey: info?.fileKey ?? null,
        fileName: info?.fileName ?? null,
        available,
      })
    } catch (err) {
      return textResult(`Error: ${errorMessage(err)}`)
    }
  }

  if (relayHttpUrl === undefined) {
    return textResult(
      'No target specified and relay URL not configured for auto-discovery.',
    )
  }

  if (port !== undefined) {
    const relay = await ensureRelay(relayHttpUrl, port)
    if (relay.error !== undefined) {
      return textResult(`Relay error: ${relay.error}`)
    }
  }

  const available = await discoverChannels(relayHttpUrl)
  if (available.length === 0) {
    return textResult(
      'No Figma plugins connected. Open a Figma file with the Agent Bridge plugin running, then try again.',
    )
  }

  const resolution = resolveTarget(available, {
    fileKey,
    fileName,
  })
  if (!resolution.ok) {
    return textResult(
      askMessage(
        resolution.reason,
        { fileKey, fileName },
        available,
      ),
    )
  }

  const { info } = resolution
  const mismatch = protocolMismatch(info)
  if (mismatch !== null) {
    return textResult(mismatch)
  }

  try {
    await client.joinChannel(info.channel, info.fileKey)
    return connectResult({
      channel: info.channel,
      fileKey: info.fileKey,
      fileName: info.fileName,
      available,
    })
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

/**
 * status() → { connected, fileKey, fileName, channel, available[],
 *              protocolVersion, currentPage, selection[], viewport }.
 *
 * Connection identity (fileKey/channel) is known SERVER-side (fileKey from the
 * client's join target); fileName + protocolVersion + available[] come from the
 * relay registry (/channels); the LIVE context (currentPage / selection /
 * viewport) is read from the plugin via COMMANDS.STATUS and merged in. The live
 * read is best-effort: a failed round-trip still reports connection state (never
 * a throw, never a hallucinated context).
 */
export const handleStatus = async (
  client: FigmaClient,
  relayHttpUrl?: string,
): Promise<ToolResult> => {
  if (!client.isConnected()) {
    return textResult('disconnected')
  }
  const channel = client.currentChannel()
  const fileKey = client.currentFileKey()

  let fileName: string | null = null
  let protocolVersion: string | undefined
  let available: {
    fileKey: string | null
    fileName: string | null
    connectedAt: number
  }[] = []
  if (relayHttpUrl !== undefined) {
    const infos = await discoverChannels(relayHttpUrl)
    available = availableView(infos)
    const mine = infos.find(
      c => channel !== null && c.channel === channel,
    )
    fileName = mine?.fileName ?? null
    protocolVersion = mine?.version
  }

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
      fileKey,
      fileName,
      channel,
      available,
      protocolVersion,
      currentPage: live.currentPage,
      selection: live.selection,
      viewport: live.viewport,
    }),
  )
}
