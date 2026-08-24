// bind-wrappers.ts — establish the binding an inline var()/style() wrapper
// names, once the literal has landed.
//
// A read emits `var(surface/2)#141B2E`; writing that atom back applies the
// paint AND re-binds it (expression-formats.md — "var() / style() rules").
// The server carries the NAME across the wire as `spec.bindings[]`; this
// module is the write end of that contract, and it is deliberately the SAME
// code the `bind_variable` / `apply_style` handlers run — those handlers call
// `bindPaintField` / `bindNodeField` / `applyStyleField` too, so an inline
// binding and an explicit one cannot drift apart or degrade differently.
//
// Every function here degrades (T7): a name that resolves to nothing, a field
// the node cannot bind, an API this Figma version lacks — each pushes ONE
// warning and returns. The literal is already on the node; a missing binding
// must never cost the write.
//
// Structural target types (same shape as apply-node-fields.ts / apply-layout.ts)
// keep the module free of the Figma runtime, so it is unit-testable with a
// plain fake node.

/** A node as far as binding is concerned: a type name plus loose fields. */
export type BindTargetNode = {
  type: string
  [key: string]: unknown
}

/** One binding the converted payload asks for (server: wrapper-bindings.ts). */
export type WrapperBinding = {
  kind: 'var' | 'style'
  name: string
  /** The plugin-side field: bind_variable's for `var`, apply_style's for `style`. */
  field: string
  /** Paint slot for an array field; absent means every paint in the array. */
  index?: number
}

/** The apply_style field vocabulary. */
export type StyleField =
  | 'fill'
  | 'stroke'
  | 'text'
  | 'effect'
  | 'grid'

/** The local-style category each style field resolves against. */
export type StyleCategory =
  | 'paint'
  | 'text'
  | 'effect'
  | 'grid'

/** apply_style: field → the async setter that applies it. */
export const STYLE_SETTERS: Record<StyleField, string> = {
  fill: 'setFillStyleIdAsync',
  stroke: 'setStrokeStyleIdAsync',
  text: 'setTextStyleIdAsync',
  effect: 'setEffectStyleIdAsync',
  grid: 'setGridStyleIdAsync',
}

/** apply_style: field → the style TYPE it accepts (category guard). */
export const STYLE_TYPES: Record<StyleField, string> = {
  fill: 'PAINT',
  stroke: 'PAINT',
  text: 'TEXT',
  effect: 'EFFECT',
  grid: 'GRID',
}

/** apply_style field → the local-style lister that can resolve a NAME. */
export const STYLE_CATEGORIES: Record<
  StyleField,
  StyleCategory
> = {
  fill: 'paint',
  stroke: 'paint',
  text: 'text',
  effect: 'effect',
  grid: 'grid',
}

/** The paint-array fields that bind per paint rather than per node field. */
const PAINT_FIELDS = new Set(['fills', 'strokes'])

export type PaintBindDeps = {
  /**
   * figma.variables.setBoundVariableForPaint — feature-detected (T7): paint
   * fields are not VariableBindableNodeFields, so they bind through this and
   * the array is re-assigned.
   */
  setBoundVariableForPaint?: (
    paint: unknown,
    field: 'color',
    variable: unknown,
  ) => unknown
  /** figma.mixed — a paint array can be `mixed` on a multi-style text node. */
  mixed: unknown
}

const isSolid = (paint: unknown): boolean =>
  (paint as { type?: string } | null)?.type === 'SOLID'

/**
 * Bind a variable to `fills` / `strokes`.
 *
 * `index` names ONE paint (an inline `var()` sits on the paint it wraps);
 * omitting it binds every SOLID paint in the array — the shape the
 * `bind_variable` tool has always had.
 */
export const bindPaintField = (
  node: BindTargetNode,
  field: 'fills' | 'strokes',
  variable: unknown,
  deps: PaintBindDeps,
  warnings: string[],
  index?: number,
): void => {
  if (!(field in node)) {
    warnings.push(
      'field "' +
        field +
        '" is not bindable on ' +
        node.type,
    )
    return
  }
  const setForPaint = deps.setBoundVariableForPaint
  if (typeof setForPaint !== 'function') {
    warnings.push(
      'setBoundVariableForPaint unavailable in this Figma version; paint binding skipped',
    )
    return
  }
  const current = node[field]
  if (current === deps.mixed || !Array.isArray(current)) {
    warnings.push(
      field +
        ' has no bindable paints on ' +
        node.type +
        '; paint binding skipped',
    )
    return
  }
  const paints = current as unknown[]
  if (
    index !== undefined &&
    !isSolid(paints[index] ?? null)
  ) {
    // The slot the wrapper named is gone or is not a solid paint — say so
    // rather than binding nothing and reporting success.
    warnings.push(
      field +
        '[' +
        index +
        '] has no bindable paint on ' +
        node.type +
        '; paint binding skipped',
    )
    return
  }
  try {
    node[field] = paints.map((paint, i) =>
      (index === undefined || i === index) && isSolid(paint)
        ? setForPaint(paint, 'color', variable)
        : paint,
    )
  } catch (e) {
    warnings.push(
      'binding ' +
        field +
        ' on ' +
        node.type +
        ' failed: ' +
        String(e),
    )
  }
}

