import {
  APP_VERSION,
  COMMANDS,
} from '@figma-agent-bridge/shared'
import type { ChannelInfo } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import { discoverChannels } from '../figma-client'
import { ensureRelay } from '../ensure-relay'
import {
  type ToolResult,
  textResult,
  errorMessage,
  protocolMismatch,
  synthKey,
} from './shared'

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

// The registry snapshot returned to the agent on connect + status. Each entry's
// fileKey is the SYNTHETIC key (synthKey): a saved file exposes its real
// figma.fileKey, an unsaved file (fileKey === null) is surfaced as its session
// channel so the agent can read AND address it (requireFile auto-joins by it).
const availableView = (
  available: ChannelInfo[],
): {
  fileKey: string
  fileName: string | null
  connectedAt: number
  version?: string
  currentPage?: string
  selected?: number
}[] =>
  available.map(c => ({
    fileKey: synthKey(c),
    fileName: c.fileName,
    connectedAt: c.connectedAt,
    version: c.version,
    currentPage: c.currentPage,
    selected: c.selected,
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
  // change-feed.md — connect() is the OTHER join point (requireFile is the
  // one every file tool flows through). A baseline opens here too, or an
  // explicit connect would leave the file's first pushes unbuffered.
  onJoined?: (
    fileKey: string,
    epoch: string | null,
  ) => void,
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
      // Only version-check a channel the registry actually knows: a discovered
      // channel gets the B2 gate, but a raw explicit channel absent from
      // /channels is the deliberate escape hatch — join it, don't misreport it
      // as a '(none)' version skew (an unregistered channel ≠ a version mismatch).
      if (info !== undefined) {
        const mismatch = protocolMismatch(info.version)
        if (mismatch !== null) {
          client.notifyMismatch(
            info.channel,
            info.version ?? '(none)',
            APP_VERSION,
          )
          return textResult(mismatch)
        }
      }
    }
    try {
      // A never-registered channel (no discovery) is addressed by its own
      // channel as the synthetic fileKey; a discovered one uses synthKey(info).
      const joinedKey =
        info !== undefined ? synthKey(info) : channel
      await client.joinChannel(channel, joinedKey)
      // A raw channel absent from /channels has no registry entry, so no
      // epoch: the baseline opens UNANCHORED and can only reach `ok` once a
      // push names its connection.
      onJoined?.(joinedKey, info?.epoch ?? null)
      return connectResult({
        channel,
        fileKey: joinedKey,
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
  const mismatch = protocolMismatch(info.version)
  if (mismatch !== null) {
    client.notifyMismatch(
      info.channel,
      info.version ?? '(none)',
      APP_VERSION,
    )
    return textResult(mismatch)
  }

  try {
    await client.joinChannel(info.channel, synthKey(info))
    onJoined?.(synthKey(info), info.epoch ?? null)
    return connectResult({
      channel: info.channel,
      fileKey: synthKey(info),
      fileName: info.fileName,
      available,
    })
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

// Per-file live-context reads run in parallel and are BEST-EFFORT, so bound each
// so status never blocks on an unresponsive plugin (default command timeout is
// 30s — far too long for a status probe that degrades to "no live context").
const STATUS_LIVE_TIMEOUT_MS = 2500

/**
 * status() → { connected, joined[], available[] } where each joined entry is
 * { fileKey, fileName, channel, protocolVersion, currentPage, selection[],
 *   viewport }.
 *
 * Reports EVERY joined file (multi-file, B3) — not a single currentFileKey. The
 * connection identity (fileKey/channel) is known SERVER-side; fileName +
 * protocolVersion + available[] come from the relay registry (/channels); the
 * LIVE context (currentPage / selection / viewport) is read PER FILE from its
 * plugin via COMMANDS.STATUS and merged in. Each live read is best-effort and
 * bounded: a failed/slow round-trip still reports connection state for that file
 * (never a throw, never a hallucinated context).
 */
export const handleStatus = async (
  client: FigmaClient,
  relayHttpUrl?: string,
): Promise<ToolResult> => {
  const files = client.joinedFiles()
  if (files.length === 0) {
    return textResult('disconnected')
  }

  let available: ReturnType<typeof availableView> = []
  let infos: ChannelInfo[] = []
  if (relayHttpUrl !== undefined) {
    infos = await discoverChannels(relayHttpUrl)
    available = availableView(infos)
  }

  // One best-effort live read PER joined file (never throws — a failed round
  // trip still reports connection state, never a hallucinated context).
  const joined = await Promise.all(
    files.map(async fileKey => {
      const channel = client.channelFor(fileKey)
      const mine = infos.find(c => synthKey(c) === fileKey)
      let live: {
        currentPage?: { id: string; name: string }
        selection?: {
          id: string
          name: string
          type: string
        }[]
        viewport?: {
          center: { x: number; y: number }
          zoom: number
        }
      } = {}
      try {
        const raw = (await client.sendCommand(
          fileKey,
          COMMANDS.STATUS,
          {},
          STATUS_LIVE_TIMEOUT_MS,
        )) as typeof live | null
        if (raw !== null && typeof raw === 'object') {
          live = raw
        }
      } catch {
        // Best-effort per file.
      }
      return {
        fileKey,
        fileName: mine?.fileName ?? null,
        channel,
        protocolVersion: mine?.version,
        currentPage: live.currentPage,
        selection: live.selection,
        viewport: live.viewport,
      }
    }),
  )

  return textResult(
    JSON.stringify({ connected: true, joined, available }),
  )
}
