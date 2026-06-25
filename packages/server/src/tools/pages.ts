// tools/pages.ts — write-pages tools.
//
// create_page: COMMANDS.CREATE_PAGE with {name} → {id,name}.
// set_current_page: COMMANDS.SET_CURRENT_PAGE with {pageId} → {currentPage}.
//   A page-not-found plugin {error} surfaces as an error.
// duplicate_page: COMMANDS.DUPLICATE_PAGE with {pageId,name?} → {id,name}.
//
// All route through formatMutationResult: null → failure text, {error} → an
// error, otherwise JSON.stringify of the plugin reply.

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { FigmaClient } from '../figma-client'
import {
  type ToolResult,
  textResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
} from './shared'

export const handleCreatePage = async (
  { name }: { name: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.CREATE_PAGE,
      { name },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to create page.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleSetCurrentPage = async (
  { pageId }: { pageId: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_CURRENT_PAGE,
      { pageId },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to set current page.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleDuplicatePage = async (
  { pageId, name }: { pageId: string; name?: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.DUPLICATE_PAGE,
      { pageId, name },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to duplicate page.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