/** Bind a variable to a scalar node field (the VariableBindableNodeField route). */
/**
 * REMOVE the variable binding on a scalar node field, leaving the literal value
 * where it is (B58).
 *
 * Writing a literal over a bound field does not unbind it — a token-bound gap
 * given `{gap: 16}` keeps reading `var(space/16)16` — so there has to be a way
 * to say "no token here" that is not a write of a value. Figma spells it
 * `setBoundVariable(field, null)`; this is the only caller of that spelling, and
 * it degrades like every other binding route (T7) rather than throwing.
 *
 * Scalar fields only. `fills`/`strokes` bind per PAINT and are refused by the
 * caller, which can say something more useful about them.
 */
export const clearNodeField = (
  node: BindTargetNode,
  field: string,
  warnings: string[],
): void => {
  const bindable = node as {
    setBoundVariable?: (f: string, v: unknown) => void
  }
  if (typeof bindable.setBoundVariable !== 'function') {
    warnings.push(
      'setBoundVariable unavailable in this Figma version; binding not cleared',
    )
    return
  }
  try {
    bindable.setBoundVariable(field, null)
  } catch (e) {
    warnings.push(
      'could not clear the variable binding on "' +
        field +
        '": ' +
        String(e),
    )
  }
}

export const bindNodeField = (
  node: BindTargetNode,
  field: string,
  variable: unknown,
  warnings: string[],
): void => {
  const bindable = node as {
    setBoundVariable?: (f: string, v: unknown) => void
  }
  // Feature-detect/warn (T7): degrade, never throw.
  if (typeof bindable.setBoundVariable !== 'function') {
    warnings.push(
      'setBoundVariable unavailable in this Figma version; binding skipped',
    )
    return
  }
  try {
    bindable.setBoundVariable(field, variable)
  } catch (e) {
    warnings.push(
      'field "' +
        field +
        '" is not bindable on ' +
        node.type +
        ': ' +
        String(e),
    )
  }
}

/** Apply a style id to a node field through the matching async setter. */
export const applyStyleField = async (
  node: BindTargetNode,
  field: StyleField,
  styleId: string,
  warnings: string[],
): Promise<void> => {
  const setterName = STYLE_SETTERS[field]
  const styled = node as unknown as Record<
    string,
    (id: string) => Promise<void>
  >
  if (typeof styled[setterName] !== 'function') {
    warnings.push(
      setterName +
        ' unavailable on ' +
        node.type +
        '; style not applied',
    )
    return
  }
  try {
    await styled[setterName](styleId)
  } catch (e) {
    warnings.push(
      field +
        ' style not applicable on ' +
        node.type +
        ': ' +
        String(e),
    )
  }
}

export type WrapperBindDeps = PaintBindDeps & {
  /** Resolve a variable by NAME (never by id — ids are not accepted inline). */
  variableByName: (
    name: string,
  ) => Promise<{ id: string } | null>
  /** Resolve a LOCAL style by name within one category. */
  styleByName: (
    name: string,
    category: StyleCategory,
  ) => Promise<{ id: string } | null>
}

/**
 * Apply every binding a converted payload carries, in order.
 *
 * Called from both write paths — `buildSingleNode` (create_node / create_tree)
 * and the `update_node` handler — AFTER the literal properties are applied, so
 * the binding always lands on a node that already looks right.
 */
export const applyWrapperBindings = async (
  node: BindTargetNode,
  bindings: unknown,
  deps: WrapperBindDeps,
  warnings: string[],
): Promise<void> => {
  if (!Array.isArray(bindings)) {
    return
  }
  for (const binding of bindings as WrapperBinding[]) {
    if (binding?.kind === 'var') {
      await applyVarBinding(node, binding, deps, warnings)
    } else if (binding?.kind === 'style') {
      await applyStyleBinding(node, binding, deps, warnings)
    }
  }
}

/**
 * Run one core and attribute whatever it degraded to the WRAPPER that asked.
 *
 * The cores are shared with `bind_variable` / `apply_style`, where the caller
 * already knows which field it asked about; inline, a node can carry several
 * wrappers, so a bare "field \"fills\" is not bindable on SLICE" would leave
 * the agent guessing which token it lost. The prefix is added here, at the call
 * site, rather than teaching the cores a second wording.
 */
const attributed = async (
  label: string,
  warnings: string[],
  run: (sink: string[]) => void | Promise<void>,
): Promise<void> => {
  const sink: string[] = []
  await run(sink)
  for (const message of sink) {
    warnings.push(label + ': ' + message)
  }
}

