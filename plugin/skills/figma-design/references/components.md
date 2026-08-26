---
name: figma-design/components
description: Component-modeling doctrine for the figma-design skill — what becomes a component and when, variants vs booleans, slots vs visibility toggles, and what to build last. Load before creating any component, variant, or slot.
---

# Component modeling reference

What to model as a component, **when** to create it, and which mechanism carries which kind
of variation. The calls themselves — `combine_variants`' axes, instance text overrides,
`update_component`'s property binding — are in `mechanics.md`; this file is the decision that
comes before them.

---

## 1. A component exists before it is placed

The moment you know a thing repeats, or that it carries named states, create the master
**first** and place instances after. Never build one, copy it five times, and promote
something later.

- **Author the master once** — `create_node` / `create_tree` the anatomy, then
  `create_component({nodeId, name})` on it.
- **Place instances** — one per occurrence:

```json
{
  "spec": {
    "type": "INSTANCE",
    "component": { "id": "<masterId>" },
    "name": "ActivityRow"
  },
  "parentId": "<listId>"
}
```

The read-back is the proof: an instance comes back `type: INSTANCE` with a `component`
reference; a hand-built copy comes back `type: FRAME`.

**Why the order is not a matter of taste.** Promote-later is _irreversible_ in the place it
matters most: Figma refuses to componentize a node that lives inside a SLOT — the call comes
back with Figma's own refusal, `Cannot create component from node` — while placing an
INSTANCE into a slot works normally. Nothing warns you on the way in. By the time the refusal
arrives, the thing is built, filled and positioned inside the slot, and the only way out is
to rebuild it outside the slot, componentize it there, and re-place it. Getting the order
right costs one extra call; getting it wrong costs the subtree.

The copy-and-reconcile version fails more quietly: five hand-built rows are five things to
change on every later edit, they drift the first time one is touched, and no tool tells you
they were meant to be one thing.

---

## 2. What must be a component — the litmus

Run four questions on every construction. ANY yes makes it a component,
created before placement (§1). All four no let it stay a frame — and you
write the four NOs down (the census, SKILL.md).

- **Q0 — Block.** Is it a screen-level block — a direct child of a
  screen's content region? Then it is a component, even at one
  occurrence. No judgment here: blocks and shells repeat by role across
  screens and products, and the reviewer checks this in one sweep.
- **Q1 — Reuse.** Can it be reused, and is the reuse worth it? The reuse
  is worth it when ANY of these holds:
  - **Propagation** — a later change to it should reach every copy.
  - **Next screen** — the product's next screen could plausibly carry it.
  - **Workbench** — someone would take it alone: export it as a PNG for
    development, drag an instance to squeeze-test its sizing without
    dragging the whole screen, hand it off as one unit.
- **Q2 — States.** Does it carry states — hover, active, selected,
  disabled, loading, or variant looks?
- **Q3 — Role or asset.** Is it a pattern the web has a name for —
  banner, dialog, toast, pagination, breadcrumb, tab bar, close control?
  Or is it an icon, logo, glyph, or identity mark? **Assets are
  components always, no questions asked.**

Worked against real cases: a hero banner passes Q0 (and Q1 propagation,
Q3) at one occurrence. A close control passes Q3 — the asset clause, not
a repeat count. A chart's plot interior fails all four and stays a frame.

**Two decisions, not one.** The litmus decides component-or-frame. WHERE
the master lives is the placement rule (SKILL.md, *Organize the file*): a
master one screen consumes sits beside that screen; a shared master sits
on the design-system page. A one-off block is a cheap local component —
cost is answered by placement, never by skipping the litmus.

**The cost counterweight.** Model minimally. A plain component beats a
variant set until a second state is real. A slot beats an axis for an
open occupant (§4). Never add an axis or property for a state nobody
named — a wrong abstraction costs more than the duplication it replaced.

**The undecided case.** When a construction's final shape is genuinely
unknown, leave it a frame and re-run the litmus at the screen boundary.
One hard exception: never park an undecided piece inside a SLOT — §1's
refusal makes promotion impossible there.

**A brief's component inventory is a floor, not a ceiling.** The
strongest observed failures were scope: the things the brief happened to
name got masters, and the things it did not name — a banner named only
in the screens section, a close control named nowhere — stayed frames.
The litmus decides from the design, never from the list. The mechanism
that makes it run is the census (SKILL.md): pass 1 walks the BRIEF, so a
one-occurrence role is caught where a repeat count is blind.

If a `figma-bridge-prefs` skill is installed it may raise this — up to _everything placed on a
page is an instance_. Defer to it when it does; this file is the floor.

