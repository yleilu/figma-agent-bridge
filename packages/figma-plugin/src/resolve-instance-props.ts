// Resolves friendly component-property NAMES to the EXACT keys that
// instance.setProperties requires. Figma's setProperties is strict:
//   - TEXT / BOOLEAN / INSTANCE_SWAP props are keyed by "<name>#<id>"
//     (e.g. "Label#1:0").
//   - VARIANT props are keyed by the BARE property name (no "#id" suffix).
// Passing a friendly name like "Label" where Figma expects "Label#1:0" fails
// with "Could not find a component property…". This module bridges that gap so
// set_instance and create_node INSTANCE can accept friendly names.
//
// Like project-component-defs.ts, this is a PURE helper declared structurally
// (no `figma` global) so it is independently unit-testable. The caller supplies
// the instance's current property keys via Object.keys(componentProperties).
//
// Resolution per input key P:
//   - P is EXACTLY one of currentKeys → keep as-is (exact key, or VARIANT
//     bare-name path).
//   - else match keys K whose NAME segment (K before "#") equals P EXACTLY
//     (so "Icon" matches "Icon#1:0" but NOT "IconColor#2:0"):
//       · exactly one match → use that key.
//       · multiple matches  → warn (ambiguous; pass the exact key) and skip.
//       · no match          → warn (no such property) and skip.
// Only successfully-resolved keys appear in `resolved`.

export type InstancePropInput = Record<string, string | boolean>

export type ResolveInstancePropsResult = {
  resolved: Record<string, string | boolean>
  warnings: string[]
}

const nameSegment = (key: string): string => {
  const hashIdx = key.indexOf('#')
  return hashIdx >= 0 ? key.slice(0, hashIdx) : key
}

export const resolveInstanceProps = (
  input: InstancePropInput,
  currentKeys: string[],
): ResolveInstancePropsResult => {
  const resolved: Record<string, string | boolean> = {}
  const warnings: string[] = []

  for (const inputKey of Object.keys(input)) {
    // Exact key (TEXT/BOOLEAN/INSTANCE_SWAP) or VARIANT bare name → keep as-is.
    if (currentKeys.includes(inputKey)) {
      resolved[inputKey] = input[inputKey]
      continue
    }

    // Otherwise resolve by exact NAME-segment equality (not startsWith), so
    // "Icon" does not falsely match "IconColor#2:0".
    const matches = currentKeys.filter(
      key => nameSegment(key) === inputKey,
    )

    if (matches.length === 1) {
      resolved[matches[0]] = input[inputKey]
    } else if (matches.length > 1) {
      warnings.push(
        "ambiguous property name '" +
          inputKey +
          "' — matches " +
          matches.join(', ') +
          '; pass the exact key',
      )
    } else {
      warnings.push(
        "no component property named '" + inputKey + "'",
      )
    }
  }

  return { resolved, warnings }
}