const applyVarBinding = async (
  node: BindTargetNode,
  binding: WrapperBinding,
  deps: WrapperBindDeps,
  warnings: string[],
): Promise<void> => {
  const label = 'var(' + binding.name + ')'
  let variable: { id: string } | null = null
  try {
    variable = await deps.variableByName(binding.name)
  } catch (e) {
    warnings.push(
      label +
        ': variable lookup failed: ' +
        String(e) +
        ' — literal applied unbound',
    )
    return
  }
  if (variable === null || variable === undefined) {
    warnings.push(
      label +
        ': no variable with that name — literal applied unbound',
    )
    return
  }
  const resolved = variable
  if (PAINT_FIELDS.has(binding.field)) {
    await attributed(label, warnings, sink =>
      bindPaintField(
        node,
        binding.field as 'fills' | 'strokes',
        resolved,
        deps,
        sink,
        binding.index,
      ),
    )
    return
  }
  await attributed(label, warnings, sink =>
    bindNodeField(node, binding.field, resolved, sink),
  )
}

const applyStyleBinding = async (
  node: BindTargetNode,
  binding: WrapperBinding,
  deps: WrapperBindDeps,
  warnings: string[],
): Promise<void> => {
  const field = binding.field as StyleField
  const label = 'style(' + binding.name + ')'
  const category = STYLE_CATEGORIES[field]
  if (category === undefined) {
    warnings.push(
      label +
        ': "' +
        binding.field +
        '" is not a style field — literal applied unbound',
    )
    return
  }
  let style: { id: string } | null = null
  try {
    style = await deps.styleByName(binding.name, category)
  } catch (e) {
    warnings.push(
      label +
        ': style lookup failed: ' +
        String(e) +
        ' — literal applied unbound',
    )
    return
  }
  if (style === null || style === undefined) {
    warnings.push(
      label +
        ': no ' +
        category +
        ' style with that name — literal applied unbound',
    )
    return
  }
  const styleId = style.id
  await attributed(label, warnings, sink =>
    applyStyleField(node, field, styleId, sink),
  )
}

// ─── name lookups ─────────────────────────────────────────────────────────────

type Named = { id: string; name: string }

export type BindingLookupLoaders = {
  /** figma.variables.getLocalVariablesAsync (absent ⇒ unavailable). */
  listVariables?: () => Promise<Named[]>
  /** figma.getLocalPaintStylesAsync & friends, by category. */
  listStyles?: Partial<
    Record<StyleCategory, () => Promise<Named[]>>
  >
}

/**
 * Name → variable / style lookups for one command dispatch.
 *
 * A binding names a token, and only an enumeration turns a name into the
 * object Figma binds — so the enumeration is cached: a 100-node create_tree
 * that reuses eight tokens (the house style, T9) pays for one scan, not one
 * per node.
 *
 * One scan per dispatch is also all that is CORRECT to do: `reset()` runs at
 * the top of every command dispatch (a batch re-dispatches per op), and nothing
 * inside a single dispatch creates variables or styles — so the table cannot
 * change under a scan, and a miss is a miss. Re-reading on one would cost a
 * document-wide scan per bogus name; the miss is remembered instead.
 */
export const createBindingLookups = (
  loaders: BindingLookupLoaders,
) => {
  let variables: Map<string, Named> | null = null
  const styles = new Map<
    StyleCategory,
    Map<string, Named>
  >()

  const loadVariables = async (): Promise<
    Map<string, Named>
  > => {
    const list = loaders.listVariables
    if (typeof list !== 'function') {
      throw new Error(
        'getLocalVariablesAsync unavailable in this Figma version',
      )
    }
    const byName = new Map<string, Named>()
    for (const v of await list()) {
      // First wins: two variables can share a name across collections, and a
      // later one must not silently replace the one already answered.
      if (!byName.has(v.name)) {
        byName.set(v.name, v)
      }
    }
    return byName
  }

  const variableByName = async (
    name: string,
  ): Promise<Named | null> => {
    if (variables === null) {
      variables = await loadVariables()
    }
    return variables.get(name) ?? null
  }

  const loadStyles = async (
    category: StyleCategory,
  ): Promise<Map<string, Named>> => {
    const list = loaders.listStyles?.[category]
    if (typeof list !== 'function') {
      throw new Error(
        'local ' +
          category +
          ' styles unavailable in this Figma version',
      )
    }
    const byName = new Map<string, Named>()
    for (const s of await list()) {
      if (!byName.has(s.name)) {
        byName.set(s.name, s)
      }
    }
    return byName
  }

  const styleByName = async (
    name: string,
    category: StyleCategory,
  ): Promise<Named | null> => {
    let byName = styles.get(category)
    if (byName === undefined) {
      byName = await loadStyles(category)
      styles.set(category, byName)
    }
    return byName.get(name) ?? null
  }

  const reset = (): void => {
    variables = null
    styles.clear()
  }

  return { variableByName, styleByName, reset }
}
