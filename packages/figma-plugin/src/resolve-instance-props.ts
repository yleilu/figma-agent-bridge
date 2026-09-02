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

/** One entry of `instance.componentProperties`, as much as the check reads. */
export type AppliedProperty = { value?: unknown }

/**
 * The property keys a `setProperties` asked for and the instance does NOT read
 * back (B81).
 *
 * The write face no longer refuses a handle whose ancestry will not read — it
 * attempts the write. So the write has to prove itself, and the proof is the
 * same handle answering with the value that was asked for.
 *
 * `undefined` for the read-back means the handle would not describe itself
 * afterwards. That is "could not verify", which is not "did not land", and the
 * two must not be spelled the same: naming a no-op nobody can see is the exact
 * mirror of acking a write nobody can see. The caller says so in its own words
 * instead.
 */
export const propertiesNotLanded = (
  asked: Record<string, string | boolean>,
  after: Record<string, AppliedProperty> | undefined,
): string[] => {
  if (after === undefined) return []
  return Object.keys(asked).filter(
    key => after[key]?.value !== asked[key],
  )
}

/**
 * What the reply says about a property write that did not take.
 *
 * Exported so the message has ONE author — the `exportBudgetMessage` rule
 * (resolve-node.ts).
 */
export const propertiesNotAppliedMessage = (
  missed: readonly string[],
): string =>
  'set_instance: ' +
  missed.join(', ') +
  ' read back unchanged after setProperties, so ' +
  (missed.length > 1 ? 'those writes' : 'that write') +
  ' did not land. Inside a slot subtree Figma can compose this instance’s ' +
  'address from a pre-append id and silently drop the change; reparent the ' +
  'subtree out of the slot, write there, and reparent it back.'
