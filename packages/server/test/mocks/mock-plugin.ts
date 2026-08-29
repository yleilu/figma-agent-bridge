import type {
  BroadcastMessage,
  ChannelMessage,
  CommandMessage,
  JoinMessage,
  RegisterMessage,
  SystemMessage,
} from '@figma-agent-bridge/shared/types'
import {
  APP_VERSION,
  COMMANDS,
  isTargetMismatch,
  targetGuardError,
} from '@figma-agent-bridge/shared'
import cardFixture from '../fixtures/card-node-raw.json'
import slotDeepFixture from '../fixtures/slot-deep-raw.json'

const MOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>'

const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// FAITHFUL mirror of the figma-plugin resolveInstanceProps helper (#11): the
// real plugin resolves friendly component-property NAMES to the EXACT keys
// setProperties requires (TEXT/BOOLEAN/INSTANCE_SWAP → "<name>#<id>"; VARIANT →
// bare name) against the instance's current keys, warning + skipping ambiguous
// or unknown names. The mock inlines the same logic (it cannot import across
// packages) keeping the wording byte-faithful so behavioral tests assert the
// real plugin contract. Default current-keys for a modeled instance: VARIANT
// "Size" + BOOLEAN "Disabled" pass through bare/exact as today's tests expect;
// "Label#1:0" lets a friendly "Label" resolve; "Icon#1:0"/"IconColor#2:0"
// exercise the exact name-segment match (Icon != IconColor).
const MOCK_INSTANCE_KEYS = [
  'Size',
  'Disabled',
  'Label#1:0',
  'Icon#1:0',
  'IconColor#2:0',
]