---

## 3. Mutually exclusive states are one variant axis, not two booleans

Two flags that are always opposite are one axis wearing two names. Model the axis:

- Author each state as its own component named `Property=Value` (`State=Connected`,
  `State=NotConnected`), then `combine_variants` them into one set — the axes come from the
  names, not from a param (`mechanics.md`).
- Select the state per instance: `set_instance({instanceId, properties: {State: 'Connected'}})`.
- Compose the parent from **slots** that receive the variant instance (§5), so the parent
  doesn't have to know which state is in it.

**What a boolean costs you here.** A BOOLEAN property only toggles `visible`, so the unchosen
branch stays in the tree, present but hidden — and Figma lays out only what is visible, so a
hidden child is excluded from its parent's auto-layout entirely. Nothing sizes it and nothing
resolves its `HUG`, so it keeps the size it was born at — a frame created without a stated size
is born 100×100, which is exactly what the hidden branch reads back as long after the visible
one has grown. Two booleans also admit four states when exactly two are valid, and _n_
booleans admit 2ⁿ; nothing enforces the pairing you had in mind. Booleans are for genuinely
**independent** show/hide — an optional badge, an optional caption.

**Put the axis on the smallest part that varies.** Hoisting it upward multiplies variants: a
two-state action area inside a top bar is 2 variants of the action area, or 2 variants of the
whole bar — and the second number multiplies again with every other axis the bar acquires.

Worked example — a top bar with a connected and a not-connected state:

- `TopBar` is a plain component with slots `Heading` and `Actions`.
- `Actions` is a component **set** with one axis: `State=Connected` (status pill + disconnect)
  and `State=NotConnected` (connect button).
- Each screen places a `TopBar` instance, drops an `Actions` instance into its `Actions` slot,
  and selects the state with `set_instance`.

This split is also what the surface allows: slots are created per **component**, and
`update_component`'s `slots` is skipped with a warning on a COMPONENT_SET. The shell that
holds slots is a plain component; the part that varies is the set.

**Page identity is never a variant axis.** A sidebar modeled as
`Active=Overview/Payments/Accounts` is the smallest-part rule violated at file scale: N
pages would mean N near-identical shell masters, each duplicating the brand block and
every nav row, differing only in which row is active. The correct model is this
section's own pattern — a plain shell (logo + a `Menu` slot) with the active state
living on the menu ITEM. The axis belongs to the item; the shell never knows which page
it is on.

---

## 4. Alternative occupants are a SLOT or an INSTANCE_SWAP property

A region specified as holding "a legend chip **or** a segmented control" varies in **occupant**,
not in visibility. A boolean can say _whether_ something shows; it can never say _which_ thing
is there. Two hard-wired children and a toggle is the wrong model — it fixes the set of
occupants at authoring time and pays §3's hidden-child cost for the one not chosen.

Two mechanisms, chosen by whether the set of occupants is open:

- **SLOT — open-ended occupant.** The component declares an empty region; each instance fills
  it with whatever that screen needs (§5). Nothing about the occupant is decided in the master.
- **INSTANCE_SWAP property — closed set.** The master carries a child instance and a property
  that swaps its main component:

```json
{
  "componentId": "<cardId>",
  "add": [
    {
      "name": "HeaderControl",
      "type": "INSTANCE_SWAP",
      "defaultValue": "<componentKey>",
      "targetNodeId": "<childInstanceId>"
    }
  ]
}
```

Then per instance: `set_instance({instanceId, properties: {HeaderControl: '<componentKey>'}})`.
Two things to get right: `defaultValue` is a **component key** (the `key` field on
`get_components` results), and an empty string is rejected — unlike a SLOT property, whose
default is `""`. And `targetNodeId` is what makes the property real: omit it and the property
is added **unbound**, `set_instance` on it is inert, and a `warnings[]` entry says exactly
that.

When the region already holds an instance and you only need to point it somewhere else,
`swap_component({instanceId, mainComponentId})` does it with no property modeling at all.

---

## 5. Slots in practice

**An instance is sealed except its slots.** The only place an instance
can receive new children is a SLOT. So any region of a master that must
receive content later — a header's trailing end, a card's action area —
needs a slot (or a property-gated child) in the MASTER, at authoring
time. A region without one is closed forever in every instance, and the
content ends up parked in whatever slot exists — the observed failure: a
header-row button the brief named, built into the body slot, because the
master's header had no slot and no property and the placed instances
could never grow one.

- **Slots are created by `update_component`, not by `create_node`.** A `create_node` with
  `type: 'SLOT'` gives you a FRAME placeholder and a warning saying so; the real slot comes
  from the `slots` param.
