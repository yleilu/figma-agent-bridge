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

## 2. What must be a component

Model as a component, before placement:

- **Anything that repeats** — rows, list items, cards, feed entries, chips, badges, buttons,
  nav items.
- **Anything with named states** — the states are the variant axis (§3), and a thing that has
  states has them whether or not you model them.
- **Containers and shells that repeat across screens** — sidebar, app shell, top nav,
  chart-card chrome, modal frame. A shell is instanced per screen for exactly the reason a row
  is instanced per item: it is the same thing appearing many times. Six screens sharing a
  sidebar is six instances of one sidebar component, not six sidebars.

**A brief's component inventory is a floor, not a ceiling.** The strongest observed failure
was not ignorance of components — it was scope: the one shell the brief happened to name got
componentized, and the two it didn't name were hand-built seven times each. If a thing repeats
and the brief is silent about it, it is still a component. Decide from the design, not from the
list.

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
  own patch with `name` required: `layout`, `fills`, `size`, `sizing`, `radius`, and inline
  `var()` / `style()` wrappers all land in the same call. Worth knowing: a fresh slot is born
  100×100 with an opaque `#FFFFFF` fill, so state `fills: []` unless white is what you meant.

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
