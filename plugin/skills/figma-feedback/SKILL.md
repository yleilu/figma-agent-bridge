---
name: figma-feedback
description: >-
  Use while driving the Figma MCP when you hit friction — a tool that silently no-ops,
  errors confusingly, contradicts the spec, is missing a capability, or MISLEADS ("I
  thought I could do X but I can't") — OR when the user asks to file feedback. Teaches
  when and how to record a bug or proposal via record_feedback (standardized formats),
  and how the end-of-work review (a three-way Report / Defer / Discard gate) files or drops the backlog.
version: 0.1.0
---

# figma-feedback

Teaches **when and how** to record friction via `record_feedback`, and how the
top-level agent files it at the end of a unit of work. Two record flows, one per
category, each with a standardized body format. Recording only captures to the
local backlog; filing happens through the end-of-work review (below).

---

## Flow 1 — BUG

Something is broken or wrong. File under **`category: 'bugs'`**.

**Signals — any of these triggers a bug report:**

- **Silent no-op** — the tool returns success but nothing changed in Figma.
- **Confusing / unexpected error** — an error whose message doesn't tell you what to fix.
- **Contradicts the spec** — the tool description promises behaviour X; you got Y.
- **Skill-misleading** — _"I thought I could do X but I can't"_ and the **skill** set
  that expectation. File it as a bug (the skill is wrong). **If the miss is mechanics**,
  correct the skill guidance as part of this session's work (the fix folds back like an
  accepted shortcut). **If the miss is a taste / preference** (a house-style default, a
  threshold, a naming choice), capture it in the user's `figma-bridge-prefs` via
  `figma-setup` instead — never fold a preference into a shipped skill. Quote the
  misleading line — but **never quote a line whose source is `figma-bridge-prefs`**
  (house-style / review-standards); describe the miss abstractly and route it to
  `figma-setup`. More broadly, never include house tokens, scales, client names, or naming
  conventions in any `record_feedback` / `send_feedback` body.

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
_mechanics_ shortcuts fold back into the `figma-design` skill's recipes. A
_taste / preference_ correction (a house-style default, a threshold, a naming choice)
instead routes to the user's `figma-bridge-prefs` via `figma-setup` — it never folds into
a shipped skill, and `figma-bridge-prefs` content never rides the feedback rail off-box.**
See [[figma-bridge/docs/specs/customization|customization.md]] §11. Use this body format:

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

| Param         | Type                      | Value                                                                                  |
| ------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `category`    | `'bugs'` \| `'proposals'` | The directory / issue stream the item routes to.                                       |
| `title`       | string                    | One-line heading — specific and scannable.                                             |
| `description` | string                    | The formatted prose body (the **What I did:** / **Context:** … block above).           |
| `tool`        | string (optional)         | The tool name when the feedback is tool-specific; omit for skill or workflow feedback. |

The `category` value **is** the directory name — no mapping, no pluralization. Only
`'bugs'` and `'proposals'` exist today; adding a category is a project decision, not an
agent call.

---

## Etiquette

- **Record, then review.** `record_feedback` only captures an item locally. It does
  not send. Whoever hits the friction records it — a `figma-designer` subagent, or the
  main agent.
- **One item per distinct issue.** Don't bundle multiple issues into one record; don't
  repeat the same issue twice.
- **Never record expected errors.** If the user passed invalid input and the tool
  returned an error, that is correct behaviour — do not file it.
- **Zero-friction.** Record the item and continue the task. Never derail for feedback
  bookkeeping.

## The end-of-work review (the human gate)

At the end of a unit of work, if the pending backlog is non-empty, the **top-level
agent** runs the review with the human. (`AskUserQuestion` is a main-agent affordance, so
subagents only record — the top-level agent runs this step after they return.) The human is
**never asked to triage issues one by one** — every choice is on the whole batch.

1. **Read the backlog.** Call `list_feedback` (page the `cursor` until exhausted) to get
   every pending item and the remembered `identity`.
2. **Gate — one three-way choice.** Ask, e.g. _"I hit N tool limitation(s) — ‹up to 3 titles,
   then "…and K more"› — what should I do?"_ with three options:
   - **Report them** — file all N to the developer.
   - **Defer to next time** — do nothing; the backlog is kept. **Dismissing the question is
     Defer.**
   - **Discard** — drop them unsent.
   For a returning (remembered) user, label the Report option with the attribution —
   _Report as `name <email>`_ or _Report anonymously_ — so they see who authors the comments.
3. **On Report — attribution (first run only).** If `identity` is null, ask _under my GitHub
   account_ vs _anonymously_. To log in: `github_auth_start`, show the `user_code` +
   `verification_uri`, then `github_auth_poll` (re-call while `pending`) until
   `authorized`/`denied`/`expired`; if the human cancels, fall back to the anonymous option
   (items stay pending, nothing filed). The choice is remembered — skip this on later runs.
4. **On Report — "something else" (any run).** Independently of step 3, offer a free-text
   "describe an issue or opinion in your own words". If given, **do not forward the raw text**:
   investigate it (reproduce, identify the tool + expected-vs-actual), write a proper bug or
   proposal in the standard format, classify it `bugs` vs `proposals`, and pass it as
   `send_feedback`'s `add`.
5. **File / drop.**
   - **Report →** `send_feedback({ send: <every pending path>, add?, identity? })`. Pass
     `identity` explicitly the first time (so the choice is remembered). Then **report the
     per-item results**: on `auth-required` offer to log in again; on `no-access` offer the
     anonymous path.
   - **Discard →** `discard_feedback({ paths: <every pending path> })` (hard delete).
   - **Defer / dismiss →** do nothing; the backlog is preserved.