- **Per component, never on a set.** On a COMPONENT_SET every entry is skipped, named in
  `slotsSkipped`, with a warning. Give the slots to a plain component (§3).
- **A slot is born as a vertical stack.** An entry that names no `layout` — a bare string name
  included — is created with vertical auto-layout, and a `size` it states is pinned
  `["FIXED","FIXED"]` so the stack cannot hug it away. Opt out with `layout: {mode: 'NONE'}`,
  or state any other layout and own the `sizing` with it. Children of the stack can `FILL`.
- **The entry carries a full spec.** `slots: [{name, …spec}]` where the spec is `update_node`'s
  own patch with `name` required: `layout`, `fills`, `size`, `sizing`, `radius`, inline `var()`
  wrappers and a `style(Name)` reference on a whole styleable field all land in the same call.
  Worth knowing: a fresh slot is born 100×100 with an opaque `#FFFFFF` fill, so state
  `fills: []` unless white is what you meant.

```json
{
  "componentId": "<topBarId>",
  "slots": [
    {
      "name": "Heading",
      "fills": [],
      "sizing": ["FILL", "HUG"]
    },
    {
      "name": "Actions",
      "layout": { "mode": "H", "gap": 8 },
      "fills": [],
      "sizing": ["HUG", "FILL"]
    }
  ]
}
```

- **Size a slot by its tier** (the sizing doctrine is `responsive.md` §6). An
  **optional** slot — a trailing region a screen may not use — is authored width FILL,
  height written to plain `0` at rest: an empty instance adds nothing to its bar, and
  nothing gets hidden per instance. (Figma stores a sub-pixel epsilon for 0; any
  read-back height under 1px IS the 0 you wrote, never a drift to repair.) A
  **required-content** slot — one the component is meaningless without — is HUG with no
  stored height: the children own their heights, and any floor lives on the container
  as a min-size. **Either kind, once filled: set the instance slot's height sizing to
  HUG in the same breath** — a FIXED-0 slot clips its content invisible
  (`clipsContent` is born true).
- **Check the reply.** `slotsCreated` / `slotsSkipped` are name lists and are always present —
  a slot that didn't land is named there rather than quietly missing.
- **Fill a slot by placing an INSTANCE into it** — `create_node` with the slot as `parentId`,
  or `reparent_node({nodeId, parentId: <slotId>})`. Do not build raw content inside a slot and
  plan to componentize it later (§1).
- **After filling a slot, read the write back and diff it against what you sent** — layout and
  sizing are the fields that quietly land differently, and the slot's own defaults are part of
  what you are diffing against. The read-back and the diff are in `mechanics.md`,
  **A write into a slot is read back, then trusted**.

---

## 6. Complex components last, and modeled before they are built

Tables, data grids, calendars, timelines, tree views: schedule them **after** the simple parts
exist, and write the model down before the first create.

State explicitly, in the plan rather than in the file:

- the **columns / rows** and the anatomy of one row;
- what **varies per instance** (which fields are content, which are properties);
- which **states** exist — empty, loading, error, selected, hovered;
- how it **degrades at narrow widths** — what wraps, what truncates, what drops.

Two reasons the order matters. Their correct shape depends on content and on tokens you only
really have once the rest of the screen is built — model them early and you model them against
a guess. And they are the components most likely to end up inside a slot, where a wrong guess
cannot be re-promoted (§1): the fix is a rebuild, not an edit.

One row anatomy with a `Type` variant axis beats five row components, and beats one row with
five booleans by both of §3's arguments.

---

## 7. Icons

An icon is a component (§2 Q3 — assets always), built as a **frame
wrapping the vector, never a bare vector**. The frame carries the family
size; the empty rim inside it is part of the icon; the frame is what
exports and what instances swap. Discipline, not numbers:

- **Ink stays inside the live area.** The outer rim is inviolable — it
  is the icon's built-in breathing room, so icons never crowd what sits
  beside them.
- **One set, one stroke voice.** Same stroke weight, same caps, same
  corner treatment in every glyph of a set — a set should look like one
  hand drew it.
- **Snap ink to whole pixels.** Off-pixel coordinates blur at render.
  Whole numbers in the vector geometry, always.
- **Center by eye, not by box.** An asymmetric glyph (a play triangle)
  sits nudged off mathematical center until it looks centered. An
  optically chosen off-center position is correct, not drift.

The concrete numbers — the size family, the live-area split, the stroke
weight, the keyline proportions — are a house value
(`figma-bridge-prefs`, house-style *Icons*).
