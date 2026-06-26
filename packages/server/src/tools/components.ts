// tools/components.ts — M3-B write tools for components & instances.
//
// create_component (REBUILD on NodeSpec): supply EXACTLY ONE source — `nodeId`
//   (promote an existing node via createComponentFromNode) OR `spec` (a NodeSpec
//   built first via the create path, then componentized). The handler validates
//   the XOR (validation-in-handler convention, not schema). When building from
//   spec, the spec is converted on the grammar WRITE FACE via
//   specToFigmaForCreate (atom leaves parsed) with children stripped (single
//   node). → COMMANDS.CREATE_COMPONENT → {id,key,name,type}.
// update_component: add/edit/delete componentPropertyDefinitions, set the
//   description, expose nested instances (T7-gated). → COMMANDS.UPDATE_COMPONENT
//   → {id,properties,warnings} where `properties` is the catalogue ARRAY of
//   {id,name,type,defaultValue,variantOptions?} (round-trips get_components; each
//   entry's `id` is the canonical property id added properties need).
// combine_variants: combine ≥2 components into a variant set (handler-guarded
//   <2). → COMMANDS.COMBINE_VARIANTS → {id,name,type,variantAxes}.
// swap_component: point an instance at a different main component (T7-gated swap
//   failures degrade). → COMMANDS.SWAP_COMPONENT → {id,mainComponent,warnings}.
// set_instance: set instance properties via setProperties and/or apply per-node
//   overrides (overrides degrade — not yet applied). → COMMANDS.SET_INSTANCE →
//   {id,componentProperties,warnings}.
//
// All route through formatMutationResult: null → failure text, {error} → an
// error, otherwise JSON.stringify of the plugin reply (warnings ride along on
// success).

import { COMMANDS } from '@figma-agent-bridge/shared'
import type { NodeSpec } from '@figma-agent-bridge/shared/node-spec'
import type { FigmaClient } from '../figma-client'
import { specToFigmaForCreate } from '../serialize/node-spec-writer'
import {
  type ToolResult,
  requireConnected,
  formatMutationResult,
  errorMessage,
  textResult,
} from './shared'

export const handleCreateComponent = async (
  {
    nodeId,
    spec,
    parentId,
    name,
    description,
  }: {
    nodeId?: string
    spec?: NodeSpec
    parentId?: string
    name?: string
    description?: string
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  // Validation-in-handler (XOR): exactly one of nodeId / spec. (See commit
  // 39832e0 — createComponent validation lives in the handler, not the schema.)
  const hasNode = nodeId !== undefined
  const hasSpec = spec !== undefined
  if (hasNode === hasSpec) {
    return textResult(
      'Error: Provide exactly one of nodeId or spec.',
    )
  }

  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const warnings: string[] = []
    let payload: Record<string, unknown>
    if (spec !== undefined) {
      // Build from a single NodeSpec, then componentize — strip children
      // (create path is single-node) and convert atom leaves on the write face.
      // The writer pushes lossy-conversion notes (e.g. per-side stroke collapse)
      // onto `warnings`.
      const flat: NodeSpec = { ...spec }
      delete flat.children
      const convertedSpec = specToFigmaForCreate(
        flat,
        warnings,
      )
      payload = {
        spec: convertedSpec,
        nodeId,
        parentId,
        name,
        description,
      }
    } else {
      payload = { nodeId, name, description }
    }

    const result = (await client.sendCommand(
      COMMANDS.CREATE_COMPONENT,
      payload,
    )) as { error?: string } | null
    const mutation = formatMutationResult(
      result,
      'Failed to create component.',
    )
    if (
      warnings.length === 0 ||
      mutation.content[0].text.startsWith('Error')
    ) {
      return mutation
    }
    const warningText = warnings
      .map(w => `Warning: ${w}`)
      .join('\n')
    return textResult(
      `${mutation.content[0].text}\n\n${warningText}`,
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
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
  }: {
    componentId: string
    add?: {
      name: string
      type: string
      defaultValue: string | boolean
    }[]
    edit?: {
      name: string
      newName?: string
      defaultValue?: string | boolean
    }[]
    delete?: string[]
    description?: string
    expose?: string[]
  },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

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
      },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to update component.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  if (componentIds.length < 2) {
    return textResult(
      'Error: combine_variants requires at least 2 components.',
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
    return textResult(`Error: ${errorMessage(err)}`)
  }
}

export const handleSwapComponent = async (
  {
    instanceId,
    mainComponentId,
  }: { instanceId: string; mainComponentId: string },
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SWAP_COMPONENT,
      { instanceId, mainComponentId },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to swap component.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
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
  client: FigmaClient,
): Promise<ToolResult> => {
  const guard = requireConnected(client)
  if (guard) {
    return guard
  }

  try {
    const result = (await client.sendCommand(
      COMMANDS.SET_INSTANCE,
      { instanceId, properties, overrides },
    )) as { error?: string } | null
    return formatMutationResult(
      result,
      'Failed to set instance.',
    )
  } catch (err) {
    return textResult(`Error: ${errorMessage(err)}`)
  }
}
