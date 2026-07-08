---
name: figma-feedback
description: >-
  Use while driving the Figma MCP when you hit friction — a tool that silently no-ops,
  errors confusingly, contradicts the spec, is missing a capability, or MISLEADS ("I
  thought I could do X but I can't") — OR when the user asks to file feedback. Teaches
  when and how to record a bug or proposal via record_feedback (standardized formats),
  and never to send it (the human sends from the plugin).
version: 0.1.0
---

# figma-feedback

Teaches **when and how** to record friction via `record_feedback`. Two flows, one per
category, each with a standardized body format. After recording, tell the user it's noted
and that **they Send it from the plugin** (the human gate) — never send it yourself.

---

## Flow 1 — BUG

Something is broken or wrong. File under **`category: 'bugs'`**.

**Signals — any of these triggers a bug report:**
- **Silent no-op** — the tool returns success but nothing changed in Figma.
- **Confusing / unexpected error** — an error whose message doesn't tell you what to fix.
- **Contradicts the spec** — the tool description promises behaviour X; you got Y.
- **Skill-misleading** — *"I thought I could do X but I can't"* and the **skill** set
  that expectation. File it as a bug (the skill is wrong), and correct the skill guidance
  as part of this session's work (the fix folds back like an accepted shortcut). Quote the
  misleading line.

**Body format:**
```
**What I did:** <tool call / action>
**Expected:** <correct behaviour>
**Actual:** <what happened>
**Repro:** <tool + params + result>
```

**Example** — `update_component` adds a TEXT property that never binds:
```
record_feedback({
  category: 'bugs',
  tool: 'update_component',
  title: 'update_component adds a TEXT property but never binds it → set_instance can\'t change instance text',
  description: `**What I did:** update_component(add TEXT "Label"), then set_instance({Label:"Revenue"}).
**Expected:** the instance's label text becomes "Revenue".
**Actual:** the property is set on the instance but no text node updates — it's bound to nothing.
**Repro:** update_component({componentId, add:[{name:"Label",type:"TEXT",defaultValue:"x"}]})
  → set_instance({instanceId, properties:{Label:"Revenue"}}) → get_node shows unchanged text.`
})
```

---

## Flow 2 — PROPOSAL

It works, but could be better, or something is missing. File under
**`category: 'proposals'`**.

**Signals — any of these triggers a proposal:**
- **Better approach** — doing X this way would be cleaner or more reliable.
- **Shortcut** — a shorter path to the same outcome (see shape below).
- **Missing tool or arg** — you needed a capability the tool surface doesn't expose.
- **Lack of docs** — the tool's behaviour was unclear; better documentation would help.
- **Feature request** — a genuinely new capability that would improve the workflow.

**Body format:**
```
**Context:** <what I was doing>
**Opportunity:** <better-approach | shortcut | missing tool/arg | missing docs | feature>
**Proposed change:** <concretely what would help>
**Why it helps:** <the benefit>
```

**Example** — `set_instance` should accept text overrides in one call:
```
record_feedback({
  category: 'proposals',
  tool: 'set_instance',
  title: 'set_instance should accept text overrides in one call',
  description: `**Context:** populating 4 stat-card instances took 12 update_node calls on compound child ids
  (I<inst>;<masterText>) with full text patches.
**Opportunity:** missing arg — no one-call way to set an instance's text content.
**Proposed change:** set_instance({instanceId, text:{"label":"Revenue","value":"$48.2k"}}).
**Why it helps:** N calls → 1; the compound-id + full-patch path is fiddly and error-prone.`
})
```

### Shortcut shape

A shortcut is a high-value proposal: a shorter path to the same outcome. **Accepted
shortcuts fold back into the `figma-design` skill's recipes.** Use this body format:

```
**Long path:** A → B → C → outcome
**Shortcut:** D → same outcome
**Why it helps:** <fewer steps / simpler / less error-prone>
```

**Example** — instance text-child id is deterministic:
```
record_feedback({
  category: 'proposals',
  title: 'instance text-child id is deterministic — skip the per-instance get_node',
  description: `**Long path:** per instance: get_node(instance) → parse its text-child id → update_node(childId, patch)
**Shortcut:** the child id is deterministic — I<instanceId>;<masterTextNodeId> — build it from the
  master's text-node id captured once; skip the per-instance get_node entirely.
**Why it helps:** N get_node round-trips → 0; one master-time lookup serves every instance.`
})
```

---

## High-value litmus

A proposal earns its place when it does **at least one** of:

- Kills a **silent failure or drift**.
- Collapses a repeated **A→B→C into one call**.
- **Unblocks** a capability that needed a hack.
- **Cuts read tokens** on a common path.
- Improves **read-back fidelity**.
- Removes **guesswork** (least-surprise defaults, semantic ids over opaque ones).

**Skip** cosmetic, one-off, or cheaply-worked-around ideas. See
`references/high-value-proposals.md` for the eight categories and worked examples.

---

## `record_feedback` param mapping

| Param | Type | Value |
|---|---|---|
| `category` | `'bugs'` \| `'proposals'` | The directory / issue stream the item routes to. |
| `title` | string | One-line heading — specific and scannable. |
| `description` | string | The formatted prose body (the **What I did:** / **Context:** … block above). |
| `tool` | string (optional) | The tool name when the feedback is tool-specific; omit for skill or workflow feedback. |

The `category` value **is** the directory name — no mapping, no pluralization. Only
`'bugs'` and `'proposals'` exist today; adding a category is a project decision, not an
agent call.

---

## Etiquette

- **Record, don't send.** You call `record_feedback`; the human reviews each item in the
  plugin UI and clicks **Send** when ready. Nothing leaves the machine until they do.
- **One item per distinct issue.** Don't bundle multiple issues into one record; don't
  repeat the same issue twice.
- **Never record expected errors.** If the user passed invalid input and the tool returned
  an error, that is correct behaviour — do not file it.
- **Zero-friction.** Record the item, tell the user it's noted, and continue the task.
  Never derail for feedback bookkeeping.
