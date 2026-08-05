// tools/components.ts — M3-B write tools for components & instances.
//
// create_component (PROMOTE-ONLY, un-overloaded per spec): promote an existing
//   node via createComponentFromNode(), optionally rename / set description.
//   The build-from-spec overload was removed — build with create_node /
//   create_tree first, then promote the returned id.
//   → COMMANDS.CREATE_COMPONENT → {id,key,name,type}.
// update_component: add/edit/delete componentPropertyDefinitions, set the
//   description, expose nested instances (T7-gated). → COMMANDS.UPDATE_COMPONENT
//   → {id,properties,warnings} where `properties` is the catalogue ARRAY of
//   {id,name,type,defaultValue,variantOptions?} (round-trips get_components; each
//   entry's `id` is the canonical property id added properties need).
// combine_variants: combine ≥2 components into a variant set (handler-guarded
//   <2). Returns the set's `key` (read/write symmetry) + warns when source
//   names don't use the "Property=Value" axis convention (multi-axis nudge,
//   T7/T9). → COMMANDS.COMBINE_VARIANTS → {id,key,name,type,variantAxes,warnings}.
// swap_component: point an instance at a different main component — LOCAL by
//   mainComponentId OR REMOTE by `key` (resolved via importComponentByKeyAsync,
//   T7-gated). LOCAL wins if both given. Swap/import failures degrade (T7). →
//   COMMANDS.SWAP_COMPONENT → {id,mainComponent,warnings}.
// set_instance: set instance properties via setProperties and/or apply per-node
//   overrides (overrides degrade — not yet applied). → COMMANDS.SET_INSTANCE.
//   The plugin echoes the RAW Figma componentProperties ({ [name]:{type,value} });
//   the SERVER splits it through splitComponentProperties into the SAME
//   { variantProperties?, componentProperties? } shape get_node / get_components
//   emit, so the write-echo round-trips its READ twin exactly (T2). →
//   {id, variantProperties?, componentProperties?, warnings}.
//
// All but set_instance route through formatMutationResult: null → failure text,
// {error} → an error, otherwise JSON.stringify of the plugin reply (warnings
// ride along on success).

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { ScopedFigmaClient } from '../figma-client'
import { splitComponentProperties } from '../serialize/node-spec-reader'
import {
  type ToolResult,
  formatMutationResult,
  toolError,
  pluginError,
  errorEnvelope,
  textResult,
} from './shared'

export const handleCreateComponent = async (
  {
    nodeId,
    name,
    description,
  }: {
    nodeId: string
    name?: string
    description?: string
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const result = (await client.sendCommand(
      COMMANDS.CREATE_COMPONENT,
      { nodeId, name, description },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to create component.',
    )
  } catch (err) {
    return toolError(err)
  }
}

export const handleUpdateComponent = async (
  {
    componentId,
    add,
    edit,
    delete: del,
    description,
    expose,
    slots,
  }: {
    componentId: string
    add?: {
      name: string
      type: string
      defaultValue: string | boolean
      targetNodeId?: string
      field?: 'characters' | 'visible' | 'mainComponent'
    }[]
    edit?: {
      name: string
      newName?: string
      defaultValue?: string | boolean
    }[]
    delete?: string[]
    description?: string
    expose?: string[]
    slots?: string[]
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const result = (await client.sendCommand(
      COMMANDS.UPDATE_COMPONENT,
      {
        componentId,
        add,
        edit,
        delete: del,
        description,
        expose,
        slots,
      },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to update component.',
    )
  } catch (err) {
    return toolError(err)
  }
}

export const handleCombineVariants = async (
  {
    componentIds,
    parentId,
    name,
  }: {
    componentIds: string[]
    parentId?: string
    name?: string
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  if (componentIds.length < 2) {
    return errorEnvelope(
      'INVALID_PARAM',
      'combine_variants requires at least 2 components.',
    )
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.COMBINE_VARIANTS,
      { componentIds, parentId, name },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to combine variants.',
    )
  } catch (err) {
    return toolError(err)
  }
}

export const handleSwapComponent = async (
  {
    instanceId,
    mainComponentId,
    key,
  }: {
    instanceId: string
    mainComponentId?: string
    key?: string
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  // Remote-capable: at least one target source is required. If BOTH are given
  // the LOCAL mainComponentId WINS (no async import needed); the plugin resolves
  // `key` via importComponentByKeyAsync only when mainComponentId is absent.
  if (mainComponentId === undefined && key === undefined) {
    return errorEnvelope(
      'INVALID_PARAM',
      'swap_component requires mainComponentId (local) or key (remote).',
    )
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SWAP_COMPONENT,
      { instanceId, mainComponentId, key },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to swap component.',
    )
  } catch (err) {
    return toolError(err)
  }
}

export const handleSetInstance = async (
  {
    instanceId,
    properties,
    overrides,
  }: {
    instanceId: string
    properties?: Record<string, string | boolean>
    overrides?: {
      path: string
      field: string
      value: string
    }[]
  },
  client: ScopedFigmaClient,
): Promise<ToolResult> => {
  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_INSTANCE,
      { instanceId, properties, overrides },
    )) as {
      id?: string
      componentProperties?: Record<
        string,
        { type: string; value: string | boolean }
      >
      warnings?: string[]
      error?: string
    } | null

    if (result === null) {
      return errorEnvelope(
        'PLUGIN_ERROR',
        'Failed to set instance.',
      )
    }
    if (result.error !== undefined) {
      return pluginError(result.error)
    }

    // T2: split the plugin's RAW Figma componentProperties echo
    // ({ [name]:{type,value} }) into the SAME { variantProperties?,
    // componentProperties? } shape get_node / get_components emit, so the write
    // echo round-trips its READ twin exactly.
    const split = splitComponentProperties(
      result.componentProperties,
    )
    const echo: Record<string, unknown> = {
      id: result.id,
      ...split,
      warnings: result.warnings ?? [],
    }
    return textResult(JSON.stringify(echo))
  } catch (err) {
    return toolError(err)
  }
}
