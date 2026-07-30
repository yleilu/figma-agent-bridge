// tools/create-image.ts — create_image.
//
// COMMANDS.CREATE_IMAGE with EXACTLY ONE of {url} | {bytes} → {hash}. The
// url-XOR-bytes constraint is validated here (the Zod schema keeps both
// optional) so an invalid call never reaches the plugin.
//
// T7 degrade: when the plugin cannot fetch/create the image it replies with
// {warnings:[…]} (NO hash, NO error). formatMutationResult sees no `error`
// key and reports success-with-warnings — so the degrade flows through as
// success, never an error.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import {
  type ToolResult,
  formatMutationResult,
  toolError,
  errorEnvelope,
} from './shared'

export const handleCreateImage = async (
  { url, bytes }: { url?: string; bytes?: number[] },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  const hasUrl = url !== undefined
  const hasBytes = bytes !== undefined
  if (hasUrl === hasBytes) {
    return errorEnvelope(
      'INVALID_PARAM',
      'create_image requires exactly one of url or bytes.',
    )
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.CREATE_IMAGE,
      hasUrl ? { url } : { bytes },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to create image.',
    )
  } catch (err) {
    return toolError(err)
  }
}