const mockResolveInstanceProps = (
  input: Record<string, string | boolean>,
  currentKeys: string[],
): {
  resolved: Record<string, string | boolean>
  warnings: string[]
} => {
  const resolved: Record<string, string | boolean> = {}
  const warnings: string[] = []
  const nameSegment = (key: string): string => {
    const i = key.indexOf('#')
    return i >= 0 ? key.slice(0, i) : key
  }
  for (const inputKey of Object.keys(input)) {
    if (currentKeys.includes(inputKey)) {
      resolved[inputKey] = input[inputKey]
      continue
    }
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

// FAITHFUL mirror of the figma-plugin bind-wrappers helper (I39): a converted
// spec carries `bindings[]` — the NAME each inline var()/style() wrapper named —
// and the plugin resolves each name against the document AFTER the literal has
// landed, degrading an unresolvable name to ONE warning (never an abort). The
// mock resolves against its own document fixtures (the get_variables /
// get_styles cases below) and keeps the warning wording byte-faithful, so a
// behavioural test asserts the real plugin's contract.
// Both names this mock document defines: the get_variables collection entry,
// and the name the card fixture's bound fill reads back as (bindingNames) —
// which is what makes a read → write round-trip re-bind here.
// `space/8` is a SPACING token: the layout scalars bind too (B44), and a
// design system's spacing variables are exactly what an inline `gap:
// "var(space/8)8"` names.
const MOCK_VARIABLE_NAMES = [
  'Brand/Primary',
  'surface/card-bg',
  'space/8',
]

/**
 * The variable ids this mock document defines, by name — what only the PLUGIN
 * can resolve, and what `bind_variable` is called with.
 *
 * An id that is not here answers itself: a mock-only fallback, so a test that
 * binds an id the document never defined sees that in the read-back rather than
 * a plausible-looking name.
 */
const MOCK_VARIABLE_BY_ID: Record<string, string> = {
  'var:spacing-8': 'space/8',
}

const mockVariableNameById = (
  id: string,
): string | undefined =>
  MOCK_VARIABLE_BY_ID[id] ??
  (id.startsWith('var:mock:')
    ? id.slice('var:mock:'.length)
    : undefined)

/**
 * What a bound NUMBER variable resolves to on a node, by variable name.
 *
 * Binding does not decorate a field — it takes the field over. Figma re-reads
 * the field through the variable, so whatever literal was there is replaced by
 * the variable's value in the node's resolved mode: a live gap of 4 bound to
 * `space/8` reads 8 afterwards (B44's own live note).
 *
 * `space/unset` models the variable this mock exists to make visible (B63): one
 * whose collection has no value for the mode the node resolves in — because
 * `create_variables` was given `valuesByMode` keyed to a mode the collection
 * never had, and said so in a warning. Figma resolves it to the type's zero, so
 * binding it ZEROES the gap. Nothing is broken and nothing warns; the geometry
 * simply moves, which is why the read has to state a zero gap out loud.
 */
const MOCK_VARIABLE_VALUE: Record<string, number> = {
  'space/8': 8,
  'space/16': 16,
  'space/24': 24,
  'space/unset': 0,
}

const mockResolvedNumber = (name: string): number =>
  MOCK_VARIABLE_VALUE[name] ?? 0

/**
 * A gap as JSON_REST_V1 carries it: absent when it is zero.
 *
 * REST spells a default by omission, and zero is the default for every gap. A
 * mock that shipped a literal `itemSpacing: 0` would hand the reader something
 * the real export never sends, and the read's own zero-handling would go
 * untested — which is exactly the gap (B63) that let a zeroed gap look like a
 * gap nobody ever set. `undefined` is dropped by the JSON that crosses the
 * relay, so the key really does disappear.
 */
const restGap = (value: number): number | undefined =>
  value === 0 ? undefined : value

/**
 * The mock document's LOCAL STYLES — one fixture, read by `get_styles`, by the
 * binding resolver above, and by the styled-slot state below, so the mock
 * cannot disagree with itself about what a style holds.
 *
 * `values` is the style's WHOLE content (the real plugin sends every paint /
 * effect / grid), which is what a styled field resolves to; `get_styles` still
 * renders the first entry as `value`. `AB/Blur` holds TWO effects so the
 * always-list read emission and the ride-along differ are exercised against a
 * style that is genuinely a list.
 */
const MOCK_STYLES: Record<
  string,
  {
    id: string
    name: string
    description?: string
    value?: unknown
    values?: unknown[]
  }[]
> = {
  paint: [
    {
      id: 'S:1',
      name: 'Brand/Primary',
      // Surface 2: description surfaces read-only on styles (no context).
      description: 'Brand primary blue',
      values: [
        {
          type: 'SOLID',
          color: { r: 0.231, g: 0.51, b: 0.965 },
        },
      ],
    },
    {
      id: 'S:5',
      name: 'Glass/Fill',
      values: [
        {
          type: 'SOLID',
          color: { r: 0.078, g: 0.106, b: 0.18 },
          opacity: 0.6,
        },
      ],
    },
  ],
  text: [
    {
      id: 'S:2',
      name: 'Heading',
      description: 'Section heading type',
      value: {
        family: 'Inter',
        style: 'Bold',
        size: 32,
        lineHeight: { value: 40, unit: 'PIXELS' },
      },
    },
  ],
  effect: [
    {
      id: 'S:3',
      name: 'Card Shadow',
      values: [
        {
          type: 'DROP_SHADOW',
          color: { r: 0, g: 0, b: 0, a: 0.1 },
          offset: { x: 0, y: 4 },
          radius: 12,
          spread: 0,
        },
      ],
    },
    {
      id: 'S:6',
      name: 'AB/Blur',
      values: [
        { type: 'BACKGROUND_BLUR', radius: 24 },
        {
          type: 'DROP_SHADOW',
          color: { r: 0, g: 0, b: 0, a: 0.4 },
          offset: { x: 0, y: 8 },
          radius: 24,
          spread: 0,
        },
      ],
    },
  ],
  grid: [
    {
      id: 'S:4',
      name: 'Layout/Columns',
      values: [
        {
          pattern: 'COLUMNS',
          count: 12,
          gutterSize: 16,
          sectionSize: 64,
          alignment: 'STRETCH',
        },
      ],
    },
  ],
}

/** The `get_styles` reply shape: `value` (the first entry) plus every entry. */
const mockStyleEntries = (
  category: string,
): Record<string, unknown>[] =>
  MOCK_STYLES[category].map(s => ({
    id: s.id,
    name: s.name,
    value: s.value ?? s.values?.[0],
    ...(s.values ? { values: s.values } : {}),
    ...(s.description
      ? { description: s.description }
      : {}),
  }))

const mockStyleByName = (
  category: string | undefined,
  name: string,
): { values?: unknown[] } | undefined =>
  category === undefined
    ? undefined
    : MOCK_STYLES[category].find(s => s.name === name)

const MOCK_STYLE_CATEGORIES: Record<string, string> = {
  fill: 'paint',
  stroke: 'paint',
  text: 'text',
  effect: 'effect',
  grid: 'grid',
}

type MockBinding = {
  kind: 'var' | 'style'
  name: string
  field: string
  index?: number
}

const mockApplyWrapperBindings = (
  bindings: unknown,
): { applied: MockBinding[]; warnings: string[] } => {
  const applied: MockBinding[] = []
  const warnings: string[] = []
  if (!Array.isArray(bindings)) {
    return { applied, warnings }
  }
  for (const binding of bindings as MockBinding[]) {
    if (binding.kind === 'var') {
      if (!MOCK_VARIABLE_NAMES.includes(binding.name)) {
        warnings.push(
          'var(' +
            binding.name +
            '): no variable with that name — literal applied unbound',
        )
        continue
      }
      applied.push(binding)
      continue
    }
    const category = MOCK_STYLE_CATEGORIES[binding.field]
    if (
      mockStyleByName(category, binding.name) === undefined
    ) {
      warnings.push(
        'style(' +
          binding.name +
          '): no ' +
          (category ?? binding.field) +
          ' style with that name — literal applied unbound',
      )
      continue
    }
    applied.push(binding)
  }
  return { applied, warnings }
}

type MockPluginOptions = {
  relayUrl: string
  channel: string
  documentName?: string
  pageName?: string
  /**
   * Raw exports of the current selection. INSPECT with no nodeId/pageId honors
   * this the way the real plugin does: >1 entry → return the ARRAY (forest);
   * exactly 1 → return that single export; empty/undefined → fall back to the
   * default single-node export (representing the current page).
   */
  selection?: Record<string, unknown>[]
  /**
   * When true, get_components models a document containing a ComponentSet with
   * conflicting variants. The real plugin THROWS ("Component set for node has
   * existing errors") while projecting that set's variant axes; the fixed
   * plugin guards each set individually so the bad set degrades to a warnings[]
   * entry and the good components still return. Byte-faithful to the real
   * plugin's degraded reply shape + message (Bug A).
   */
  componentSetError?: boolean
  /** defaults to APP_VERSION; set to a different value to test mismatch */
  version?: string
  /**
   * The plugin's stable figma.fileKey. Real plugin reads figma.fileKey (with
   * enablePrivatePluginApi) → a real key for a saved file, null/undefined for a
   * never-saved file. Default null = the never-saved-file case (registers null,
   * and the identity guard can't verify — see handleBroadcast).
   */
  fileKey?: string | null
  /**
   * The connection nonce sent on `register` (connection-liveness.md /
   * change-feed.md) — the field the L6 dead-marker keys on. Defaults to a
   * per-instance random value so distinct mock plugins are distinguishable;
   * override to model TWO registers sharing an epoch, or omit-then-differ to
   * model a reconnect.
   */
  epoch?: string
}

type MockPlugin = {
  start: () => Promise<void>
  stop: () => void
  // Timing knobs (L5 — for the L6 watchdog tests only): DEFAULT is unchanged
  // synchronous auto-answer, so every pre-existing mock-based test is
  // unaffected unless a test opts in below.
  //
  // setSilent(true): withhold EVERY reply, including ping — models a fully
  // dead plugin/socket (the watchdog should eventually declare it dead).
  setSilent: (silent: boolean) => void
  // delayCommand(command, ms): defer that command's reply by `ms` via
  // setTimeout, WITHOUT delaying ping — models a slow-but-alive plugin (busy
  // main thread, but the UI iframe's ping-answering event loop stays free),
  // faithful to the real plugin's ping bypass in useRelay.ts.
  delayCommand: (command: string, delayMs: number) => void
  // pings(): count of liveness pings this plugin has RECEIVED (incremented on
  // receipt, before the silent gate). Lets the L6 watchdog tests assert the
  // fast path never armed the watchdog (zero pings).
  pings: () => number
  // holdCommand(command): withhold that command's reply INDEFINITELY, keeping
  // it pending rather than dropping it (setSilent discards forever; delayCommand
  // fires on a timer the test cannot align to an event). Combined with
  // releaseHeld() this makes "the reply lands at this exact moment" testable —
  // the L6 watchdog's mark path awaits a discoverChannels round-trip, a window
  // of a few ms that no timer can reliably hit.
  holdCommand: (command: string) => void
  // releaseHeld(): send every reply held by holdCommand, now. Returns how many
  // were released so a test can assert it actually armed the case it meant to.
  releaseHeld: () => number
}

export const createMockPlugin = (
  options: MockPluginOptions,
): MockPlugin => {
  const {
    relayUrl,
    channel,
    documentName = 'Mock Document',
    pageName = 'Page 1',
    selection,
    componentSetError = false,
    version = APP_VERSION,
    fileKey = null,
    epoch = `epoch:${Math.random().toString(36).slice(2, 8)}`,
  } = options

  let ws: WebSocket | null = null

  // Stateful shared-pluginData store for the agent `context` field, faithful to
  // the real plugin's set/getSharedPluginData semantics: a write of a non-empty
  // string persists; an empty/whitespace string CLEARS the key (Figma treats ''
  // as delete); an omitted value on update PRESERVES the prior value. Keyed by
  // node id, per-plugin-instance so it resets between tests. The reads
  // (get_node/get_nodes/inspect) attach `context` back onto the fixture only
  // when present, and the get_components/get_styles fixtures below carry a raw
  // `description` (+ optional `context`) so the read surfacing is exercised e2e.
  const sharedContext = new Map<string, string>()

  // APPLIED NODE STATE — the fields a write LANDS, so a later read returns what
  // the write changed rather than what the request said. Same shape and
  // lifetime as `sharedContext` above (keyed by node id, per-plugin-instance).
  //
  // Echoing the request payload back into the reply proves only that the server
  // sent it: a plugin that applied nothing at all would look identical. So the
  // fields whose whole point is surviving to the next read are modelled here
  // and merged onto the fixture by `get_node`.
  const appliedState = new Map<
    string,
    Record<string, unknown>
  >()

  /**
   * The card fixture's node with this id — root or any descendant.
   *
   * The real plugin resolves EVERY id in the file, not just the roots a test
   * happens to name, so a multi-id read of `1:43` must answer the Title's own
   * export rather than the card's. `search`'s field hydration (B50) reads back
   * exactly the ids the scan reported, which are these four.
   */
  const fixtureNodeById = (
    id: string,
  ): Record<string, unknown> | undefined => {
    const walk = (
      node: Record<string, unknown>,
    ): Record<string, unknown> | undefined => {
      if (node.id === id) {
        return node
      }
      const kids = node.children
      if (!Array.isArray(kids)) {
        return undefined
      }
      for (const kid of kids as Record<string, unknown>[]) {
        const hit = walk(kid)
        if (hit !== undefined) {
          return hit
        }
      }
      return undefined
    }
    return walk(
      cardFixture as unknown as Record<string, unknown>,
    )
  }

  /**
   * Model the plugin's stroke apply (B27), including what the EXPORT then
   * reports back.
   *
   * `strokeWeights` lands on IndividualStrokesMixin's four sides; the node's
   * own `strokeWeight` is `figma.mixed` once they differ, which is exactly when
   * the plugin's enrichment patches the four flat Plugin-API keys onto the
   * exported node (and only then — equal sides are the uniform field).
   */
  const applyStrokeState = (
    id: string,
    spec: Record<string, unknown>,
  ): void => {
    const state = appliedState.get(id) ?? {}
    if (Array.isArray(spec.strokes)) {
      state.strokes = spec.strokes
    }
    if (typeof spec.strokeWeight === 'number') {
      state.strokeWeight = spec.strokeWeight
      delete state.strokeTopWeight
      delete state.strokeRightWeight
      delete state.strokeBottomWeight
      delete state.strokeLeftWeight
    }
    if (Array.isArray(spec.strokeWeights)) {
      const [top, right, bottom, left] =
        spec.strokeWeights as number[]
      if (right === top && bottom === top && left === top) {
        state.strokeWeight = top
      } else {
        delete state.strokeWeight
        state.strokeTopWeight = top
        state.strokeRightWeight = right
        state.strokeBottomWeight = bottom
        state.strokeLeftWeight = left
      }
    }
    if (Object.keys(state).length > 0) {
      appliedState.set(id, state)
    }
  }

  /**
   * The layout fields Figma binds a variable to, in the Plugin API's spelling —
   * the same list the plugin's enrichment ships across (B44).
   */
  const MOCK_LAYOUT_BIND_FIELDS = new Set([
    'itemSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'gridRowGap',
    'gridColumnGap',
  ])

  /** The three of them REST omits at zero (see `restGap`). */
  const MOCK_GAP_FIELDS = new Set([
    'itemSpacing',
    'gridRowGap',
    'gridColumnGap',
  ])

  /** The export vocabulary for a layout mode the write face states. */
  const MOCK_LAYOUT_MODE: Record<string, string> = {
    H: 'HORIZONTAL',
    V: 'VERTICAL',
    GRID: 'GRID',
    NONE: 'NONE',
  }

  /**
   * Model the layout a write LANDED, in the vocabulary a read consumes.
   *
   * The reply's echo proves only that the server sent the spec; the round-trip
   * that matters is `gap: "var(space/8)8"` written back and read back as the
   * same string, which needs the literal to persist as well as the binding.
   */
  const applyLayoutState = (
    id: string,
    spec: Record<string, unknown>,
  ): void => {
    const layout = spec.layout as
      | Record<string, unknown>
      | undefined
    if (layout === undefined) {
      return
    }
    const state = appliedState.get(id) ?? {}
    if (typeof layout.mode === 'string') {
      state.layoutMode =
        MOCK_LAYOUT_MODE[layout.mode] ?? 'NONE'
    }
    if (typeof layout.spacing === 'number') {
      state.itemSpacing = restGap(layout.spacing)
    }
    if (Array.isArray(layout.padding)) {
      const [pt, pr, pb, pl] = layout.padding as number[]
      state.paddingTop = pt
      state.paddingRight = pr
      state.paddingBottom = pb
      state.paddingLeft = pl
    }
    if (typeof layout.rowGap === 'number') {
      state.gridRowGap = restGap(layout.rowGap)
    }
    if (typeof layout.colGap === 'number') {
      state.gridColumnGap = restGap(layout.colGap)
    }
    appliedState.set(id, state)
  }

  /**
   * Model a LANDED layout binding, the way the file then reports one (B44).
   *
   * JSON_REST_V1 carries no layout binding, so the real plugin's enrichment
   * ships `layoutBoundVariables` (field → variable id) plus the id → name map
   * every wrapper resolves through. Modelling only the reply's
   * `appliedBindings` would leave a read looking exactly as if nothing had been
   * bound — which is precisely the bug: `bind_variable` answered `ok,
   * warnings:[]`, byte-identical to a no-op.
   */
  const applyLayoutBindingState = (
    id: string,
    bound: { field: string; name: string }[],
  ): void => {
    if (bound.length === 0) {
      return
    }
    const state = appliedState.get(id) ?? {}
    const fixtureNames = (fixtureNodeById(id)
      ?.bindingNames ?? {}) as {
      variables?: Record<string, string>
    }
    const names = (state.bindingNames ?? fixtureNames) as {
      variables?: Record<string, string>
    }
    const variables = { ...(names.variables ?? {}) }
    const layoutBound = {
      ...((state.layoutBoundVariables as
        | Record<string, string>
        | undefined) ?? {}),
    }
    for (const entry of bound) {
      const varId = `var:mock:${entry.name}`
      layoutBound[entry.field] = varId
      variables[varId] = entry.name
      // The field now reads THROUGH the variable, so the literal that was
      // there is gone (B63). Modelling only the binding would leave the mock
      // saying a bind is free, which is the one thing the live artifact proved
      // it is not.
      const resolved = mockResolvedNumber(entry.name)
      state[entry.field] = MOCK_GAP_FIELDS.has(entry.field)
        ? restGap(resolved)
        : resolved
    }
    state.layoutBoundVariables = layoutBound
    state.bindingNames = { ...names, variables }
    appliedState.set(id, state)
  }

  /**
   * REMOVE a layout binding — the `clear: true` half of bind_variable (B58).
   *
   * Modelled as state, not echoed, for the same reason the bind is: a reply
   * saying "cleared" proves only that the server sent the flag. The read has to
   * come back without the token, which is what the e2e asserts.
   */
  const clearLayoutBindingState = (
    id: string,
    field: string,
  ): void => {
    const state = appliedState.get(id) ?? {}
    const layoutBound = {
      ...((state.layoutBoundVariables as
        | Record<string, string>
        | undefined) ?? {}),
    }
    delete layoutBound[field]
    state.layoutBoundVariables = layoutBound
    appliedState.set(id, state)
  }

  /** The layout half of a converted spec's `bindings[]`. */
  const layoutBindingsOf = (
    applied: MockBinding[],
  ): { field: string; name: string }[] =>
    applied.filter(
      b =>
        b.kind === 'var' &&
        MOCK_LAYOUT_BIND_FIELDS.has(b.field),
    )

  /**
   * Model an APPLIED style, the way the file then reports it (B47).
   *
   * Figma resolves the style's own content onto the node and records the link,
   * so a styled slot reads back as the REFERENCE — the style named once, with
   * the list it supplies. Modelling only the reply's `appliedBindings` would
   * leave a read looking exactly as if nothing had been applied, which is the
   * one thing a round-trip test has to be able to tell apart.
   */
  const STYLE_SLOT_FIELD: Record<string, string> = {
    fill: 'fills',
    stroke: 'strokes',
    effect: 'effects',
    grid: 'layoutGrids',
  }

  const applyStyleState = (
    id: string,
    applied: MockBinding[],
  ): void => {
    const owning = applied.filter(
      b =>
        b.kind === 'style' &&
        STYLE_SLOT_FIELD[b.field] !== undefined,
    )
    if (owning.length === 0) {
      return
    }
    const state = appliedState.get(id) ?? {}
    const names = (state.bindingNames ?? {}) as {
      styles?: Record<string, string>
    }
    const styles = { ...(names.styles ?? {}) }
    for (const binding of owning) {
      styles[binding.field] = binding.name
      const entry = mockStyleByName(
        MOCK_STYLE_CATEGORIES[binding.field],
        binding.name,
      )
      if (entry?.values !== undefined) {
        state[STYLE_SLOT_FIELD[binding.field]] =
          entry.values
      }
    }
    state.bindingNames = { ...names, styles }
    appliedState.set(id, state)
  }

  // ── ALIAS IDS: content written into a component SLOT (B41) ────────────────
  //
  // Figma does not re-home a node appended into a slot inside an INSTANCE, so
  // `create_node` hands back the id the node had BEFORE the append while the
  // file addresses it by the canonical instance chain. A read of the alias id
  // therefore answers a document rooted at a DIFFERENT id — the behaviour a
  // server must survive, and the reason B41's wrappers used to vanish.
  //
  // A `parentId` prefixed `slotparent:` models such a slot (same convention as
  // `badparent:` above). What the plugin then owes the read is the whole point
  // of the fix: `bindingNames` reaching the DESCENDANT, keyed by the canonical
  // ids the export uses. A CLONE of the same content is minted canonically —
  // the control the sweep used to isolate provenance, and its compound id is
  // reachable by id (live-observed on the sweep's clone).
  //
  // What this deliberately does NOT model: reading the slot content back by the
  // CANONICAL id it reports. Nothing has observed that resolving live. The
  // node answers its alias id to every walk, so the compound-id traversal has
  // no id to match on, and inventing a resolution here would let a test go
  // green on behaviour the real plugin may not have. It is a live question —
  // see probe 2 in the task report.
  const SLOT_ALIAS_ID = 'slot-alias:1'
  const SLOT_CANONICAL_ID = 'I298:7517;298:7516;298:7523'
  const SLOT_CLONE_ID = 'I298:7517;298:7516;298:7530'
  const SLOT_VARIABLE_ID = 'VariableID:261:4751'

  /** The chip's raw export, rooted wherever the caller says. */
  const slotChipExport = (
    rootId: string,
  ): Record<string, unknown> => ({
    id: rootId,
    name: 'Chip',
    type: 'INSTANCE',
    absoluteBoundingBox: {
      x: 0,
      y: 0,
      width: 96,
      height: 28,
    },
    children: [
      {
        id: rootId + ';298:7510',
        name: 'Label',
        type: 'TEXT',
        characters: 'PROBE-SLOT-STRING',
        absoluteBoundingBox: {
          x: 8,
          y: 6,
          width: 80,
          height: 16,
        },
        fills: [
          {
            type: 'SOLID',
            color: { r: 0.13, g: 0.83, b: 0.93, a: 1 },
            boundVariables: {
              color: {
                id: SLOT_VARIABLE_ID,
                type: 'VARIABLE_ALIAS',
              },
            },
          },
        ],
        bindingNames: {
          variables: {
            [SLOT_VARIABLE_ID]: 'probe/cyan',
          },
        },
      },
    ],
  })

  // ── THREE-LEVEL NESTING: instance → SLOT → created subtree (B53) ───────────
  //
  // The fixture above is TWO levels, and B53 is what the third one costs. This
  // one is transcribed from the 2026-08-17 QA run's own saved reply
  // (`readbacks/deep-plot-allocation.json`), so the shapes are observed rather
  // than invented:
  //
  //   305:8637                              INSTANCE  "Chart card"
  //     I305:8637;304:8411                  FRAME     "Header"      master-derived
  //     I305:8637;305:8427                  SLOT      "Plot area"   master-derived
  //       I305:8637;305:8427;305:8881       FRAME     "Plot"        slot-override
  //         I305:8637;305:8427;305:8883     TEXT      "Total value"
  //         I305:8637;305:8427;305:8897     FRAME     "Legend"
  //           I305:8637;305:8427;305:8902   INSTANCE  "Legend row"   handle REFUSES
  //             …;305:8902;304:8234         ELLIPSE   "Dot"
  //             …;305:8902;304:8235         TEXT      "Label"
  //           I305:8637;305:8427;305:8907   INSTANCE  "Legend row"   handle ANSWERS
  //             …;305:8907;304:8239         TEXT      "Label"
  //
  // Three facts the run PROVED, and which this mock therefore models:
  //
  //  1. ONE id vocabulary. The chain grows at an INSTANCE or SLOT boundary, not
  //     per tree level, so Plot and its grandchildren are all 3-segment and only
  //     the nodes inside the slot-hosted INSTANCE are 4-segment. The reading
  //     that called this "two vocabularies" mistook the grammar.
  //  2. At THREE segments the live handle still reads, so the live-only
  //     wrappers survive — `Total value` carries `style(Heading/KPI value)`.
  //  3. A node inside a slot-hosted INSTANCE MAY have a handle composed from the
  //     alias (`I305:8898;304:8235`), which answers nothing. It may equally have
  //     one that answers: the controller's live battery read the SAME node, at
  //     the SAME depth, complete after a reload.
  //
  // FIDELITY IS A PROPERTY OF SESSION STATE, NOT OF ID SHAPE — the same rule the
  // investigation reached for RESOLUTION, and it governs here too. Four segments
  // do not mean a degraded row. A refusing handle does, and the row must say so.
  //
  // The TWO Legend rows model both states, because both are real and the surface
  // has to be honest in each:
  //
  //   `…;305:8902` — its handle refuses, so the read is SLICED out of the
  //                  ancestor export. It carries the export's `var()`, it loses
  //                  `style()` (a live-only field), and it DECLARES that with a
  //                  `readError`. Transcribed from the run's saved reply, and
  //                  kept deliberately: it is the slice path's only regression
  //                  coverage. A live session that behaves BETTER cannot fail
  //                  these assertions — the mock supplies the readError, so the
  //                  test pins the contract, not the weather.
  //   `…;305:8907` — its handle answers, so the walk serves it at FULL fidelity:
  //                  `style(Label/Caption)` present, no `readError`. Modelled
  //                  from the live battery.
  //
  // So a degraded row is not what four segments MEAN. It is what a refusing
  // handle costs, and the row is required to declare it. The `style()` loss on
  // the sliced row is B41's residual: a session-state CONDITION, reachable but
  // not permanent, and NOT fixed here.
  //
  // Every id here resolves, because after B53 the plugin resolves a canonical
  // id through the leading instance's export rather than by matching live ids.
  const deepNodeById = (
    id: string | undefined,
  ): Record<string, unknown> | undefined => {
    if (id === undefined) {
      return undefined
    }
    const walk = (
      node: Record<string, unknown>,
    ): Record<string, unknown> | undefined => {
      if (node.id === id) {
        return node
      }
      const kids = node.children
      if (!Array.isArray(kids)) {
        return undefined
      }
      for (const kid of kids as Record<string, unknown>[]) {
        const hit = walk(kid)
        if (hit !== undefined) {
          return hit
        }
      }
      return undefined
    }
    return walk(
      slotDeepFixture as unknown as Record<string, unknown>,
    )
  }

  /** The deep-slot export a read of `id` serves, with earlier writes merged. */
  const deepExportFor = (
    id: string | undefined,
  ): Record<string, unknown> | undefined => {
    const node = deepNodeById(id)
    if (node === undefined || id === undefined) {
      return undefined
    }
    return {
      ...node,
      ...(appliedState.get(id) ?? {}),
      ...(sharedContext.get(id)
        ? { context: sharedContext.get(id) }
        : {}),
    }
  }

  /** Every node of the deep fixture, root first, with its scan level. */
  const deepScanRows = (): {
    node: Record<string, unknown>
    depth: number
  }[] => {
    const rows: {
      node: Record<string, unknown>
      depth: number
    }[] = []
    const walk = (
      node: Record<string, unknown>,
      depth: number,
    ): void => {
      rows.push({ node, depth })
      const kids = node.children
      if (!Array.isArray(kids)) {
        return
      }
      for (const kid of kids as Record<string, unknown>[]) {
        walk(kid, depth + 1)
      }
    }
    walk(
      slotDeepFixture as unknown as Record<string, unknown>,
      0,
    )
    return rows
  }

  // ── COMPOUND IDS: writing to an instance sublayer ─────────────────────────
  //
  // A node under an instance is addressed `I<instance>;<child>`, and that is the
  // id every read hands back for one. The plugin cannot resolve that shape with
  // a bare `getNodeByIdAsync` — the call reaches for Figma's network. Live
  // 2026-08-17 an `update_node` on `I298:7524;298:7511` answered "Unable to
  // establish connection to Figma after 10 seconds" and then SUCCEEDED on the
  // retry, so the resolve was a coin flip and every compound-id write was
  // flaky under an apply-or-warn contract.
  //
  // What the mock models is the DOCUMENT, not the resolution algorithm: these
  // two sublayers exist under the card fixture's instance, and any other
  // compound id does not. A mutating command therefore APPLIES to a real
  // sublayer and cleanly refuses an invented one — never intermittently, which
  // is the property the fix buys. It cannot exercise the plugin's own
  // traversal (the mock does not run code.ts); the live battery owns that.
  const MOCK_SUBLAYER_IDS = new Set([
    'I1:42;1:7',
    'I1:42;1:8',
  ])

  /**
   * Whether a caller-supplied node id names something in this document.
   *
   * Plain ids stay permissive — the fixture answers for any of them, as it
   * always has. A COMPOUND id is checked, because that is the shape whose
   * resolution was broken.
   */
  const resolvesInMockDoc = (id: string): boolean =>
    !id.startsWith('I') ||
    !id.includes(';') ||
    MOCK_SUBLAYER_IDS.has(id) ||
    // …and every node of the three-level slot fixture below (B53). A write
    // addressed by the id a read emitted has to land, at any depth.
    deepNodeById(id) !== undefined

  /** The slot-hosted export a read of `id` serves, or undefined. */
  const slotExportFor = (
    id: string | undefined,
  ): Record<string, unknown> | undefined => {
    if (id === SLOT_ALIAS_ID) {
      // The alias resolves — to the node under its CANONICAL name.
      return slotChipExport(SLOT_CANONICAL_ID)
    }
    if (id === SLOT_CLONE_ID) {
      return slotChipExport(SLOT_CLONE_ID)
    }
    // SLOT_CANONICAL_ID is deliberately absent — see the note above.
    return undefined
  }

  /**
   * The id every page-addressed read in this mock uses (list_pages / status
   * report the same one).
   */
  const PAGE_ID = 'page:1'

  /**
   * The PAGE document a page-rooted read serves — assembled, not exported.
   *
   * FAITHFUL to the real plugin (B51): `exportAsync` is a SceneNode call, so a
   * page has no export of its own and its read is built from its children. The
   * caller's `depth` is spent on THEM:
   *   depth 0  — each child is a BOUNDARY ROW: id/name/type, its real size, and
   *              how many children it hides. No subtree is serialized, so the
   *              cheap default read stays cheap.
   *   depth ≠0 — each child is exported whole, exactly as a read entered at
   *              that child would be, and the SERVER's depth pass decides what
   *              survives.
   * The page itself carries NO size: Figma does not maintain one, and the mock
   * must not hand the reader a number the file does not hold.
   */
  const pageDocument = (
    depth: number,
  ): Record<string, unknown> => {
    const card = cardFixture as unknown as Record<
      string,
      unknown
    >
    const kids = card.children as
      | Record<string, unknown>[]
      | undefined
    return {
      id: PAGE_ID,
      name: pageName,
      type: 'PAGE',
      children:
        depth === 0
          ? [
              {
                id: card.id,
                name: card.name,
                type: card.type,
                width: 320,
                height: 200,
                childCount: kids?.length ?? 0,
              },
            ]
          : [card],
    }
  }

  // SLOT NODES minted by update_component (B30), keyed by id → the raw export a
  // later get_node serves. Same reasoning as appliedState above: the reply's
  // echo proves only that the server sent the spec, so the slot's LANDED state
  // is modelled here and read back through the ordinary read path.
  const createdSlots = new Map<
    string,
    Record<string, unknown>
  >()

  // COMPONENT PROPERTY DEFINITIONS per component (M22a), keyed by the CANONICAL
  // id the way Figma's `componentPropertyDefinitions` is. Held as state, not
  // echoed, for the same reason as the slots above: add → remove → enumerate
  // only proves anything if the removal is read back from what the document
  // holds. `properties` in the reply is the list AFTER the call, exactly as the
  // real plugin's `projectComponentDefs(comp.componentPropertyDefinitions)` is.
  type MockPropertyDef = {
    id: string
    name: string
    type: string
    defaultValue: string | boolean
  }
  const componentProps = new Map<
    string,
    Map<string, MockPropertyDef>
  >()
  const propsOf = (
    componentId: string,
  ): Map<string, MockPropertyDef> => {
    const found = componentProps.get(componentId)
    if (found !== undefined) {
      return found
    }
    const fresh = new Map<string, MockPropertyDef>()
    componentProps.set(componentId, fresh)
    return fresh
  }
  /** The bare NAME half of a canonical property id — mirrors propertyName(). */
  const barePropName = (key: string): string => {
    const hash = key.lastIndexOf('#')
    return hash > 0 ? key.slice(0, hash) : key
  }

  /**
   * Model `component.createSlot()` plus the apply pipeline the fresh slot then
   * runs (B30).
   *
   * A created slot is born 100×100 FIXED, opaque #FFFFFF, no auto-layout
   * (live-verified — docs/reference/figma-plugin-api.md). The CONVERTED payload
   * is applied on top, in the plugin's own order, and the RESULT is the export
   * a later `get_node` serves — so an e2e asserts what landed, not what was
   * asked for.
   *
   * `autoLayoutParent: false` models a component that is not an auto-layout
   * frame: `layoutSizing* = FILL` on its direct child is refused by Figma
   * ("FILL can only be set on children of auto-layout frames"), which the
   * plugin degrades to a warning while the slot stays created and named. It is
   * FILL alone that is refused — `FIXED` lands whatever the parent is, which
   * matters now that a slot stating a `size` is pinned FIXED by the creation
   * default (B29) and would otherwise be warned about here for a refusal Figma
   * never makes.
   *
   * Every note goes into a LOCAL sink and is prefixed with the slot's name on
   * the way out, exactly as the plugin's loop does — N slots failing the same
   * way must not emit N identical strings.
   *
   * The id is DETERMINISTIC (`slot:<name>`) — a mock affordance, since the real
   * plugin's ids come from Figma — so a test can address the node the write
   * created without a mock-only echo in the reply.
   */
  const createSlotNode = (
    name: string,
    spec: Record<string, unknown> | undefined,
    warnings: string[],
    autoLayoutParent: boolean,
  ): string => {
    const node: Record<string, unknown> = {
      id: `slot:${name}`,
      name: name === '' ? 'Slot' : name,
      type: 'SLOT',
      absoluteBoundingBox: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      fills: [
        {
          type: 'SOLID',
          visible: true,
          opacity: 1,
          blendMode: 'NORMAL',
          color: { r: 1, g: 1, b: 1, a: 1 },
        },
      ],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: 'INSIDE',
      layoutMode: 'NONE',
      layoutSizingHorizontal: 'FIXED',
      layoutSizingVertical: 'FIXED',
      children: [],
    }
    const slotId = node.id as string
    if (spec === undefined) {
      createdSlots.set(slotId, node)
      return slotId
    }
    // applyCommonProperties' share: name, size, fills.
    if (typeof spec.name === 'string') {
      node.name = spec.name
    }
    if (Array.isArray(spec.size)) {
      const [w, h] = spec.size as number[]
      node.absoluteBoundingBox = {
        x: 0,
        y: 0,
        width: w,
        height: h,
      }
    }
    if (Array.isArray(spec.fills)) {
      node.fills = spec.fills
    }
    // …and the layout, in the export vocabulary a read consumes.
    const layout = spec.layout as
      | {
          mode?: string
          spacing?: number
          padding?: number[]
          align?: string[]
          wrap?: boolean
        }
      | undefined
    if (layout !== undefined) {
      node.layoutMode =
        layout.mode === 'H'
          ? 'HORIZONTAL'
          : layout.mode === 'V'
            ? 'VERTICAL'
            : layout.mode === 'GRID'
              ? 'GRID'
              : 'NONE'
      if (typeof layout.spacing === 'number') {
        node.itemSpacing = layout.spacing
      }
      if (Array.isArray(layout.padding)) {
        const [pt, pr, pb, pl] = layout.padding
        node.paddingTop = pt
        node.paddingRight = pr
        node.paddingBottom = pb
        node.paddingLeft = pl
      }
      if (Array.isArray(layout.align)) {
        const [primary, counter] = layout.align
        node.primaryAxisAlignItems = primary
        node.counterAxisAlignItems = counter
      }
      if (layout.wrap === true) {
        node.layoutWrap = 'WRAP'
      }
    }
    // applyPostAppendProperties' share: sizing, which is exactly the field a
    // non-auto-layout parent refuses (T7 degrade, warn and continue).
    const slotWarnings: string[] = []
    if (Array.isArray(spec.sizing)) {
      const [h, v] = spec.sizing as string[]
      // The plugin assigns horizontal THEN vertical inside one try, so the real
      // partial case is `['FIXED','FILL']` on a non-auto-layout parent: FIXED
      // lands on horizontal, FILL throws on vertical, and one warning covers
      // the pair. This models the two ends — both land, or neither does — which
      // is exact for every shape a test exercises today (`['FILL','FILL']`,
      // `['FILL','HUG']`, and the pinned `['FIXED','FIXED']`). The mixed
      // FIXED-then-FILL shape would land its first axis in Figma and not here;
      // no test writes it, and the day one does, split the assignment.
      const refused =
        !autoLayoutParent && (h === 'FILL' || v === 'FILL')
      if (refused) {
        slotWarnings.push(
          'sizing not applicable on this node (SLOT): Error: FILL can only be set on children of auto-layout frames',
        )
      } else {
        node.layoutSizingHorizontal = h
        node.layoutSizingVertical = v
      }
    }
    // …then the bindings, literal first exactly as the plugin orders them. An
    // APPLIED var() binding is modelled the way the file reports one — the
    // paint carries boundVariables and the node carries the id → name map the
    // plugin's enrichment adds — so the read emits the wrapper back and the
    // test can tell a landed binding from a merely-unwarned one.
    const applied = mockApplyWrapperBindings(spec.bindings)
    slotWarnings.push(...applied.warnings)
    const boundNames: Record<string, string> = {}
    for (const binding of applied.applied) {
      if (binding.kind !== 'var') {
        continue
      }
      const paints = node[binding.field] as
        | Record<string, unknown>[]
        | undefined
      if (!Array.isArray(paints)) {
        continue
      }
      const varId = `var:mock:${binding.name}`
      for (const [i, paint] of paints.entries()) {
        if (
          binding.index === undefined ||
          binding.index === i
        ) {
          paint.boundVariables = {
            color: { id: varId, type: 'VARIABLE_ALIAS' },
          }
          boundNames[varId] = binding.name
        }
      }
    }
    if (Object.keys(boundNames).length > 0) {
      node.bindingNames = { variables: boundNames }
    }
    // warn-on-no-op (T7), mirroring the plugin's capabilityWarnings over a
    // SLOT: SlotNode extends DefaultFrameMixin, so it carries layout / fills /
    // strokes / effects / opacity / radius / clipsContent and NOT these four.
    for (const key of [
      'pointCount',
      'innerRadius',
      'sectionContentsHidden',
      'text',
    ]) {
      if (spec[key] !== undefined) {
        slotWarnings.push(
          key + ' ignored — not supported on a SLOT node',
        )
      }
    }
    warnings.push(
      ...slotWarnings.map(w => `slot "${name}": ${w}`),
    )
    createdSlots.set(slotId, node)
    return slotId
  }

  // L5 timing knobs — TEST INFRASTRUCTURE for the L6 watchdog tests only.
  // `silent` withholds every reply (incl. ping); `delayedCommands` maps a
  // command string to a reply-delay in ms (ping is never delayed). Both
  // default to off, so every pre-existing mock-based test keeps the
  // synchronous auto-answer it was written against.
  let silent = false
  // L6 hold knob: commands whose reply is withheld until releaseHeld().
  const heldCommands = new Set<string>()
  const heldReplies: (() => void)[] = []
  const delayedCommands = new Map<string, number>()
  // Count of liveness pings received (see MockPlugin.pings). Incremented on
  // receipt regardless of the silent gate, so a silent-dead plugin still
  // records the watchdog's probes.
  let pingCount = 0

  // runCommand mirrors the real plugin's handleCommand: dispatch on the command
  // string and return { result?, error? }. Pulled out of handleBroadcast so the
  // BATCH case can re-dispatch each op through it (the same way the real plugin's
  // BATCH case loops handleCommand) and so handleBroadcast just wraps the reply
  // in the relay frame.
  const runCommand = (
    command: string,
    params: Record<string, unknown> | undefined,
  ): { result?: unknown; error?: string } => {
    const cmd = { command, params } as CommandMessage
    let result: unknown = undefined
    let error: string | undefined = undefined

    switch (cmd.command) {
      // batch (M3-D): loop the converted ops through runCommand in array order,
      // collecting a per-op {ok,result|error} — partial success, one failure
      // does not abort the rest. Mirrors the real plugin's BATCH case.
      case 'batch': {
        const batchOps =
          (cmd.params?.ops as
            | {
                op: string
                params: Record<string, unknown>
              }[]
            | undefined) ?? []
        const results = batchOps.map(entry => {
          const r = runCommand(entry.op, entry.params)
          return r.error !== undefined
            ? { ok: false, error: r.error }
            : { ok: true, result: r.result }
        })
        result = { results }
        break
      }

      // ping (connection-liveness.md, L5): faithful to the real plugin, which
      // now answers ping (useRelay.ts) — a bare liveness ack, no document
      // state. handleBroadcast special-cases ping ABOVE this switch (bypasses
      // the identity guard + the delay map, mirroring the real plugin's
      // ping-answered-in-the-UI-iframe bypass), but it is still routed through
      // runCommand (incl. via BATCH) so the reply shape stays centralized here.
      case COMMANDS.PING:
        result = { ok: true }
        break

      case 'get_document_info':
        result = {
          name: documentName,
          currentPage: {
            id: 'page:1',
            name: pageName,
          },
        }
        break

      // status (D1): the LIVE context — current page, selection, viewport. The
      // server adds connection state (connected/channel); this returns only the
      // plugin-known live context, faithful to the real plugin's STATUS case.
      case 'status':
        result = {
          currentPage: { id: 'page:1', name: pageName },
          selection: [
            { id: '1:42', name: 'Card', type: 'FRAME' },
          ],
          viewport: {
            center: { x: 100, y: 200 },
            zoom: 1.5,
          },
        }
        break

      // close_plugin: internal lifecycle command (figma.closePlugin in the real
      // plugin). The mock can't close itself; mirror the real ack shape.
      case 'close_plugin':
        result = { closing: true }
        break

      case 'get_selection':
        result = [
          { id: '1:42', name: 'Card', type: 'FRAME' },
        ]
        break

      // set_selection: model the real plugin's resolution + T7 honesty. An id
      // prefixed `missing:` does not resolve (skipped); `xpage:` resolves but
      // lives on another page (cross-page degrade — warned, NOT thrown); the
      // rest select. selectedCount is the count actually selected, and dropped
      // ids ride back in warnings[] so a partial is never silent.
      case 'set_selection': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        const ssSkipped = ids.filter(id =>
          id.startsWith('missing:'),
        )
        const ssOffPage = ids.filter(id =>
          id.startsWith('xpage:'),
        )
        const ssSelected =
          ids.length - ssSkipped.length - ssOffPage.length
        const ssWarnings: string[] = []
        if (ssSkipped.length > 0) {
          ssWarnings.push(
            'skipped ' +
              ssSkipped.length +
              ' unresolved id(s): ' +
              ssSkipped.join(', '),
          )
        }
        if (ssOffPage.length > 0) {
          ssWarnings.push(
            'skipped ' +
              ssOffPage.length +
              ' cross-page id(s) not on the current page: ' +
              ssOffPage.join(', '),
          )
        }
        result = {
          selectedCount: ssSelected,
          warnings: ssWarnings,
        }
        break
      }

      case 'get_node': {
        // M14: the sentinel nodeId 'remote-inst:1' serves a remote-INSTANCE
        // raw export (componentId + componentKey + componentRemote:true) so the
        // reader's M14 projection and the e2e round-trip are testable headlessly.
        const gnNodeId = cmd.params?.nodeId as
          | string
          | undefined
        // B30: a slot minted by update_component reads back as itself — the
        // whole point of modelling the apply rather than echoing the payload.
        const gnSlot =
          gnNodeId === undefined
            ? undefined
            : createdSlots.get(gnNodeId)
        const gnAlias = slotExportFor(gnNodeId)
        const gnDeep = deepExportFor(gnNodeId)
        if (gnSlot !== undefined) {
          result = { ...gnSlot }
        } else if (gnDeep !== undefined) {
          // B53: a slot-override id resolves at every depth, and the node whose
          // live handle answers nothing still comes back — from the export,
          // carrying the readError that says what it could not read.
          result = gnDeep
        } else if (gnAlias !== undefined) {
          // B41: the read answers the CANONICAL id, not the one it was asked
          // for, and the descendant carries its own bindingNames.
          result = gnAlias
        } else if (gnNodeId === 'remote-inst:1') {
          result = {
            id: 'remote-inst:1',
            name: 'LibraryButton',
            type: 'INSTANCE',
            absoluteBoundingBox: {
              x: 0,
              y: 0,
              width: 120,
              height: 40,
            },
            fills: [],
            children: [],
            componentId: 'C:remote-lib-123',
            componentKey: 'lib-btn-key-456',
            componentRemote: true,
          }
        } else {
          result = {
            ...cardFixture,
            // What earlier writes actually landed on this node — merged AFTER
            // the fixture so a read reflects the file, not the fixture's
            // starting state.
            ...(appliedState.get(cardFixture.id) ?? {}),
            ...(sharedContext.get(cardFixture.id)
              ? {
                  context: sharedContext.get(
                    cardFixture.id,
                  ),
                }
              : {}),
          }
        }
        break
      }

      // inspect serializes the same raw export get_node consumes; the server's
      // read model (truncate-tree + budget) decides what survives. With no
      // nodeId/pageId it targets the current selection the way the real plugin
      // does: >1 selected → an ARRAY of raw exports (the server wraps them in a
      // SELECTION forest); exactly 1 → that single export; empty → the default
      // single-node export (representing the current page).
      case 'inspect': {
        const targeted =
          cmd.params?.nodeId !== undefined ||
          cmd.params?.pageId !== undefined
        const inDeep = deepExportFor(
          cmd.params?.nodeId as string | undefined,
        )
        if (inDeep !== undefined) {
          result = inDeep
          break
        }
        const inAlias = slotExportFor(
          cmd.params?.nodeId as string | undefined,
        )
        if (inAlias !== undefined) {
          result = inAlias
          break
        }
        // A PAGE cannot be exported, so the real plugin ASSEMBLES it from its
        // children — spending the caller's `depth` on them (B51).
        if (cmd.params?.pageId === PAGE_ID) {
          result = pageDocument(
            typeof cmd.params?.depth === 'number'
              ? cmd.params.depth
              : 0,
          )
          break
        }
        if (
          !targeted &&
          selection &&
          selection.length > 1
        ) {
          result = selection
        } else if (
          !targeted &&
          selection &&
          selection.length === 1
        ) {
          ;[result] = selection
        } else {
          result = {
            ...cardFixture,
            ...(sharedContext.get(cardFixture.id)
              ? {
                  context: sharedContext.get(
                    cardFixture.id,
                  ),
                }
              : {}),
          }
        }
        break
      }

      // get_nodes: ONE entry per requested id, in order — a raw export, or
      // {id, error} for a miss. The real plugin resolves each id on its own,
      // so a mock that answered the card fixture whatever it was asked could
      // not model a partial read at all — and `search`'s field hydration (B50)
      // is exactly a multi-id read of ids the scan just reported.
      case 'get_nodes': {
        const wanted =
          (cmd.params?.nodeIds as string[]) ?? []
        result = wanted.map(id => {
          const slot = createdSlots.get(id)
          if (slot !== undefined) {
            return { ...slot }
          }
          const deep = deepExportFor(id)
          if (deep !== undefined) {
            return deep
          }
          const alias = slotExportFor(id)
          if (alias !== undefined) {
            return alias
          }
          const inTree = fixtureNodeById(id)
          if (inTree === undefined) {
            return { id, error: 'Node not found' }
          }
          return {
            ...inTree,
            ...(id === cardFixture.id
              ? (appliedState.get(cardFixture.id) ?? {})
              : {}),
            ...(sharedContext.get(id)
              ? { context: sharedContext.get(id) }
              : {}),
          }
        })
        break
      }

      // list_pages: Rule A document + page enumeration ({docName, results}).
      case 'list_pages':
        result = {
          docName: documentName,
          results: [
            {
              id: 'page:1',
              name: pageName,
              isCurrent: true,
              childCount: 3,
            },
          ],
        }
        break

      // get_styles: the NEW server-expected shape — each entry carries a raw
      // figma VALUE the server renders to a view atom (paint→hex, text→font,
      // effect→head). Real value shapes so the e2e can assert atom rendering.
      case 'get_styles':
        result = {
          paint: mockStyleEntries('paint'),
          text: mockStyleEntries('text'),
          effect: mockStyleEntries('effect'),
          grid: mockStyleEntries('grid'),
        }
        break

      // get_components: the NEW richer shape — key + variantAxes + `properties`
      // + defaults per local entry, key + instancesCount per remote entry (no
      // fabricated `library` — a remote instance carries no library identity,
      // only `key` is honest). `properties` is the SAME {id,name,type,defaultValue,
      // variantOptions?} array shape + key update_component emits (read == write,
      // T2): each entry's `id` is the CANONICAL property id and `name` is the
      // part before "#".
      case 'get_components': {
        const goodSet = {
          id: '1:10',
          name: 'Button',
          key: 'btn-key',
          type: 'COMPONENT_SET',
          page: 'Main',
          // Surface 2: description surfaces read-only on every entry; context is
          // local-pluginData (frontmatter → server-sliced contextSummary).
          description: 'Primary action button',
          context:
            '---\npurpose: primary CTA\nrole: button/primary\n---\n## Notes\nUse for the main action only.',
          properties: [
            {
              id: 'Variant',
              name: 'Variant',
              type: 'VARIANT',
              defaultValue: 'Primary',
              variantOptions: ['Primary', 'Secondary'],
            },
            {
              id: 'Disabled#2:0',
              name: 'Disabled',
              type: 'BOOLEAN',
              defaultValue: false,
            },
          ],
          variantAxes: {
            Variant: ['Primary', 'Secondary'],
          },
          defaults: {
            Variant: 'Primary',
            Disabled: false,
          },
        }
        // T10 (the live timeout fix): the remote/library scan walks EVERY
        // instance's mainComponent — O(document) — and the real plugin SKIPS it
        // entirely unless includeRemote is set. Model that faithfully: default
        // (includeRemote falsy) → remote is empty (no scan ran); includeRemote
        // true → the library components are discovered.
        const includeRemote =
          cmd.params?.includeRemote === true
        const remote = includeRemote
          ? [
              {
                key: 'remote-key',
                name: 'Icon',
                instancesCount: 3,
              },
            ]
          : []
        // Faithful degrade model (Bug A): with componentSetError, the document
        // contains a ComponentSet whose per-set variant projection THROWS in the
        // real plugin ("Component set for node has existing errors"). The fixed
        // plugin guards each set individually → the bad set is included WITHOUT
        // its variant info and a warnings[] entry names the set + reason; the
        // good set still returns intact. Byte-faithful to the real plugin's
        // degraded reply shape + message.
        if (componentSetError) {
          result = {
            local: [
              goodSet,
              {
                id: '3:7',
                name: 'Broken',
                key: 'broken-key',
                type: 'COMPONENT_SET',
                page: 'Main',
              },
            ],
            remote,
            warnings: [
              'component set "Broken" (3:7) skipped variant projection: Error: in get_variantProperties: Component set for node has existing errors',
            ],
          }
          break
        }
        result = {
          local: [goodSet],
          remote,
        }
        break
      }

      // list_fonts: families grouped by the plugin ({ family, styles }).
      case 'list_fonts':
        result = {
          results: [
            {
              family: 'Inter',
              styles: ['Regular', 'Bold'],
            },
            { family: 'Roboto', styles: ['Regular'] },
          ],
        }
        break

      // get_reactions: a single ON_CLICK → NAVIGATE reaction.
      case 'get_reactions':
        result = {
          nodeId: cmd.params?.nodeId as string,
          reactions: [
            {
              trigger: { type: 'ON_CLICK' },
              actions: [
                {
                  type: 'NODE',
                  destinationId: '1:99',
                  navigation: 'NAVIGATE',
                },
              ],
            },
          ],
        }
        break

      // get_plugin_data: pluginData always; sharedPluginData only with a
      // namespace. Faithful to the real plugin: a `degrade:` nodeId models a
      // node-not-found degrade — empty pluginData + a 'Node not found' warning
      // (RESOLVES, never a WS reject), so the warnings-forwarding branch is
      // exercised over the relay (T7).
      case 'get_plugin_data': {
        const pdNodeId = cmd.params?.nodeId as string
        if (pdNodeId?.startsWith('degrade:')) {
          result = {
            nodeId: pdNodeId,
            pluginData: {},
            warnings: ['Node not found: ' + pdNodeId],
          }
        } else {
          result = {
            nodeId: pdNodeId,
            pluginData: { foo: 'bar' },
            sharedPluginData: cmd.params?.namespace
              ? { baz: 'qux' }
              : undefined,
          }
        }
        break
      }

      // get_annotations: happy path (Rule A). Faithful to the real plugin:
      //   • an explicit, unresolvable nodeId (`degrade:` prefix) RESOLVES to a
      //     {results:[], warnings:['Node not found: …']} not-found degrade (T7);
      //   • per-node nodeId TAGGING happens ONLY on a selection-based multi-read
      //     (NO explicit nodeId, 2+ selected nodes) — the plugin tags each
      //     annotation with its source node so the flat result stays
      //     attributable. An EXPLICIT nodeId read returns bare annotations.
      //     (Previously the mock keyed tagging off an explicit `multi:` nodeId,
      //     the OPPOSITE of the real plugin.)
      case 'get_annotations': {
        const annNodeId = cmd.params?.nodeId as
          | string
          | undefined
        if (annNodeId?.startsWith('degrade:')) {
          result = {
            results: [],
            truncated: false,
            warnings: ['Node not found: ' + annNodeId],
          }
        } else if (annNodeId === undefined) {
          // No explicit id → read the current selection. Model a >1-node
          // selection: each annotation is TAGGED with its source nodeId.
          result = {
            results: [
              {
                label: 'Check spacing',
                categoryId: 'cat:1',
                nodeId: '1:42',
              },
              {
                label: 'Align icon',
                categoryId: 'cat:2',
                nodeId: '1:45',
              },
            ],
            truncated: false,
          }
        } else {
          // Explicit single nodeId → bare annotations (no nodeId tag).
          result = {
            results: [
              {
                label: 'Check spacing',
                categoryId: 'cat:1',
              },
            ],
            truncated: false,
          }
        }
        break
      }

      // search (Rule A): the plugin returns RAW candidate nodes; the SERVER
      // applies match + fields + limit + cursor. We echo a small mixed-type
      // candidate set so e2e can exercise the server-side match (incl. type
      // array) and pagination. Faithful to the real plugin: an unresolvable
      // scope=node/page qualifier returns {error} (T7), not a zero-match.
      case 'search': {
        const searchScope =
          (cmd.params?.scope as string) || 'document'
        const knownIds = new Set([
          '1:42',
          '1:43',
          '1:44',
          '1:45',
        ])
        const knownPages = new Set([
          '0:1',
          'repaired:1',
          'variants:1',
        ])
        // A page whose scan the plugin had to REPAIR (B48 / final-review I-1 /
        // B56). A chip written into a slot answered an alias id, its label
        // threw, and the repair replaced the chip's row with the one its export
        // names. The export row is addressable where the alias was not.
        //
        // It cannot carry `styleIds` or `context` — those are live-only reads,
        // and the plugin SAYS so rather than returning a short result set
        // quietly. It CAN carry `componentKey` / `instancesOf` since B56: the
        // export names the instance's main by id, and the plugin trades that id
        // for the name and key, but only when the caller hinted for them. So
        // the reply here depends on the hint, exactly as `repairScan` does.
        if (
          searchScope === 'page' &&
          cmd.params?.pageId === 'repaired:1'
        ) {
          const wantsRef =
            cmd.params?.collectComponentRef === true
          const chip: Record<string, unknown> = {
            id: 'I298:7517;298:7516;298:7523',
            name: 'Chip',
            type: 'INSTANCE',
            size: [96, 28],
          }
          if (wantsRef) {
            chip.instancesOf = 'Chip'
            chip.componentKey = 'k-chip'
          }
          result = {
            results: [
              chip,
              {
                id: 'I298:7517;298:7516;298:7523;298:7510',
                name: 'Label',
                type: 'TEXT',
                size: [80, 16],
              },
            ],
            warnings: [
              'search: repaired the subtree at I298:7517;298:7516;298:7523 — the row for 298:7519 now comes from the export and cannot carry ' +
                (wantsRef
                  ? 'context, styleIds'
                  : 'context, styleIds, componentKey, instancesOf') +
                '; a match on those keys will not find this node',
            ],
          }
          break
        }
        // A page holding two instances of a VARIANT family (B56, live shape).
        // Live, file MFMyzjEZyH5cVyrNejdbyP: 454:5478 is a COMPONENT_SET named
        // "State block" and 454:5477 is its "State=Error" variant, so an
        // instance's main-component NAME is `State=Error` and the family name —
        // the only one the components panel, the design doc or an acceptance
        // gate ever says — is on the set. The plugin emits both keys; whether
        // `instancesOf` reaches either is the SERVER's matcher, which is what
        // this arm exists to drive.
        if (
          searchScope === 'page' &&
          cmd.params?.pageId === 'variants:1'
        ) {
          const wantsVariantRef =
            cmd.params?.collectComponentRef === true
          const variantRow = (
            id: string,
            name: string,
            ownName: string,
          ): Record<string, unknown> => {
            const row: Record<string, unknown> = {
              id,
              name,
              type: 'INSTANCE',
              size: [200, 120],
            }
            if (wantsVariantRef) {
              row.instancesOf = ownName
              row.instancesOfSet = 'State block'
            }
            return row
          }
          result = {
            results: [
              variantRow(
                'I454:5452;453:3882;454:5489',
                'Error block',
                'State=Error',
              ),
              variantRow(
                'I454:5346;453:3882;454:5370',
                'Empty block',
                'State=Empty',
              ),
              // A plain frame on the same page, so a family match proves it is
              // filtering rather than returning the page.
              {
                id: '454:5300',
                name: 'Plot area',
                type: 'FRAME',
                size: [400, 240],
              },
            ],
          }
          break
        }

        // B53 — a scan rooted on the three-level slot fixture. The plugin's
        // repair pass replaces every slot-override row with the one its export
        // names, so the candidates come back under the CANONICAL ids, which is
        // what the server then hydrates `component` and the other node-spec
        // fields from. That hydration is a get_nodes over these same ids, so it
        // is exactly the round trip B53 ③ broke.
        if (
          searchScope === 'node' &&
          cmd.params?.nodeId === '305:8637'
        ) {
          const sdDepth = cmd.params?.depth as
            | number
            | undefined
          result = {
            results: deepScanRows()
              // The scan root itself is not a candidate — its children are
              // level 0, exactly as the real scan counts them.
              .filter(row => row.depth > 0)
              .filter(
                row =>
                  sdDepth === undefined ||
                  sdDepth < 0 ||
                  row.depth - 1 <= sdDepth,
              )
              .map(row => {
                const box = row.node
                  .absoluteBoundingBox as {
                  width: number
                  height: number
                }
                const candidate: Record<string, unknown> = {
                  id: row.node.id,
                  name: row.node.name,
                  type: row.node.type,
                  size: [box.width, box.height],
                }
                if (
                  cmd.params?.collectCharacters === true &&
                  typeof row.node.characters === 'string'
                ) {
                  candidate.characters = row.node.characters
                }
                return candidate
              }),
          }
          break
        }
        // The real plugin RESOLVES a not-found as a handler {error} (rides in
        // command-result.result, NOT a WS-level reject), so set result.error.
        if (
          searchScope === 'node' &&
          !knownIds.has(cmd.params?.nodeId as string)
        ) {
          result = {
            error: 'Node not found: ' + cmd.params?.nodeId,
          }
          break
        }
        // I65 — a `scope:'page'` naming NO page falls back to the current one
        // and says which it chose (search-page-scope.ts). This mock's current
        // page is `0:1` / "Page 1", so the fallback lands on the same tree the
        // explicit `0:1` scan returns. Modelled BEFORE the not-found guard,
        // exactly as the real plugin resolves it before the lookup — otherwise
        // `undefined` would still reach that guard and reproduce the defect.
        const namedPage = cmd.params?.pageId as
          | string
          | undefined
        const pageFallback =
          searchScope === 'page' &&
          (namedPage === undefined || namedPage === '')
        const scopeNote = pageFallback
          ? 'search: scope "page" named no pageId, so the CURRENT page "Page 1" (0:1) was scanned. Pass pageId to scan a different page, or scope:"document" to scan them all.'
          : undefined
        if (
          searchScope === 'page' &&
          !pageFallback &&
          !knownPages.has(namedPage as string)
        ) {
          result = {
            error: 'Page not found: ' + namedPage,
          }
          break
        }

        // A tiny fixed tree mirroring the real plugin's scan. Card (1:42) is a
        // direct child of the page (scan level 0); Title/Body/Action Button are
        // its children (level 1). Metadata (characters / componentKey /
        // instancesOf / styleIds / variableIds) is held here but only ATTACHED
        // when the matching collect* hint is set — faithfully mirroring the real
        // plugin's CONDITIONAL collection (B3/B4), so the e2e drives the same
        // contract the live plugin produces.
        type ScanNode = {
          base: Record<string, unknown>
          depth: number
          characters?: string
          componentKey?: string
          instancesOf?: string
          styleIds?: string[]
          variableIds?: string[]
        }
        const tree: ScanNode[] = [
          {
            base: {
              id: '1:42',
              name: 'Card',
              type: 'FRAME',
              size: [320, 200],
            },
            depth: 0,
            styleIds: ['S:card-fill'],
            variableIds: ['V:radius'],
          },
          {
            base: {
              id: '1:43',
              name: 'Title',
              type: 'TEXT',
              size: [288, 24],
            },
            depth: 1,
            characters: 'Welcome back',
            styleIds: ['S:title-text'],
          },
          {
            base: {
              id: '1:44',
              name: 'Body',
              type: 'TEXT',
              size: [288, 48],
            },
            depth: 1,
            characters: 'Sign in to continue',
          },
          {
            base: {
              id: '1:45',
              name: 'Action Button',
              type: 'INSTANCE',
              size: [100, 40],
            },
            depth: 1,
            componentKey: 'btn-key-123',
            instancesOf: 'Button',
            variableIds: ['V:brand'],
          },
        ]

        // B2 — depth bounds the scan SCOPE. undefined/-1 = scan all; N keeps
        // nodes at scan level ≤ N (the level-1 children appear once depth ≥ 1).
        const sDepth = cmd.params?.depth as
          | number
          | undefined
        const inScope = (n: ScanNode): boolean =>
          sDepth === undefined ||
          sDepth < 0 ||
          n.depth <= sDepth

        // B3/B4 — conditional collection hints (set by the server only when the
        // request needs them). Attach metadata only under the matching flag.
        const collectComponentRef =
          cmd.params?.collectComponentRef === true
        const collectStyleId =
          cmd.params?.collectStyleId === true
        const collectVariableId =
          cmd.params?.collectVariableId === true
        const collectCharacters =
          cmd.params?.collectCharacters === true

        result = {
          results: tree.filter(inScope).map(n => {
            const candidate: Record<string, unknown> = {
              ...n.base,
            }
            if (
              collectCharacters &&
              n.characters !== undefined
            ) {
              candidate.characters = n.characters
            }
            if (collectComponentRef) {
              if (n.componentKey !== undefined) {
                candidate.componentKey = n.componentKey
              }
              if (n.instancesOf !== undefined) {
                candidate.instancesOf = n.instancesOf
              }
            }
            if (
              collectStyleId &&
              n.styleIds !== undefined
            ) {
              candidate.styleIds = n.styleIds
            }
            if (
              collectVariableId &&
              n.variableIds !== undefined
            ) {
              candidate.variableIds = n.variableIds
            }
            return candidate
          }),
          // I65 — the page the tool chose, on the same warnings[] channel the
          // real plugin uses, and omitted when the caller named the page.
          ...(scopeNote !== undefined
            ? { warnings: [scopeNote] }
            : {}),
        }
        break
      }

      case 'export': {
        const fmt = (cmd.params?.format as string) || 'PNG'
        const scale = (cmd.params?.scale as number) || 1
        result = {
          format: fmt,
          scale,
          data: fmt === 'SVG' ? MOCK_SVG : MOCK_PNG_BASE64,
        }
        break
      }

      // update_node: echo the CONVERTED spec (Figma objects, not atom strings)
      // back so e2e/round-trip tests prove the server parsed and the plugin
      // only assigned. Mirrors the real plugin's {id,name,type,warnings} reply.
      case 'update_node': {
        const unId = cmd.params?.nodeId as string
        // A compound id that names nothing is a clean not-found, the same
        // answer every time — never the intermittent network error the bare
        // resolve used to give a sublayer that DOES exist.
        if (!resolvesInMockDoc(unId)) {
          result = { error: 'Node not found: ' + unId }
          break
        }
        const spec = (cmd.params?.spec ?? {}) as Record<
          string,
          unknown
        >
        // Faithful set/getSharedPluginData: a non-empty context persists; an
        // empty/whitespace value clears the key; an omitted value preserves.
        if (typeof spec.context === 'string') {
          if (spec.context.trim() === '') {
            sharedContext.delete(unId)
          } else {
            sharedContext.set(unId, spec.context)
          }
        }
        // The stroke fields LAND on the node (B27) — see applyStrokeState. A
        // node that cannot carry them is handled in the incompat branch below,
        // which warns instead of applying.
        if (!unId.startsWith('incompat:')) {
          applyStrokeState(unId, spec)
        }
        // Mirror the real plugin's warn-on-no-op + degrade behavior on an
        // INCOMPATIBLE target (modeled by an `incompat:` nodeId — a node that
        // lacks layoutMode/fills/etc. capability). 3a: a patched property that
        // the node type doesn't support is reported in warnings[]. 3b: a sizing/
        // layoutPositioning patch warns-and-continues (never throws → {error}).
        // The incompatible target is reported as a SLICE (a node lacking these
        // capabilities); the warnings INTERPOLATE that actual type and the
        // capability list MATCHES the real plugin's (incl. `opacity`) rather
        // than hardcoding "SLICE" / omitting opacity.
        const unWarnings: string[] = []
        const unIncompat = unId.startsWith('incompat:')
        const unIsDoc = unId.startsWith('doc:')
        const unType = unIsDoc
          ? 'DOCUMENT'
          : unIncompat
            ? 'SLICE'
            : 'FRAME'
        // B6 (T7 honesty): DOCUMENT node — name is read-only in the plugin API.
        // Mirror the real plugin guard: warn and skip (do NOT echo spec.name).
        if (unIsDoc && spec.name !== undefined) {
          unWarnings.push(
            'name ignored — the file/document node cannot be renamed via the Figma plugin API',
          )
          delete spec.name
        }
        if (unIncompat) {
          // capability key → spec key, matching the plugin's capabilityChecks.
          const capChecks: [string, string][] = [
            ['layoutMode', 'layout'],
            ['fills', 'fills'],
            ['strokes', 'strokes'],
            ['effects', 'effects'],
            ['opacity', 'opacity'],
            ['cornerRadius', 'radius'],
            ['clipsContent', 'clipsContent'],
            // A SLICE has no `characters`, and applyTextProperties runs only
            // for a TEXT node, so a text patch here is a silent no-op unless
            // named — the row capabilityWarnings gained with B30.
            ['characters', 'text'],
            // Only a vector-like node carries path data, so path geometry
            // patched onto anything else has nowhere to go (B45).
            ['vectorPaths', 'vectorPaths'],
          ]
          for (const [, label] of capChecks) {
            if (spec[label] !== undefined) {
              unWarnings.push(
                label +
                  ' ignored — not supported on a ' +
                  unType +
                  ' node',
              )
            }
          }
          // B27 per-side stroke weights: the real plugin's applyStrokeWeights
          // feature-detects IndividualStrokesMixin, then the uniform
          // strokeWeight, and only warns when a node carries neither — which
          // is exactly a SLICE. A node that DOES carry the four sides applies
          // them silently, which is why this lives inside the incompat branch.
          if (spec.strokeWeights !== undefined) {
            unWarnings.push(
              'per-side stroke weights ignored — not supported on a ' +
                unType +
                ' node',
            )
          }
          // constraints warn-on-no-op: the real plugin guards on
          // `'constraints' in node` and warns with this exact wording when the
          // target lacks ConstraintMixin (mirrored here for a SLICE).
          if (spec.constraints !== undefined) {
            unWarnings.push(
              'constraints ignored — not supported on a ' +
                unType +
                ' node',
            )
          }
          if (spec.sizing !== undefined) {
            unWarnings.push(
              'sizing not applicable on this node (' +
                unType +
                '): incompatible context',
            )
          }
          if (spec.layoutPositioning !== undefined) {
            unWarnings.push(
              'layoutPositioning not applicable on this node (' +
                unType +
                '): incompatible context',
            )
          }
        }
        // I39: the update path applies bindings in the same order the create
        // path does — literal first, binding second — and degrades the same way.
        const unBind = mockApplyWrapperBindings(
          spec.bindings,
        )
        unWarnings.push(...unBind.warnings)
        if (!unIncompat) {
          applyStyleState(unId, unBind.applied)
          // Literal first, binding second — the plugin's own order, and the
          // reason a written-back `gap: "var(space/8)8"` keeps its token.
          applyLayoutState(unId, spec)
          applyLayoutBindingState(
            unId,
            layoutBindingsOf(unBind.applied),
          )
        }
        result = {
          id: unId,
          name: (spec.name as string) ?? 'Card',
          type: unType,
          warnings: unWarnings,
          // Echo the converted spec so the e2e can assert the parsed paint
          // arrived intact.
          spec,
          appliedBindings: unBind.applied,
        }
        break
      }

      // bind_variable: deterministic happy / degrade / error paths keyed off
      // the variableId so the e2e can drive each contract. A degrade/unknown
      // reply NEVER returns {error} — it returns {id,warnings} so the server's
      // formatMutationResult reports success-with-warning, not failure.
      //
      // FIELD-AWARE (mirrors the real plugin): paint fields (fills/strokes) bind
      // via setBoundVariableForPaint, scalar fields via setBoundVariable. The two
      // routes degrade with DIFFERENT messages, so the mock must branch on the
      // field the same way the plugin does — not echo a field-agnostic success.
      //
      // M13 — MODE MAP: when params.mode is present, iterate entries and model
      // the plugin's per-entry degrade paths:
      //   - modeName prefixed 'degrade:' → unknown-mode warning (not error)
      //   - clearMode:true → success (mock supports it)
      //   - modeId/modeName without degrade prefix → success (no warning)
      // The mode map is processed independently of variableId/field.
      case 'bind_variable': {
        const bvNodeId = cmd.params?.nodeId as
          | string
          | undefined
        if (
          bvNodeId !== undefined &&
          !resolvesInMockDoc(bvNodeId)
        ) {
          result = { error: 'Node not found: ' + bvNodeId }
          break
        }
        const bvMode = cmd.params?.mode as
          | Record<
              string,
              {
                modeId?: string
                modeName?: string
                clearMode?: boolean
              }
            >
          | undefined
        const variableId = cmd.params?.variableId as
          | string
          | undefined
        const bvField = cmd.params?.field as
          | string
          | undefined
        const bvWarnings: string[] = []

        // B58 — `clear: true` removes the binding and names no variable. The
        // real plugin refuses a paint field here (paints bind per paint, not on
        // the node field), so the mock mirrors that refusal.
        if (cmd.params?.clear === true) {
          if (
            bvField === 'fills' ||
            bvField === 'strokes'
          ) {
            result = {
              error:
                'bind_variable cannot clear a `' +
                bvField +
                '` binding: paint variables bind per paint, not on the node field. ' +
                'Re-write the paint with a plain atom (no var() wrapper) to replace it.',
            }
            break
          }
          if (
            bvNodeId !== undefined &&
            bvField !== undefined
          ) {
            clearLayoutBindingState(bvNodeId, bvField)
          }
          result = { id: bvNodeId, warnings: bvWarnings }
          break
        }

        // Process mode map (M13): feature-detect + per-entry degrade.
        if (bvMode !== undefined) {
          for (const [
            collectionId,
            entry,
          ] of Object.entries(bvMode)) {
            if (entry.clearMode === true) {
              // clear-mode path: success, no warning
            } else if (
              entry.modeName !== undefined &&
              entry.modeName.startsWith('degrade:')
            ) {
              // unknown-mode degrade: warn (not error), per T7
              bvWarnings.push(
                'unknown mode "' +
                  entry.modeName +
                  '" in collection ' +
                  collectionId +
                  '; mode pin skipped',
              )
            }
            // else: modeId or non-degrade modeName → success, no warning
          }
        }

        // Process field binding (original path).
        if (variableId !== undefined) {
          const isPaintField =
            bvField === 'fills' || bvField === 'strokes'
          if (variableId.startsWith('err:')) {
            error = `Variable not found: ${variableId}`
            break
          } else if (variableId.startsWith('degrade:')) {
            bvWarnings.push(
              isPaintField
                ? 'setBoundVariableForPaint unavailable in this Figma version; paint binding skipped'
                : 'setBoundVariable unavailable in this Figma version; binding skipped',
            )
          } else if (
            bvField !== undefined &&
            MOCK_LAYOUT_BIND_FIELDS.has(bvField)
          ) {
            // A LAYOUT bind LANDS, and the file then reports it (B44). The
            // reply is `ok, warnings:[]` either way — byte-identical to a
            // no-op — so the only thing that can tell a real bind from a
            // silent one is the next read.
            applyLayoutBindingState(bvNodeId as string, [
              {
                field: bvField,
                name:
                  mockVariableNameById(variableId) ??
                  variableId,
              },
            ])
          }
          // else: happy path, no additional warning
        }

        result = {
          id: cmd.params?.nodeId as string,
          warnings: bvWarnings,
        }
        break
      }

      // get_variables: a card-with-binding fixture so the round-trip can pick a
      // variable id, bind it, and read it back as a var(...) wrapper atom.
      case 'get_variables': {
        result = {
          results: [
            {
              id: 'col:1',
              name: 'Brand',
              modes: [{ modeId: 'm1', name: 'Light' }],
              variables: [
                {
                  id: 'var:123',
                  name: 'Brand/Primary',
                  resolvedType: 'COLOR',
                  valuesByMode: {
                    m1: { r: 1, g: 0, b: 0, a: 1 },
                  },
                  aliases: [],
                  scopes: ['ALL_SCOPES'],
                  codeSyntax: { WEB: '--brand-primary' },
                  hiddenFromPublishing: false,
                },
              ],
            },
          ],
        }
        break
      }

      // create_node: the M2 handler sends {spec, parentId} (CONVERTED
      // FigmaWritePayload — atom leaves parsed, name ?? type applied); the
      // legacy M3-adjacent handler (tools/create.ts) still sends {node,…}.
      // Accept either key so both create paths round-trip, echo the converted
      // spec back for serialization assertions, and mirror the real plugin's
      // {id,name,type,warnings} reply.
      //
      // M2b T7 instance-lock wrap: a parentId prefixed `badparent:` models a
      // non-SLOT instance descendant whose appendChild Figma blocks at runtime.
      // The real plugin wraps that throw in a try/catch and returns the SAME
      // structured error shape (result.error). The mock mirrors that so the e2e
      // can assert the error-shape contract without a live Figma document.
      case 'create_node': {
        const nodeSpec = (cmd.params?.spec ??
          cmd.params?.node) as
          | Record<string, unknown>
          | undefined
        const parentId = cmd.params?.parentId as
          | string
          | undefined
        if (parentId?.startsWith('badparent:')) {
          // Mirror the real plugin's T7 structured error: the type reported is
          // the simulated parent type (INSTANCE for a non-slot descendant).
          result = {
            error:
              'Cannot append into this parent: only a component SLOT accepts children inside an instance (got INSTANCE). To fill a slot, target the slot node.',
          }
          break
        }
        const nodeType = nodeSpec?.type as string
        const echo: Record<string, unknown> = {
          ...(nodeSpec ?? {}),
        }
        delete echo.children
        // Mirror the real plugin's SLOT degrade (T7): a SLOT is created as a
        // FRAME placeholder and a downgrade warning rides back on success.
        const cnWarnings: string[] = []
        let createdType = nodeType
        if (nodeType === 'SLOT') {
          createdType = 'FRAME'
          cnWarnings.push(
            'SLOT requested via create_node was created as a FRAME placeholder; real SLOT promotion happens in create_component via component.createSlot()',
          )
        }
        // Mirror the real plugin's INSTANCE main-component resolution
        // (figma-plugin/src/code.ts): the component ref must carry a local
        // `id` (getNodeByIdAsync → COMPONENT/COMPONENT_SET) or a published
        // `key` (importComponentByKeyAsync). Neither present → clean {error}.
        // An `err:`-prefixed id models a not-found node; a `notcomp:`-prefixed
        // id models a node that is not a COMPONENT/COMPONENT_SET (same prefix
        // convention update_component uses), so the by-id error boundary is
        // assertable without a live Figma document.
        // M14: compRef.remote===true + key → key-first (mirrors real plugin).
        let instanceResolvedBy: 'key' | 'id' | undefined =
          undefined
        if (nodeType === 'INSTANCE') {
          const compRef = nodeSpec?.component as
            | {
                id?: string
                key?: string
                remote?: boolean
                properties?: Record<
                  string,
                  string | boolean
                >
              }
            | undefined
          if (
            compRef?.id === undefined &&
            compRef?.key === undefined
          ) {
            error =
              'INSTANCE requires component.id (local component node) or component.key (published/library component)'
            break
          }
          if (compRef.id?.startsWith('err:')) {
            error =
              'INSTANCE component.id not found: ' +
              compRef.id
            break
          }
          if (compRef.id?.startsWith('notcomp:')) {
            // Mirror the real plugin's "got <found.type>" message. Encode the
            // simulated type as the middle segment (notcomp:<TYPE>:<id>);
            // default to FRAME when omitted (notcomp:<id>).
            const ncParts = compRef.id.split(':')
            const gotType =
              ncParts.length >= 3 ? ncParts[1] : 'FRAME'
            error =
              'INSTANCE component.id must reference a COMPONENT or COMPONENT_SET, got ' +
              gotType +
              ': ' +
              compRef.id
            break
          }
          // M14: mirror the real plugin's remote-first resolution path.
          // remote===true + key present → resolved by key (importComponentByKeyAsync);
          // otherwise resolved by id (getNodeByIdAsync), falling back to key-only.
          if (
            compRef.remote === true &&
            compRef.key !== undefined
          ) {
            instanceResolvedBy = 'key'
          } else if (compRef.id !== undefined) {
            instanceResolvedBy = 'id'
          } else {
            instanceResolvedBy = 'key'
          }
          // Mirror the real plugin's #11 name → exact-key resolution for the
          // create_node INSTANCE path: friendly names that can't be resolved
          // warn (and are skipped) the same way set_instance does.
          if (compRef.properties) {
            const { warnings: cnResolveWarnings } =
              mockResolveInstanceProps(
                compRef.properties,
                MOCK_INSTANCE_KEYS,
              )
            cnWarnings.push(...cnResolveWarnings)
          }
        }
        // B41 — a create INTO a slot hands back the PRE-APPEND id; the file
        // knows the node by its canonical instance chain from here on.
        const createdId = parentId?.startsWith(
          'slotparent:',
        )
          ? SLOT_ALIAS_ID
          : `created:${Math.random().toString(36).slice(2, 8)}`
        // Faithful set/getSharedPluginData on the newly created node (see
        // update_node): non-empty persists, empty/whitespace clears.
        if (typeof nodeSpec?.context === 'string') {
          if (nodeSpec.context.trim() === '') {
            sharedContext.delete(createdId)
          } else {
            sharedContext.set(createdId, nodeSpec.context)
          }
        }
        // …and the same stroke apply the update path models (B27), so a created
        // node carries the sides it was created with.
        if (nodeSpec !== undefined && nodeSpec !== null) {
          applyStrokeState(createdId, nodeSpec)
        }
        // I39: bindings are applied AFTER the literal properties, exactly as
        // buildSingleNode does — an unresolvable name warns and the literal
        // stands. `appliedBindings` is a MOCK-ONLY echo (like `resolvedBy`
        // above) so a test can tell a landed binding from a degraded one.
        const cnBind = mockApplyWrapperBindings(
          nodeSpec?.bindings,
        )
        cnWarnings.push(...cnBind.warnings)
        result = {
          ...echo,
          id: createdId,
          name: (nodeSpec?.name as string) ?? nodeType,
          type: createdType,
          parentId,
          warnings: cnWarnings,
          appliedBindings: cnBind.applied,
          // M14: echo resolvedBy for the INSTANCE create path so tests can
          // assert key-first (remote) vs id-first (local) behavior.
          ...(instanceResolvedBy !== undefined
            ? { resolvedBy: instanceResolvedBy }
            : {}),
        }
        break
      }

      // create_tree (M3 contract): params = { tree, parentId?, refs? }. The
      // server has already CONVERTED every node to a FigmaWritePayload (atom
      // leaves → Figma objects) and the ref-pool to converted form. The mock
      // counts the realized node total by resolving `{ ref }` against refs and
      // treating `{ id }` clones as a single node, and echoes the converted
      // tree + refs back so e2e/round-trip tests can assert the nested
      // structure (and ref/clone resolution) reached the plugin intact.
      //
      // M2b T7 instance-lock wrap: a parentId prefixed `badparent:` models a
      // non-SLOT instance descendant; mirrors the real plugin's T7 try/catch
      // returning result.error (same shape as create_node).
      case 'create_tree': {
        const treeParentId = cmd.params?.parentId as
          | string
          | undefined
        if (treeParentId?.startsWith('badparent:')) {
          result = {
            error:
              'Cannot append into this parent: only a component SLOT accepts children inside an instance (got INSTANCE). To fill a slot, target the slot node.',
          }
          break
        }
        const treeSpec = cmd.params?.tree as
          | Record<string, unknown>
          | undefined
        const treeRefs = cmd.params?.refs as
          | Record<string, Record<string, unknown>>
          | undefined
        // refStack mirrors the real plugin's cycle guard: a cyclic { ref } pool
        // (a→b→a, or a self-ref) throws 'Cyclic ref in pool: …' instead of
        // recursing forever — so the mock surfaces a clean {error} the same way
        // the plugin does, never hanging the e2e.
        //
        // The ids are COLLECTED, not counted: the real plugin reports one id
        // per node it realizes (root first, depth-first in creation order) so
        // the server can answer the tool-surface `{root, ids[]}`. A `{ ref }`
        // expands to its whole rebuilt subtree; an `{ id }` clone is ONE
        // realized node (its descendants come along, unenumerated).
        //
        // I39: every realized node applies ITS OWN bindings as it is built —
        // the tree path runs through the same buildSingleNode the single create
        // does, so a wrapper on a child binds exactly like a wrapper on a root,
        // and a child's degrade lands in the ROOT's warnings (the only reply
        // the caller sees).
        const treeApplied: MockBinding[] = []
        const treeBindWarnings: string[] = []
        const collectIds = (
          node: Record<string, unknown>,
          out: string[],
          refStack: string[] = [],
        ): void => {
          const mint = (): string => {
            out.push(
              `created:${out.length}:${Math.random().toString(36).slice(2, 8)}`,
            )
          }
          // { ref }: rebuild refs[key] FRESH each reuse.
          if (
            node.ref !== undefined &&
            node.type === undefined
          ) {
            const refKey = node.ref as string
            const refSpec = treeRefs?.[refKey]
            if (!refSpec) {
              mint()
              return
            }
            if (refStack.includes(refKey)) {
              throw new Error(
                'Cyclic ref in pool: ' +
                  [...refStack, refKey].join(' -> '),
              )
            }
            collectIds(refSpec, out, [...refStack, refKey])
            return
          }
          // { id } clone: a single realized node.
          if (
            node.id !== undefined &&
            node.type === undefined
          ) {
            mint()
            return
          }
          mint()
          const built = mockApplyWrapperBindings(
            node.bindings,
          )
          treeApplied.push(...built.applied)
          treeBindWarnings.push(...built.warnings)
          const children = node.children as
            | Record<string, unknown>[]
            | undefined
          if (children) {
            for (const child of children) {
              collectIds(child, out, refStack)
            }
          }
        }
        try {
          const ids: string[] = []
          if (treeSpec) {
            collectIds(treeSpec, ids)
          } else {
            ids.push('created:0')
          }
          result = {
            ...(treeSpec ?? {}),
            // The real plugin's reply: the root in the create_node family plus
            // every id it created. The server maps this to {root, ids[]}. The
            // echoed tree/refs/parentId around it are a MOCK-ONLY affordance so
            // e2e can assert what reached the plugin.
            id: ids[0],
            name:
              (treeSpec?.name as string) ??
              (treeSpec?.type as string),
            type: treeSpec?.type as string,
            ids,
            parentId: treeParentId,
            refs: treeRefs,
            totalNodes: ids.length,
            // The real plugin answers `warnings` only when the walk produced
            // any (omitted when clean); `appliedBindings` is the mock-only echo.
            ...(treeBindWarnings.length > 0
              ? { warnings: treeBindWarnings }
              : {}),
            appliedBindings: treeApplied,
          }
        } catch (e) {
          error = String(e instanceof Error ? e.message : e)
        }
        break
      }

      // clone_node: echo one {id,name,type} per requested clone (count, default
      // 1) so the count + index/parent forwarding is assertable. An out-of-range
      // `index` returns a clean {error} mirroring the real plugin's up-front
      // range guard (parent has a fixed child count of 3), rather than the raw
      // RangeError it used to degrade to.
      case 'clone_node': {
        const cloneCount =
          (cmd.params?.count as number) ?? 1
        const cloneIndex = cmd.params?.index as
          | number
          | undefined
        const cloneParentChildCount = 3
        if (
          cloneIndex !== undefined &&
          (cloneIndex < 0 ||
            cloneIndex > cloneParentChildCount)
        ) {
          error =
            'clone_node index ' +
            cloneIndex +
            ' is out of range for the parent (0..' +
            cloneParentChildCount +
            ')'
          break
        }
        const cloneArr: {
          id: string
          name: string
          type: string
        }[] = []
        // B41 control: a CLONE of slot-hosted content is minted under the
        // canonical chain, which is why its wrappers never went missing.
        if (cmd.params?.nodeId === SLOT_ALIAS_ID) {
          result = [
            {
              id: SLOT_CLONE_ID,
              name: 'Chip',
              type: 'INSTANCE',
            },
          ]
          break
        }
        for (let i = 0; i < cloneCount; i++) {
          cloneArr.push({
            id: `clone:${i}:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Card',
            type: 'FRAME',
          })
        }
        result = cloneArr
        break
      }

      // reparent_node: echo {id,…,parentId} so the new-parent move is assertable.
      case 'reparent_node':
        result = {
          id: cmd.params?.nodeId as string,
          name: 'Card',
          type: 'FRAME',
          parentId: cmd.params?.parentId as string,
        }
        break

      // reorder_children: set-equality validate the requested ids against the
      // mock parent's fixed child set ['1:1','1:2','1:3']. A mismatch WARNS
      // (T7) and never errors. `order` mirrors the REAL plugin: it returns the
      // FULL post-reorder child list (parent.children.map(c=>c.id)) — i.e. the
      // requested ids that ARE children (in order) followed by the omitted
      // children in their original relative order. (Was: only the matched
      // subset — an infidelity the e2e asserted against.)
      case 'reorder_children': {
        const parentId = cmd.params?.parentId as string
        const requested =
          (cmd.params?.nodeIds as string[]) ?? []
        const actual = ['1:1', '1:2', '1:3']
        const actualSet = new Set(actual)
        const requestedSet = new Set(requested)
        const warnings: string[] = []
        const missing = requested.filter(
          id => !actualSet.has(id),
        )
        const extra = actual.filter(
          id => !requestedSet.has(id),
        )
        if (missing.length > 0 || extra.length > 0) {
          warnings.push(
            'reorder_children id set differs from the parent children: ' +
              'not children=[' +
              missing.join(',') +
              '], omitted=[' +
              extra.join(',') +
              ']. Only matching ids were reordered.',
          )
        }
        result = {
          parentId,
          order: [
            ...requested.filter(id => actualSet.has(id)),
            ...actual.filter(id => !requestedSet.has(id)),
          ],
          warnings,
        }
        break
      }

      // boolean_op: echo a BooleanOperationNode {id,name,type}; <2 nodes errors.
      case 'boolean_op': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        if (ids.length < 2) {
          error =
            'boolean_op requires at least 2 resolvable nodes.'
        } else {
          result = {
            id: `bool:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Union',
            type: 'BOOLEAN_OPERATION',
          }
        }
        break
      }

      // flatten: echo a VECTOR {id,name,type}; <1 node errors.
      case 'flatten': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        if (ids.length < 1) {
          error =
            'flatten requires at least 1 resolvable node.'
        } else {
          result = {
            id: `vec:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Vector',
            type: 'VECTOR',
          }
        }
        break
      }

      // group_nodes: echo a GROUP {id,name,type}; <1 node errors.
      case 'group_nodes': {
        const ids = (cmd.params?.nodeIds as string[]) ?? []
        if (ids.length < 1) {
          error =
            'group_nodes requires at least 1 resolvable node.'
        } else {
          result = {
            id: `grp:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Group',
            type: 'GROUP',
          }
        }
        break
      }

      // transform_group: echo a TRANSFORM_GROUP {id,name,type}; <1 node errors.
      // NOTE: the mock does NOT model figma.transformGroup runtime availability —
      // the feature-detect lives in the real plugin (code.ts). The mock proves
      // handler MECHANICS and schema routing only. The controller must live-verify
      // that figma.transformGroup actually exists in the Figma runtime.
      case 'transform_group': {
        const tgIds =
          (cmd.params?.nodeIds as string[]) ?? []
        if (tgIds.length < 1) {
          error =
            'transform_group requires at least 1 resolvable node.'
        } else {
          result = {
            id: `tg:${Math.random().toString(36).slice(2, 8)}`,
            name: 'Transform Group',
            type: 'TRANSFORM_GROUP',
          }
        }
        break
      }

      // create_component (PROMOTE-ONLY, un-overloaded per spec): promote the
      // given nodeId, echoing {id,key,name,type} + the source nodeId so the e2e
      // can assert routing. The build-from-spec overload was removed.
      case 'create_component': {
        const ccNodeId = cmd.params?.nodeId as
          | string
          | undefined
        const ccName = cmd.params?.name as
          | string
          | undefined
        result = {
          id: `comp:${Math.random().toString(36).slice(2, 8)}`,
          key: `key:${Math.random().toString(36).slice(2, 8)}`,
          name: ccName ?? 'Component',
          type: 'COMPONENT',
          // echo the source so tests can assert routing
          sourceNodeId: ccNodeId,
        }
        break
      }

      // update_component: echo {id, properties, slotsCreated, slotsSkipped,
      // warnings}. `properties` is the catalogue ARRAY of
      // {id,name,type,defaultValue,variantOptions?}. An `expose` list degrades
      // (warn, never error) — exposeNestedInstances is gated. A `slots` list
      // CREATES slot nodes (createSlotNode above) and applies each entry's
      // spec, so a later get_node reads what landed (B30); the componentId
      // prefixes below model the two slot degrade paths.
      // addComponentProperty returns a CANONICAL id (`<name>#<suffix>`)
      // that agents need for later setProperties, so the mock mirrors the real
      // plugin by carrying it inside each `properties` entry's `id` field.
      // Genuine {error} boundaries (mirroring the real plugin):
      //  - componentId `err:` → {error:'Component not found: …'} (not-found).
      //  - componentId `notcomp:` → {error:'Node is not a component …'} (the
      //    node resolves but is the wrong type).
      // Slot-path conventions (degrades, never errors):
      //  - componentId `noslot:` → createSlot unavailable in this Figma
      //    version: every name lands in slotsSkipped with the T7 warning.
      //  - componentId `noautolayout:` → the component is not an auto-layout
      //    frame, so a slot `sizing` is refused (warn + continue) while the
      //    slot is still created, named, and given its other fields.
      case 'update_component': {
        const ucId = cmd.params?.componentId as string
        if (ucId.startsWith('err:')) {
          error = `Component not found: ${ucId}`
          break
        }
        if (ucId.startsWith('notcomp:')) {
          error = `Node is not a component or component set: ${ucId}`
          break
        }
        const ucAdd = cmd.params?.add as
          | {
              name: string
              type: string
              defaultValue: string | boolean
              targetNodeId?: string
              field?:
                | 'characters'
                | 'visible'
                | 'mainComponent'
            }[]
          | undefined
        const ucExpose = cmd.params?.expose as
          | string[]
          | undefined
        const ucSlots = cmd.params?.slots as
          | (string | Record<string, unknown>)[]
          | undefined
        const ucDelete = cmd.params?.delete as
          | string[]
          | undefined
        const ucWarnings: string[] = []
        const defs = propsOf(ucId)
        if (ucAdd) {
          for (const p of ucAdd) {
            const canonical = `${p.name}#1:0`
            defs.set(canonical, {
              id: canonical,
              name: p.name,
              type: p.type,
              defaultValue: p.defaultValue,
            })
            // B3: if no targetNodeId, the property is unbound — emit the honest
            // warning that matches the real plugin's T7 contract.
            if (!p.targetNodeId) {
              ucWarnings.push(
                'property "' +
                  p.name +
                  '" added but no targetNodeId given — it is unbound and set_instance will be inert',
              )
            }
            // When targetNodeId IS present, the real plugin would set
            // componentPropertyReferences on the child. The mock cannot do that
            // (no live Figma node tree), so it simply skips — headless fidelity
            // boundary documented in comments.
          }
        }
        // delete (M22a) — mirrors the real plugin's arm exactly: resolve by the
        // canonical id OR by a bare name only one property carries, refuse an
        // ambiguous or unknown name by NAMING what is there, and re-read the
        // definitions afterwards so a removal Figma refused is reported rather
        // than passing as ok. A `lockedprops:` componentId models that refusal
        // (Figma keeps SLOT and set-variant properties) — a mock affordance,
        // since nothing headless can make Figma refuse.
        if (ucDelete) {
          for (const requested of ucDelete) {
            let key: string | undefined
            if (defs.has(requested)) {
              key = requested
            } else {
              const byName = [...defs.keys()].filter(
                k => barePropName(k) === requested,
              )
              if (byName.length === 1) {
                ;[key] = byName
              } else if (byName.length > 1) {
                ucWarnings.push(
                  `Failed to delete property: "${requested}" names ${byName.length} component properties (` +
                    byName.map(k => `"${k}"`).join(', ') +
                    ') — pass the full property id, not the bare name',
                )
                continue
              } else {
                const known = [...defs.keys()]
                ucWarnings.push(
                  `Failed to delete property: no component property named "${requested}"` +
                    (known.length === 0
                      ? ' — this component has none'
                      : ' — this component has: ' +
                        known
                          .map(k => `"${k}"`)
                          .join(', ')),
                )
                continue
              }
            }
            if (ucId.startsWith('lockedprops:')) {
              ucWarnings.push(
                `component property "${key}" is still defined after deleteComponentProperty — ` +
                  'Figma refused the removal (a SLOT property and a variant property of a set ' +
                  'are the known cases). Remove it from the component panel in Figma.',
              )
              continue
            }
            defs.delete(key)
          }
        }
        if (ucExpose && ucExpose.length > 0) {
          ucWarnings.push(
            'exposeNestedInstances unavailable in this Figma version; expose skipped',
          )
        }
        // slots: a bare string is a name and nothing else (back-compat); an
        // object entry carries the CONVERTED spec, which createSlotNode applies
        // to the fresh slot. `noslot:` models the T7 unavailable-createSlot
        // degrade the real plugin feature-detects.
        const slotsCreated: string[] = []
        const slotsSkipped: string[] = []
        if (ucSlots && ucSlots.length > 0) {
          // Read each entry once, the way the plugin's readSlotEntry does: a
          // bare string is a name with no spec; an object carries both.
          const ucSlotEntries = ucSlots.map(entry =>
            typeof entry === 'string'
              ? { name: entry, spec: undefined }
              : {
                  name:
                    typeof entry.name === 'string'
                      ? entry.name
                      : '',
                  spec: entry,
                },
          )
          if (ucId.startsWith('noslot:')) {
            slotsSkipped.push(
              ...ucSlotEntries.map(e => e.name),
            )
            ucWarnings.push(
              'createSlot unavailable in this Figma version; slot(s) not created',
            )
          } else {
            const ucAutoLayout =
              !ucId.startsWith('noautolayout:')
            for (const { name, spec } of ucSlotEntries) {
              createSlotNode(
                name,
                spec,
                ucWarnings,
                ucAutoLayout,
              )
              slotsCreated.push(name)
            }
          }
        }
        result = {
          id: ucId,
          // The list AFTER the call, never just what this call added — that is
          // what `projectComponentDefs(comp.componentPropertyDefinitions)`
          // returns, and it is what makes add → remove → enumerate provable.
          properties: [...defs.values()],
          slotsCreated,
          slotsSkipped,
          warnings: ucWarnings,
        }
        break
      }

      // combine_variants: ids that aren't valid COMPONENTs are DROPPED with a
      // warning (honest partial success — never silently swallowed), mirroring
      // the real plugin. ≥2 SURVIVORS → a COMPONENT_SET; <2 → error (guarded
      // server-side too). The mock treats `bad:`-prefixed ids as not-a-component.
      // The set's `key` is returned (read/write symmetry). A `noaxis:`-prefixed
      // KEPT id models a component whose name lacks the "Property=Value" axis
      // convention → the MULTI-AXIS warning (T7/T9), faithful to the real plugin
      // checking the source names.
      case 'combine_variants': {
        const cvIds =
          (cmd.params?.componentIds as string[]) ?? []
        const cvWarnings: string[] = []
        const cvDropped = cvIds.filter(id =>
          id.startsWith('bad:'),
        )
        const cvKept = cvIds.filter(
          id => !id.startsWith('bad:'),
        )
        if (cvDropped.length > 0) {
          cvWarnings.push(
            'combine_variants ignored ' +
              cvDropped.length +
              ' id(s) that are not a COMPONENT: ' +
              cvDropped.join(', '),
          )
        }
        if (cvKept.length < 2) {
          error =
            'Need at least 2 components for combine_variants'
          break
        }
        // Multi-axis nudge: KEPT ids prefixed `noaxis:` model component names
        // lacking the "Property=Value" axis convention.
        const cvUnaxised = cvKept.filter(id =>
          id.startsWith('noaxis:'),
        )
        if (cvUnaxised.length > 0) {
          cvWarnings.push(
            'combine_variants: ' +
              cvUnaxised.length +
              ' component name(s) do not use the "Property=Value" axis convention (' +
              cvUnaxised.join(', ') +
              '); the variant set will not form a clean axis set. Name each variant one property per axis (e.g. "Style=Primary, Size=Large").',
          )
        }
        // A `nogood:` parent can't bear children → fall back to the first
        // component's parent, but REPORT it (no silent fallback), mirroring the
        // real plugin.
        const cvParentId = cmd.params?.parentId as
          | string
          | undefined
        if (cvParentId?.startsWith('nogood:')) {
          cvWarnings.push(
            'Requested parent "' +
              cvParentId +
              '" cannot contain the variant set; used the first component\'s parent instead.',
          )
        }
        result = {
          id: `cs:${Math.random().toString(36).slice(2, 8)}`,
          key: `cskey:${Math.random().toString(36).slice(2, 8)}`,
          name:
            (cmd.params?.name as string) ?? 'VariantSet',
          type: 'COMPONENT_SET',
          variantAxes: { Variant: { values: ['Default'] } },
          warnings: cvWarnings,
        }
        break
      }

      // swap_component: echo {id, mainComponent, warnings}. Remote-capable,
      // faithful to the real plugin:
      //  - LOCAL mainComponentId WINS if both it and `key` are given.
      //  - REMOTE `key` (no mainComponentId) is resolved via
      //    importComponentByKeyAsync. A key prefixed `importfail:` models a
      //    FAILED import → degrade ({mainComponent:null, warning}), NEVER {error};
      //    else the imported main id is derived (`key` → `imported:<key>`).
      //  - instanceId `degrade:` models a FAILED swap (T7): the real plugin
      //    re-reads getMainComponentAsync() → the ORIGINAL main (swap never took),
      //    so the mock echoes `orig:<id>`, NOT the requested target.
      case 'swap_component': {
        const scId = cmd.params?.instanceId as string
        const scMainId = cmd.params?.mainComponentId as
          | string
          | undefined
        const scKey = cmd.params?.key as string | undefined
        const scWarnings: string[] = []
        // Resolve the target main: LOCAL wins; else import by key.
        let target: string | null
        if (scMainId !== undefined) {
          target = scMainId
        } else if (scKey !== undefined) {
          if (scKey.startsWith('importfail:')) {
            result = {
              id: scId,
              mainComponent: null,
              warnings: [
                'importComponentByKeyAsync failed for key "' +
                  scKey +
                  '": import error; remote swap skipped',
              ],
            }
            break
          }
          target = 'imported:' + scKey
        } else {
          error =
            'swap_component requires mainComponentId (local) or key (remote)'
          break
        }
        const degraded = scId?.startsWith('degrade:')
        if (degraded) {
          scWarnings.push(
            'swapComponent failed: feature unavailable',
          )
        }
        result = {
          id: scId,
          mainComponent: degraded
            ? 'orig:' + scId.slice('degrade:'.length)
            : target,
          warnings: scWarnings,
        }
        break
      }

      // set_instance: echo {id, componentProperties, warnings}. overrides → warn
      // (not applied). The real plugin returns the RAW Figma
      // inst2.componentProperties — a NESTED map { [name]: { value, type } }
      // (VARIANT and non-VARIANT props mixed, value wrapped) — NOT the flat
      // input. The mock stays FAITHFUL to that raw plugin shape; the SERVER now
      // splits it into the read-twin { variantProperties?, componentProperties? }
      // shape (C3 — flatten-to-read-twin landed). Infer type from the value
      // kind: boolean → BOOLEAN, string → VARIANT (the common case in tests).
      case 'set_instance': {
        const siId = cmd.params?.instanceId as string
        const siProps = cmd.params?.properties as
          | Record<string, string | boolean>
          | undefined
        const siOverrides = cmd.params?.overrides as
          | unknown[]
          | undefined
        const siWarnings: string[] = []
        // Mirror the real plugin's T7 no-op warning: a call with neither
        // properties nor overrides mutates nothing and must warn.
        if (
          (!siProps || Object.keys(siProps).length === 0) &&
          (!siOverrides || siOverrides.length === 0)
        ) {
          siWarnings.push(
            'no properties or overrides supplied; nothing changed',
          )
        }
        if (siOverrides && siOverrides.length > 0) {
          siWarnings.push(
            'Per-node overrides are not yet applied; ' +
              siOverrides.length +
              ' override(s) skipped',
          )
        }
        // Mirror the real plugin's #11 name → exact-key resolution: friendly
        // names resolve to "#id" keys (or warn + skip), and only the resolved
        // keys are echoed back in componentProperties.
        const {
          resolved: siResolved,
          warnings: siResolveWarnings,
        } = mockResolveInstanceProps(
          siProps ?? {},
          MOCK_INSTANCE_KEYS,
        )
        siWarnings.push(...siResolveWarnings)
        const siNested: Record<
          string,
          { value: string | boolean; type: string }
        > = {}
        for (const [k, v] of Object.entries(siResolved)) {
          siNested[k] = {
            value: v,
            type:
              typeof v === 'boolean'
                ? 'BOOLEAN'
                : 'VARIANT',
          }
        }
        result = {
          id: siId,
          componentProperties: siNested,
          warnings: siWarnings,
        }
        break
      }

      case 'create_from_svg': {
        const svgName =
          (cmd.params?.name as string) ?? 'SVG'
        result = {
          id: `svg:${Math.random().toString(36).slice(2, 8)}`,
          name: svgName,
          type: 'FRAME',
          childCount: 3,
        }
        break
      }

      // delete_node: echo {id,name,type} (captured before removal).
      // PAGE branch — backed by a small in-mock page array:
      //   page:only   → last-page {error} (T7)
      //   page:current → switch-then-remove; returns currentPageId
      //   page:noncurrent → remove non-current page; returns currentPageId
      //   page:noapi   → setCurrentPageAsync absent degrade (warns, skips remove)
      //   anything else → ordinary FRAME reply (default mock node)
      case 'delete_node': {
        const dnNodeId = cmd.params?.nodeId as string
        // Mock page registry: two pages, page:current is active.
        const mockPages = [
          { id: 'page:current', name: 'Page 1' },
          { id: 'page:other', name: 'Page 2' },
        ]
        if (dnNodeId === 'page:only') {
          result = {
            error:
              'Cannot delete the last remaining page: ' +
              dnNodeId,
          }
          break
        }
        if (dnNodeId === 'page:noapi') {
          result = {
            id: 'page:noapi',
            name: 'Page 1',
            type: 'PAGE',
            warnings: [
              'setCurrentPageAsync unavailable; current page not switched — remove skipped',
            ],
          }
          break
        }
        if (
          dnNodeId === 'page:current' ||
          dnNodeId === 'page:noncurrent'
        ) {
          const deletedPage = mockPages.find(
            p => p.id === dnNodeId,
          )
          // After removing page:current, current switches to page:other.
          // After removing page:noncurrent (page:other), current stays page:current.
          const newCurrentId =
            dnNodeId === 'page:current'
              ? 'page:other'
              : 'page:current'
          result = {
            id: dnNodeId,
            name: deletedPage?.name ?? 'Page',
            type: 'PAGE',
            currentPageId: newCurrentId,
          }
          break
        }
        result = {
          id: dnNodeId,
          name: 'Card',
          type: 'FRAME',
        }
        break
      }

      // set_focus: CANVAS only — echo a viewport snapshot. Models the real
      // plugin's resolution + T7 honesty: an id that does not resolve to a scene
      // node (mirrored here by a `missing:` prefix) is reported in warnings[]
      // rather than silently dropped, and requested/focused expose the counts.
      case 'set_focus': {
        const sfIds =
          (cmd.params?.nodeIds as string[]) ?? []
        const sfMissing = sfIds.filter(id =>
          id.startsWith('missing:'),
        )
        const sfFocused = sfIds.length - sfMissing.length
        result = {
          viewport: { center: { x: 0, y: 0 }, zoom: 1 },
          requested: sfIds.length,
          focused: sfFocused,
          warnings:
            sfMissing.length > 0
              ? [
                  'set_focus: ' +
                    sfMissing.join(', ') +
                    ' did not resolve to a scene node and were skipped',
                ]
              : [],
        }
        break
      }

      // create_page: echo the new page id + the requested name.
      case 'create_page':
        result = {
          id: 'page:new',
          name: cmd.params?.name as string,
        }
        break

      // set_current_page: echo the switched-to page.
      case 'set_current_page':
        result = {
          currentPage: {
            id: cmd.params?.pageId as string,
            name: 'Switched',
          },
        }
        break

      // duplicate_page: echo the clone id + the (optional) rename.
      case 'duplicate_page':
        result = {
          id: 'page:dup',
          name: (cmd.params?.name as string) ?? 'Copy',
        }
        break

      // create_image: a url starting with `degrade:` exercises the T7 degrade
      // (warnings, NO hash, NO error → success-with-warning); an empty `bytes`
      // array models the bytes-path degrade (invalid bytes/feature unavailable)
      // faithfully to the real plugin's own bytes try/catch; else a hash.
      case 'create_image': {
        const imgUrl = cmd.params?.url as string | undefined
        const imgBytes = cmd.params?.bytes as
          | number[]
          | undefined
        if (imgUrl?.startsWith('degrade:')) {
          result = {
            warnings: [
              'createImageAsync failed (network/feature unavailable): degrade requested',
            ],
          }
        } else if (
          imgBytes !== undefined &&
          imgBytes.length === 0
        ) {
          // Mirror the real plugin's bytes-path degrade, which appends the
          // underlying reason (`: ` + String(e)) — keep the suffix so the mock
          // is byte-faithful to the plugin's actual message shape.
          result = {
            warnings: [
              'createImage failed (invalid bytes/feature unavailable): empty byte array',
            ],
          }
        } else if (
          imgUrl !== undefined ||
          imgBytes !== undefined
        ) {
          result = { hash: 'img:abc123' }
        } else {
          error = 'create_image requires url or bytes'
        }
        break
      }

      // set_plugin_data: echo {id}. The figmabridge/context escape hatch writes
      // straight to the shared store with NO cap (the cap is server-side only,
      // so this proves over-cap values are read-only). value === '' clears.
      case 'set_plugin_data': {
        const spNodeId = cmd.params?.nodeId as string
        if (
          cmd.params?.namespace === 'figmabridge' &&
          cmd.params?.key === 'context'
        ) {
          const spValue = cmd.params?.value as string
          if (spValue === '') {
            sharedContext.delete(spNodeId)
          } else {
            sharedContext.set(spNodeId, spValue)
          }
        }
        result = { id: spNodeId }
        break
      }

      // set_reactions: a nodeId starting with `degrade:` exercises the T7
      // unavailable-API degrade ({id,warnings}, NEVER {error}); else {id,[]}.
      case 'set_reactions': {
        const rNodeId = cmd.params?.nodeId as string
        result = rNodeId.startsWith('degrade:')
          ? {
              id: rNodeId,
              warnings: [
                'setReactionsAsync unavailable in this Figma version; reactions not set',
              ],
            }
          : { id: rNodeId, warnings: [] }
        break
      }

      // set_annotations: a nodeId starting with `degrade:` exercises the T7
      // editor-gated degrade ({id,warnings}, NEVER {error}); else {id,[]}.
      case 'set_annotations': {
        const aNodeId = cmd.params?.nodeId as string
        result = aNodeId.startsWith('degrade:')
          ? {
              id: aNodeId,
              warnings: [
                'Annotations API unavailable in this editor; annotations not set',
              ],
            }
          : { id: aNodeId, warnings: [] }
        break
      }

      // create_variables: the server has CONVERTED COLOR values to {r,g,b,a}
      // (FLOAT/STRING/BOOLEAN pass through). Echo the converted variables back
      // (as `echo`) so the e2e can assert the parse + the E1 fields (aliases /
      // scopes / codeSyntax / hiddenFromPublishing) reached the plugin, and
      // mirror the real reply { collectionId, modes, variables:[{id,name}] }.
      // T7: a collection name prefixed `err:` models the collection-level
      // factory THROWING — a genuine failure (nothing to return) → {error}, not
      // a degrade. A variable name prefixed `degrade:` models a per-variable
      // create / setValueForMode failure — it degrades to a warning and the rest
      // of the batch continues (never a throw, never {error}). E1: an `aliases`
      // target id prefixed `missing:` models alias-target-not-found (the SHARED
      // per-variable apply path's T7 degrade — warned, never thrown).
      case 'create_variables': {
        const collectionName = cmd.params?.collection as
          | string
          | undefined
        const collectionAddr = cmd.params?.collectionId as
          | string
          | undefined
        // I63 — the real plugin resolves the target BEFORE it makes anything
        // (variable-collection-target.ts). The mock models the three answers
        // that change the reply: an unknown id is a miss, an ambiguous name is
        // refused, and a name a collection already carries EXTENDS it. The
        // document it models: one collection `col:existing` named `existing`
        // holding `held/token`, plus two forks both named `forked`.
        if (collectionAddr !== undefined) {
          if (collectionAddr !== 'col:existing') {
            error = `Collection not found: ${collectionAddr}`
            break
          }
        } else if (collectionName === undefined) {
          error =
            'create_variables needs a collection: pass `collection` (a name) or `collectionId` (an exact address).'
          break
        } else if (collectionName === 'forked') {
          error =
            'more than one variable collection is named "forked" in this file (col:f1, col:f2), so the name addresses none of them. Pass collectionId to say which one to extend, or delete_variables the forks first.'
          break
        }
        const extending =
          collectionAddr !== undefined ||
          collectionName === 'existing'
        if (
          collectionName !== undefined &&
          collectionName.startsWith('err:')
        ) {
          error = `createVariableCollection failed for "${collectionName}"`
          break
        }
        const inVars =
          (cmd.params?.variables as
            | {
                name: string
                type: string
                valuesByMode: Record<string, unknown>
                aliases?: Record<string, string>
                scopes?: string[]
                codeSyntax?: Record<string, string>
                hiddenFromPublishing?: boolean
              }[]
            | undefined) ?? []
        const reqModes =
          (cmd.params?.modes as string[] | undefined) ?? []
        // The default mode is renamed to reqModes[0] when given, else 'Mode 1'.
        // An EXTEND renames nothing (I63): the existing mode `Light` stays and
        // a requested mode it lacks is appended.
        const modeNames = extending
          ? [
              'Light',
              ...reqModes.filter(m => m !== 'Light'),
            ]
          : reqModes.length > 0
            ? reqModes
            : ['Mode 1']
        const warnings: string[] = []
        if (extending) {
          warnings.push(
            `create_variables added these variables to the existing collection "existing" (col:existing) instead of creating a second one with the same name. Pass collectionId to target a collection exactly, or a different \`collection\` name to start a new one.`,
          )
        }
        // Mirror the real plugin's T7 renameMode-unavailable warning: a
        // collection name prefixed `norename:` models renameMode being absent,
        // so the default mode keeps its name and a warning rides back.
        if (
          collectionName?.startsWith('norename:') ===
            true &&
          reqModes.length > 0
        ) {
          warnings.push(
            `renameMode unavailable in this Figma version; default mode not renamed to "${reqModes[0]}"`,
          )
        }
        const created: { id: string; name: string }[] = []
        inVars.forEach((v, i) => {
          if (v.name.startsWith('degrade:')) {
            warnings.push(
              `setValueForMode failed for variable "${v.name}"; value not set`,
            )
            return
          }
          // I63 — a name the TARGET collection already holds is skipped and
          // named, never created a second time. The modelled `existing`
          // collection holds `held/token`.
          if (extending && v.name === 'held/token') {
            warnings.push(
              `variable "${v.name}" already exists in "existing" and was NOT created again — a second variable of the same name in one collection makes the name ambiguous. Change its value with update_variables, or create it under a different name.`,
            )
            return
          }
          // E1: model the shared per-variable apply path's alias-target-not-found
          // degrade (an aliases target id prefixed `missing:`).
          for (const [modeName, targetId] of Object.entries(
            v.aliases ?? {},
          )) {
            if (targetId.startsWith('missing:')) {
              warnings.push(
                `alias target not found: ${targetId} for variable "${v.name}"`,
              )
            } else {
              void modeName
            }
          }
          created.push({ id: `var:${i + 1}`, name: v.name })
        })
        result = {
          collectionId: extending
            ? 'col:existing'
            : 'col:new',
          modes: modeNames.map((name, i) => ({
            modeId: `m${i + 1}`,
            name,
          })),
          variables: created,
          warnings,
          echo: inVars,
        }
        break
      }

      // update_variables: a collectionId starting with `err:` → {error};
      // `degrade:` → success-with-warning. Else echo the (converted) edits +
      // mode lifecycle back so the e2e can assert the parse + forwarding. T7: a
      // VARIABLE id prefixed `degrade:` models a setValueForMode REJECTION (e.g.
      // a type-incompatible value reaching a COLOR variable) — it degrades to a
      // warning-on-success, never a throw, never {error}.
      case 'update_variables': {
        const colId = cmd.params?.collectionId as string
        if (colId.startsWith('err:')) {
          error = `Collection not found: ${colId}`
        } else if (colId.startsWith('degrade:')) {
          result = {
            collectionId: colId,
            modes: [],
            warnings: [
              'addMode unavailable in this Figma version; mode not added',
            ],
          }
        } else {
          const editVars =
            (cmd.params?.variables as
              | { id: string }[]
              | undefined) ?? []
          const warnings: string[] = []
          // Mirror the real plugin's T7 renameMode-failure degrade: a
          // renameModes entry whose `from` is prefixed `degrade:` models a
          // duplicate/invalid rename throwing — warned, never {error}.
          const renameModes =
            (cmd.params?.renameModes as
              | { from: string; to: string }[]
              | undefined) ?? []
          for (const rename of renameModes) {
            if (rename.from.startsWith('degrade:')) {
              warnings.push(
                `renameMode failed for "${rename.from}" → "${rename.to}": duplicate mode name`,
              )
            }
          }
          for (const edit of editVars) {
            if (edit.id.startsWith('degrade:')) {
              warnings.push(
                `setValueForMode failed for variable ${edit.id}; value not set`,
              )
            }
          }
          result = {
            collectionId: colId,
            modes: [{ modeId: 'm1', name: 'Default' }],
            warnings,
            echo: {
              addModes: cmd.params?.addModes,
              removeModes: cmd.params?.removeModes,
              renameModes: cmd.params?.renameModes,
              variables: cmd.params?.variables,
            },
          }
        }
        break
      }

      // delete_variables: PARTIAL SUCCESS over variable ids and collection ids.
      // Collections first (real cascade order). An id prefixed `err:` models
      // not-found (per-id error, never aborts the rest). An id prefixed
      // `nofn:` models the T7 feature-detect path (remove() absent → per-id
      // error). All others → success result with kind='variable'|'collection'.
      // Returns { results:[{id, kind}], errors:[{id, error}] }.
      case 'delete_variables': {
        const dvResults: { id: string; kind: string }[] = []
        const dvErrors: { id: string; error: string }[] = []
        for (const colId of (cmd.params?.collections as
          | string[]
          | undefined) ?? []) {
          if (colId.startsWith('err:')) {
            dvErrors.push({
              id: colId,
              error: `Collection not found: ${colId}`,
            })
          } else if (colId.startsWith('nofn:')) {
            dvErrors.push({
              id: colId,
              error: `remove() unavailable on collection ${colId}`,
            })
          } else {
            dvResults.push({
              id: colId,
              kind: 'collection',
            })
          }
        }
        for (const varId of (cmd.params?.variables as
          | string[]
          | undefined) ?? []) {
          if (varId.startsWith('err:')) {
            dvErrors.push({
              id: varId,
              error: `Variable not found: ${varId}`,
            })
          } else if (varId.startsWith('nofn:')) {
            dvErrors.push({
              id: varId,
              error: `remove() unavailable on variable ${varId}`,
            })
          } else {
            dvResults.push({ id: varId, kind: 'variable' })
          }
        }
        result = { results: dvResults, errors: dvErrors }
        break
      }

      // create_styles: array-create with PARTIAL SUCCESS. The server has
      // CONVERTED each entry's value atom (paint→Paint, text→FontName,
      // effect→Effect, grid→LayoutGrid). Loop, mirroring the real plugin's
      // { results:[{id,key,name,type,index}], errors:[{index,error}] }. A style
      // `name` prefixed `err:` models a per-entry create failure (degrade, not
      // abort). Each result carries the entry's `value` as `echo` so conversion
      // assertions still round-trip.
      case 'create_styles': {
        const csEntries =
          (cmd.params?.styles as
            | {
                index: number
                type: string
                name: string
                value: unknown
                description?: string
              }[]
            | undefined) ?? []
        const csResults: unknown[] = []
        const csErrors: { index: number; error: string }[] =
          []
        for (const e of csEntries) {
          if (e.name.startsWith('err:')) {
            csErrors.push({
              index: e.index,
              error: `create${e.type}Style unavailable`,
            })
            continue
          }
          csResults.push({
            id: `S:${e.index}`,
            key: 'style-key',
            name: e.name,
            type: e.type,
            index: e.index,
            echo: e.value,
          })
        }
        result = { results: csResults, errors: csErrors }
        break
      }

      // update_styles: array-edit with PARTIAL SUCCESS. Each entry is keyed by
      // its `id` (mirrors the real plugin's lookup). Per-entry models:
      //  - id `err:` → {index,error} not-found (does NOT abort the rest).
      //  - id `degrade:` → {index,error} category mismatch (value not applied;
      //    newName/description were).
      //  - id `fontfail:` → {index,error} partial write (newName/description
      //    committed, the TEXT value branch's loadFontAsync threw).
      //  - else → {id,index} success.
      case 'update_styles': {
        const usEntries =
          (cmd.params?.styles as
            | {
                index: number
                id?: string
                name?: string
                value?: { family?: string; style?: string }
              }[]
            | undefined) ?? []
        const usResults: { id: string; index: number }[] =
          []
        const usErrors: {
          index: number
          error: string
        }[] = []
        for (const e of usEntries) {
          const sId = e.id ?? e.name ?? ''
          if (sId.startsWith('err:')) {
            usErrors.push({
              index: e.index,
              error: `Style not found: ${sId}`,
            })
          } else if (sId.startsWith('degrade:')) {
            usErrors.push({
              index: e.index,
              error:
                'value looks like a paint atom but the style is text; value not applied (newName/description were updated)',
            })
          } else if (sId.startsWith('fontfail:')) {
            usErrors.push({
              index: e.index,
              error: `font "${e.value?.family} ${e.value?.style}" unavailable; value not applied (newName/description were updated)`,
            })
          } else {
            usResults.push({ id: sId, index: e.index })
          }
        }
        result = { results: usResults, errors: usErrors }
        break
      }

      // delete_styles: PARTIAL SUCCESS over style entries. Each entry is addressed
      // by `id` (or `name`+`type` via the mock's sId = e.id ?? e.name). Per-entry
      // models:
      //  - id (or name) prefixed `err:` → {index,error} not-found (does NOT abort
      //    the rest).
      //  - id (or name) prefixed `nofn:` → {index,error} T7 remove()-unavailable.
      //  - else → {id,index} success.
      // Returns { results:[{id,index}], errors:[{index,error}] }.
      case 'delete_styles': {
        const dsEntries =
          (cmd.params?.styles as
            | {
                index: number
                id?: string
                name?: string
                type?: string
              }[]
            | undefined) ?? []
        const dsResults: { id: string; index: number }[] =
          []
        const dsErrors: { index: number; error: string }[] =
          []
        for (const e of dsEntries) {
          const sId = e.id ?? e.name ?? ''
          if (sId.startsWith('err:')) {
            dsErrors.push({
              index: e.index,
              error: `Style not found: ${sId}`,
            })
          } else if (sId.startsWith('nofn:')) {
            dsErrors.push({
              index: e.index,
              error: `remove() unavailable on style ${sId}`,
            })
          } else {
            dsResults.push({ id: sId, index: e.index })
          }
        }
        result = { results: dsResults, errors: dsErrors }
        break
      }

      // apply_style boundary (mirrors the real plugin):
      //  - nodeId `err:` → {error} node-not-found.
      //  - styleId `missing:` → {error} style-not-found (a GENUINE invalid, not
      //    a degrade).
      //  - styleId `wrongcat:` → {error} category mismatch (genuine invalid).
      //  - nodeId `degrade:` → success-with-warning (setter unavailable on the
      //    node type — a true degrade), NEVER {error}.
      //  - else {id,[]} happy.
      case 'apply_style': {
        const apNodeId = cmd.params?.nodeId as string
        const apStyleId = cmd.params?.styleId as string
        const apField = cmd.params?.field as string
        if (apNodeId.startsWith('err:')) {
          error = `Node not found: ${apNodeId}`
        } else if (apStyleId.startsWith('missing:')) {
          error = `Style not found: ${apStyleId}`
        } else if (apStyleId.startsWith('wrongcat:')) {
          error = `Style category mismatch: field "${apField}" expects a TEXT style but ${apStyleId} is a PAINT style`
        } else if (apNodeId.startsWith('degrade:')) {
          result = {
            id: apNodeId,
            warnings: [
              'setTextStyleIdAsync unavailable on FRAME; style not applied',
            ],
          }
        } else {
          result = { id: apNodeId, warnings: [] }
        }
        break
      }

      default:
        error = 'Unknown command'
        break
    }

    return { result, error }
  }

  const handleBroadcast = (
    socket: WebSocket,
    cmd: CommandMessage,
  ): void => {
    const requestId = cmd.meta?.requestId
    const isPing = cmd.command === COMMANDS.PING
    if (isPing) {
      pingCount += 1
    }

    // L5 silent mode: withhold EVERY reply, incl. ping — models a fully dead
    // plugin/socket for the L6 watchdog tests. Nothing is sent, ever.
    //
    // A HELD command is the exception, and the two compose deliberately:
    // silence models a socket that answers nothing, holding models a reply
    // that exists but has not been delivered yet. The L6 race needs both at
    // once — pings going unanswered while the command's reply is still
    // outstanding — so a held command falls through to be parked below.
    if (silent && !heldCommands.has(cmd.command ?? '')) {
      return
    }

    // Liveness ping bypasses the identity guard below AND the delay map,
    // faithful to the real plugin: useRelay.ts answers ping unconditionally in
    // the UI iframe layer, above both the target-guard check and the
    // main-thread command dispatch — so a busy-but-alive plugin still pongs.
    if (isPing) {
      const { result, error } = runCommand(
        cmd.command!,
        cmd.params,
      )
      const resolved: CommandMessage =
        error !== undefined
          ? { meta: { requestId }, error }
          : { meta: { requestId }, result }
      socket.send(
        JSON.stringify({
          type: 'message',
          channel,
          message: resolved,
        } satisfies ChannelMessage),
      )
      return
    }

    // B3 identity guard (mirrors the real plugin's code.ts, via the same
    // shared isTargetMismatch/targetGuardError): a command whose meta.fileKey ≠
    // this plugin's fileKey is refused with a byte-identical typed error and NOT
    // executed. Only fires when this plugin knows its own fileKey AND the
    // command carries a target — when either is null the guard can't verify and
    // degrades honestly (executes), faithful to the undefined-figma.fileKey path.
    if (isTargetMismatch(fileKey, cmd.meta?.fileKey)) {
      const refusal: ChannelMessage = {
        type: 'message',
        channel,
        message: {
          meta: { requestId },
          result: {
            error: targetGuardError(
              String(cmd.meta?.fileKey),
              String(fileKey),
            ),
          },
        },
      }
      socket.send(JSON.stringify(refusal))
      return
    }

    const sendReply = (): void => {
      const { result, error } = runCommand(
        cmd.command!,
        cmd.params,
      )

      // The real Figma plugin replies with { meta:{requestId}, result|error }
      // and NO command (see figma-plugin/src/hooks/useRelay.ts). Mirror that
      // here so the mock exercises the real response shape through the
      // relay's validation.
      const resolved: CommandMessage =
        error !== undefined
          ? { meta: { requestId }, error }
          : { meta: { requestId }, result }

      const reply: ChannelMessage = {
        type: 'message',
        channel,
        message: resolved,
      }

      socket.send(JSON.stringify(reply))
    }

    // L5 delay knob: a command present in `delayedCommands` has its reply
    // deferred by the mapped ms (models a slow-but-alive plugin). Absent (the
    // default) → immediate synchronous reply, unchanged from before L5.
    // L6 hold knob takes precedence over the delay knob: park the reply and
    // let the test decide the instant it lands.
    if (heldCommands.has(cmd.command!)) {
      heldReplies.push(sendReply)
      return
    }
    const delayMs = delayedCommands.get(cmd.command!)
    if (delayMs !== undefined) {
      setTimeout(sendReply, delayMs)
    } else {
      sendReply()
    }
  }

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(relayUrl)
      let joined = false

      socket.onerror = () => {
        reject(new Error('Mock plugin connection failed'))
      }

      socket.onopen = () => {
        ws = socket

        socket.onmessage = event => {
          let raw: SystemMessage | BroadcastMessage

          try {
            raw = JSON.parse(event.data as string) as
              | SystemMessage
              | BroadcastMessage
          } catch {
            return
          }

          if (raw.type === 'system' && !joined) {
            joined = true

            const registerMsg: RegisterMessage = {
              type: 'register',
              channel,
              fileKey,
              fileName: documentName ?? null,
              version,
              epoch,
            }
            socket.send(JSON.stringify(registerMsg))

            resolve()

            return
          }

          if (raw.type === 'broadcast') {
            handleBroadcast(socket, raw.message)
          }
        }

        const joinMsg: JoinMessage = {
          type: 'join',
          channel,
        }

        socket.send(JSON.stringify(joinMsg))
      }
    })

  const stop = (): void => {
    if (ws !== null) {
      ws.close()
      ws = null
    }
  }

  const setSilent = (value: boolean): void => {
    silent = value
  }

  const delayCommand = (
    command: string,
    delayMs: number,
  ): void => {
    delayedCommands.set(command, delayMs)
  }

  const pings = (): number => pingCount

  const holdCommand = (command: string): void => {
    heldCommands.add(command)
  }

  // Fire every parked reply and clear the queue. Returns the count so a test
  // can assert it actually held something — a release of zero means the case
  // it meant to arm never armed, which would make the assertion vacuous.
  const releaseHeld = (): number => {
    const n = heldReplies.length
    for (const send of heldReplies.splice(0)) {
      send()
    }
    return n
  }

  return {
    start,
    stop,
    setSilent,
    delayCommand,
    pings,
    holdCommand,
    releaseHeld,
  }
}
