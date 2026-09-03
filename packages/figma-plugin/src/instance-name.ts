// instance-name.ts — a swap must not leave the layer tree naming a variant the
// instance no longer holds (I91).
//
// THE LIVE FINDING (2026-09-03, found independently by two reviewers). Six
// instances on one build carried a name contradicting their own variant:
//
//   `Status chip/Confirmed`   holding Tone=Warning,  rendering PENDING
//   `Status chip/Active` ×2   rendering PAUSED and FLAGGED
//   `Chain pill/Ethereum` ×3  rendering OPTIMISM, OPTIMISM and BASE
//
// Text, paint and `variantProperties` were all correct. ONLY THE NAME LIED. The
// build made 21 `swap_component` calls, and Figma keeps a layer's name across a
// swap — correctly, because a name may be the author's own. What is missing is
// the discrimination: a name the CALLER wrote ("Primary CTA") is a deliberate
// choice and must survive; a name DERIVED from the old variant is a stale fact
// about a component this instance no longer has.
//
// Naming legibility is a scored dimension of the reviewer skill, and a lying
// layer name is exactly what that dimension exists to catch. The tool that
// created the lie has to answer for it.
//
// SO THE OLD NAME IS MATCHED AGAINST THE TEMPLATES A DERIVED NAME CAN TAKE, and
// only a match is rewritten — through the SAME template, off the new variant.
// The templates are read off the components themselves rather than off a Figma
// API: a variant component is named `Prop=Value` (and `Prop=Value, Prop2=Value`
// for two axes), which is Figma's own spelling and needs no call to confirm.
//
// A template that would produce the SAME name is not a rename. Two variants of
// one set share their set's name, so an instance called just `Status chip` says
// nothing false and is left exactly as it is.
//
// Structural on both sides, so it is testable without a Figma runtime.

/** As much of a main component as a derived name is built from. */
export type MainDescriptor = {
  /** The component's own name — `Tone=Confirmed` for a variant. */
  name: string
  /** Its COMPONENT_SET's name, when it belongs to one. */
  setName?: string
}

/**
 * The VALUES in a variant component's name, in axis order, or undefined.
 *
 * `Tone=Confirmed` → `['Confirmed']`; `Chain=Optimism, Size=Small` →
 * `['Optimism', 'Small']`. A name with no `=` in it is not a variant name and
 * answers undefined rather than a guess.
 */
export const variantValuesOf = (
  name: string,
): string[] | undefined => {
  if (!name.includes('=')) return undefined
  const values = name
    .split(',')
    .map(part => part.trim())
    .map(part => {
      const at = part.indexOf('=')
      return at < 0 ? undefined : part.slice(at + 1).trim()
    })
  return values.every(v => v !== undefined && v.length > 0)
    ? (values as string[])
    : undefined
}

/**
 * Every spelling a DERIVED instance name takes, in the order they are tried.
 *
 * Longest and most specific first: `Status chip/Confirmed` and
 * `Status chip/Tone=Confirmed` both begin with the set name, so a shorter
 * template tested first would claim a name the longer one owns.
 *
 * The bare SET NAME is deliberately absent. It is identical for every variant
 * of one set, so it can never be stale, and rewriting it would be a write that
 * changes nothing.
 */
const templates: ((m: MainDescriptor) => string | undefined)[] =
  [
    m => {
      const values = variantValuesOf(m.name)
      return m.setName !== undefined && values !== undefined
        ? m.setName + '/' + values.join('/')
        : undefined
    },
    m =>
      m.setName !== undefined
        ? m.setName + '/' + m.name
        : undefined,
    m => m.name,
    m => variantValuesOf(m.name)?.join('/'),
  ]

/**
 * The name to give the instance after a swap, or undefined to leave it.
 *
 * `undefined` covers three different silences, and they are all the same
 * answer to the caller: the name was the author's own, the name would not
 * change, or a main could not be read. In every one of them the honest move is
 * to touch nothing — a rename this module cannot justify is a rename it must
 * not make.
 */
export const renameOnSwap = ({
  before,
  from,
  to,
}: {
  before: string
  from: MainDescriptor | undefined
  to: MainDescriptor | undefined
}): string | undefined => {
  if (from === undefined || to === undefined) return undefined
  for (const template of templates) {
    const was = template(from)
    if (was === undefined || was !== before) continue
    const next = template(to)
    return next === undefined || next === before
      ? undefined
      : next
  }
  return undefined
}

/**
 * What the reply says about a name the swap re-derived.
 *
 * A rename is a write the caller did not ask for, so it is declared — the same
 * rule every creation default on this surface follows. Exported so the message
 * has ONE author (the `exportBudgetMessage` rule, resolve-node.ts).
 */
export const swapRenameMessage = (
  before: string,
  after: string,
): string =>
  'swap_component: renamed the instance "' +
  before +
  '" → "' +
  after +
  '", because its old name was derived from the component it no longer holds. ' +
  'A layer name that contradicts its variant makes the layer tree lie about ' +
  'the design. A name you authored yourself is never rewritten.'
