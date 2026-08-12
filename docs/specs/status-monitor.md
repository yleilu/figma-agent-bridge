---
title: "Agent Status Monitor (Plugin UI)"
created: 2026-07-18T21:40:00+08:00
tags:
  - figma-bridge
  - specs
  - plugin-ui
  - status
  - presence
  - agents
type: spec
related:
  - "[[figma-bridge/docs/specs/overview]]"
  - "[[figma-bridge/docs/specs/request-envelope]]"
  - "[[figma-bridge/docs/specs/plugin-presence]]"
  - "[[figma-bridge/docs/specs/claude-plugin]]"
  - "[[figma-bridge/docs/specs/design-system]]"
  - "[[figma-bridge/docs/specs/version-handshake]]"
  - "[[figma-bridge/docs/principles]]"
---

# Agent Status Monitor (Plugin UI)

> Governed by [[figma-bridge/docs/principles|the principles]]. This spec defines the **plugin iframe UI**
> and the **agent→UI status channel** that feeds it: what an agent shows a human while it works, and how
> the panel degrades when no agent is talking. Identity headers are defined by
> [[figma-bridge/docs/specs/request-envelope|request-envelope.md]] (the SSOT — this spec *consumes* them).
> The agent-facing presence block (turn-start awareness for the agent) is a separate, opposite-direction
> mechanism owned by [[figma-bridge/docs/specs/plugin-presence|plugin-presence.md]]. The panel's
> version-mismatch banner (below) renders a frame whose compare and wire contract are owned by
> [[figma-bridge/docs/specs/version-handshake|version-handshake.md]] — this spec covers only its
> rendering and precedence among the panel's connection states.

## Why

The plugin panel today is an operator console: a status pill, a connect/port form, a disconnect button, a
channel readout, and a feedback list with per-item **Send** buttons. That surface assumes a human drives
the bridge. The bridge is now agent-driven and always-on, so the panel should instead answer the one
question a human actually has while an agent builds in their file: **who is working, what are they doing
right now** — and **what am I pointing at while they do it**, since the human keeps selecting in the same
file the agent is editing. The panel becomes a live **status monitor** — one row per active agent, driven
by the agent itself, with a connection fallback for when nothing is talking.

## What it shows — the display model

The panel renders in exactly one of two modes each frame — **strict either/or**: the roster *or* a
connection/fallback state, never both. The connection/fallback mode itself covers several
sub-states — connecting, offline, version mismatch, or no agent active — all of which render instead
of the roster, never alongside it.

```mermaid
flowchart TB
    Q1{"relay connected?"}
    Q1 -- no --> C1["Connecting… / Bridge offline"]
    Q1 -- yes --> Q0{"version mismatch?"}
    Q0 -- yes --> VM["Version mismatch banner"]
    Q0 -- no --> Q2{"any agent row?\nreported or derived"}
    Q2 -- yes --> AG["Roster (Tree) + selection bar\nno connection header — connected is implied"]
    Q2 -- no --> C3["No agent active"]
```

- **No persistent connection header.** The panel never draws a *connection* line above the roster —
  the agents' presence **is** the "connected" signal. A connection state is surfaced **only** in the
  fallback, when there is nothing else to show. The only chrome that precedes the rows is the
  **selection bar** (below): Figma-local context, never connection state.
- **Connected is the gate.** Agent rows render only while the relay socket is up. If it drops, the panel
  switches to the fallback — agent rows are stale the moment fresh pushes can't arrive — which preserves
  the invariant **agent shown ⇒ connected**.
- **Version mismatch pre-empts the roster.** A live plugin↔server `major.minor` skew is a peer
  fallback state to **Bridge offline** — it renders in place of the roster even while agents are
  live, because a skewed connection can't be trusted to carry fresh agent activity. It is **neutral**
  (it names no stale side): a red dot, bold **"Version mismatch"**, and one sentence naming both
  versions inline (e.g. "Your plugin (0.3.0) doesn't match the server (0.4.0). Update either side so
  they match."). It **self-clears** the moment a (re)connect reports a matching `major.minor` — see
  Degrade / fallback. The frame it renders — the compare and the wire contract — is owned by
  [[figma-bridge/docs/specs/version-handshake|version-handshake.md]]; this spec only renders it,
  and renders it without naming a stale side.
- **Resolution, top-down:**
  1. **Not connected** → connection fallback: **Connecting…** (transient discovery/socket-open) or
     **Bridge offline** (relay/MCP unreachable — "start the MCP / relay to connect").
  2. **Connected + version mismatch** → the **Version mismatch banner**, pre-empting the roster even
     if agents are live.
  3. **Connected + no mismatch + ≥1 live agent** → the agent rows (roster below); the normal working
     state. A "live agent" is any row — one an agent *reported*, or one the panel *derived* from the
     command traffic it is carrying (Derived presence, below).
  4. **Connected + no mismatch + no live agent** → **No agent active** ("waiting for an agent"). This
     state asserts silence, so it may render only when the panel is genuinely carrying nothing: no
     reported row, and no command frame within the derived window.

### The roster — adaptive Tree

One row per agent, with session grouping that **adapts to how many agents a session has live**:

- **A lone agent is a single flat row** — no group header. This is the common case (one operator, or a
  session whose only live agent is its top-level agent).
- **A session with ≥2 live agents is a group:** a **session header row** — the session's top-level agent
  (the one with no `agentId`), carrying its own status dot + label + status text — with its **subagents
  nested** beneath as indented child rows (`agentId`-keyed).
- **Threshold:** a session becomes a group only when **≥2** of its agents have live rows, and collapses
  back to a flat row when it falls to one.
- **Two independent sessions on one file** are two separate rows/groups.

Each row carries a **progress dot**, a **label**, the **status text** (or a skeleton), and a **relative
timestamp**. The two *live* signals — the progress dot and the text/skeleton — are defined next; how they
transition over time is in Lifecycle.

### Row anatomy — two independent signals

A row shows **two signals that mean different things**, so neither is overloaded onto the other:

- **Progress dot — the loader.** A single dot whose state is the agent's *progress*, derived
  automatically, not hand-set:
  - **busy** — amber, gently pulsing — a Figma action is in flight;
  - **ok** — green, static — settled, nothing failed;
  - **error** — red, static — the agent's last report flagged a failure.

  "Busy" is inferred from activity, never set by the agent. A *warning* the agent wants to raise lives in
  the **text**, not the dot — the dot is purely progress (busy / ok / error).
- **Text, or a skeleton.** The one-line narrative from `report_status`. When a new action has begun but no
  narrative has yet arrived, the text area shows a **3-dot skeleton** (a loading placeholder) instead of a
  stale line from the previous action.

A **busy** row is emphasised so that a run of adjacent busy rows reads as **one continuous band**, not
separate pills. The exact treatment (a full-width, no-radius fill in Figma's layers-panel style) is owned
by the design system, not restated here.

### Selection bar — roster-scoped context

Above the roster — and **only** the roster — a thin one-line **selection bar** names what the user
currently has selected, with the **current page** at the right. It is **Figma-local context, not a
connection signal**, so it is not the connection header rejected above:

- **Roster-scoped.** It renders only in the roster mode — never over Connecting / Bridge offline /
  Version mismatch / No agent active. It is part of the roster mode, not a third display mode; the
  strict either/or of the fallback states is unchanged.
- **Hidden when empty.** With nothing selected there is no bar — it is present only when it has
  something to say.
- **The noun is the selection's kind.** A selection whose nodes are all one type reads as that type's
  friendly plural — "2 frames selected"; singular at one — "1 text layer selected". A mixed selection,
  **and any type with no friendly noun**, reads as "N nodes selected". The friendly-noun vocabulary is
  UI copy owned by this spec; an unlisted type is never an error, only generic.
- **De-emphasised.** No dot, no icon, no emphasised count — the bar must never compete with a row's
  progress dot. Its treatment is owned by [[figma-bridge/docs/specs/design-system|design-system.md]].
- **Pinned.** When the roster is long enough to scroll, the bar stays pinned at the top while the rows
  scroll beneath it — it is context for the whole panel, not the first row.
- **One line.** A long label or page name truncates; the page yields before the selection label does.
- **Context, not a control.** Nothing in the bar is clickable. It follows the user's selection and page
  as they change, coalesced over a short window, so it may briefly lag a rapid drag-selection.

The panel reads this from the plugin's own main-thread report to the iframe: the current page, the number
of selected nodes, and their common kind (or mixed). This is a **panel-local** signal. It is *not* the
availability registry's presence fields — `ChannelInfo`'s `currentPage` / `selected`
([[figma-bridge/docs/specs/plugin-presence|plugin-presence.md]],
[[figma-bridge/docs/specs/overview|overview.md]]) stay agent-facing, shallow and count-only, and gain no
kind.

### Styling

The panel **matches native Figma UI as closely as possible**. All concrete styling — the Figma color
tokens, Inter/11px type ramp, spacing, radius, motion, and the full-width row-emphasis rule — is owned by
[[figma-bridge/docs/specs/design-system|design-system.md]] and referenced, not duplicated here. The only
UI parameter this feature fixes is the window:

- **Window:** resizable via `figma.ui.resize`, default ~340×400, min ~340×160 — so one agent up to many
  render gracefully (replacing today's fixed 340×280).

## Identity & grouping

The panel keys and groups rows entirely from the request `meta` identity headers
([[figma-bridge/docs/specs/request-envelope|request-envelope.md]] — that spec owns the header *mechanism*;
the keying/labelling *policy* below is owned here):

| Concern | Resolution |
|---|---|
| **Row key** (dedupe / update / clear a specific agent) | `agentId ?? sessionId` — a subagent by its `agentId`; the top-level agent by its `sessionId` |
| **Group** (a session's agents together) | `sessionId` — the row with no `agentId` is the group's top-level agent; the rest are its subagents |
| **Display label** | `label` (agent-set, optional) `?? agentType` (e.g. `"Explore"`) `?? "Agent"` |
| **Kind** (top-level vs subagent, for indent) | derived: `agentId` present ⇒ subagent; absent ⇒ top-level |

No new identity field is introduced; `label` is the only agent-authored addition and it rides the status
push (below), not `meta`.

## The transport — `report_status`

A new agent-facing MCP tool lets an agent show its own status. It is a **file-addressed, non-facade
meta-tool** (a sibling of `record_feedback`; it carries the shared `fileTargetParamsSchema` so it receives
`fileKey` + the injected identity headers).

```
report_status({
  fileKey,                     // which file's panel (param; identity headers injected)
  text: string,                // the one-line narrative — replaces the skeleton
  level?: "normal" | "error",  // default "normal"; "error" → red dot. (Busy is automatic, never set here)
  label?: string,              // optional friendly name; else agentType / "Agent"
})
```

- **The dot is progress, not level.** `report_status` sets only `ok` (`normal`) vs `error`; **busy** is
  derived from activity, not passed here. A *warning* the agent wants to surface goes in `text`.
- **Latest-wins.** Each call *replaces* the calling agent's current status (keyed by `agentId ?? sessionId`
  on `fileKey`'s panel) and fills the skeleton with `text`. `text` is a single live line, not an appended log.
- **Display-only, no round-trip.** Unlike a Figma command, `report_status` never reaches the plugin main
  thread (`code.ts` / `figma.*`). It is a UI push, delivered like feedback broadcasts — the iframe renders
  it directly. The agent gets a quick ack, not a plugin result.
- **File-scoped delivery.** It targets **one** file's channel via `channelFor(fileKey)` — *not* the
  existing all-files `notify()` fan-out.

### Store & flow

The **relay owns an in-memory, per-channel status map** — it is the only actor that sees *every* session
on a file (a per-session MCP server sees only its own agents), so it alone can replay the full
multi-session picture. Crucially, the relay stays a **dumb transport (B1):** it stores and fans out
`agent-status` frames **without interpreting Figma commands**. The *MCP server* decides what each frame
says — it already knows which tool it is calling — so no command-parsing is pushed into the relay.

```mermaid
flowchart LR
    A["agent"] -->|"report_status (text/level)"| S["MCP server"]
    A -->|"any other figma command"| S
    S -->|"agent-status frame\n(report_status → text · other tool → busy+skeleton)"| R["relay\nper-channel status map (semantics-free)"]
    S -->|"forward the command"| P["plugin iframe\nlive map → Tree render"]
    R -->|"broadcast agent-status\n(channel members)"| P
    P -.->|"on register: status-sync"| R
    R -.->|"replay current statuses"| P
    HK["Stop / SubagentStop / SessionEnd hooks"] -->|"POST /agent-status/*"| R
```

The **MCP server emits one `agent-status` frame per Figma tool call it handles** (on `channelFor(fileKey)`,
carrying the agent's `meta` identity); the relay upserts it into the channel map by `key` and broadcasts:

- **Text (`report_status`):** the server emits the record `{ key, sessionId, agentId?, agentType?, label?,
  level, text, activity, updatedAt }` with the new `text`/`level` and `activity: "busy"`.
- **Busy + skeleton (any *other* Figma tool call):** the server emits the same record with `text: null`
  (the skeleton) and `activity: "busy"` — marking the row busy. The relay **preserves the last narrative**
  across this frame: a skeleton `text: null` never wipes an existing `text`, so the skeleton only ever
  appears **before** the row's first narrative; once a `report_status` line has landed, the last line stays
  visible while the dot alone carries "busy" through subsequent tool calls. This is the per-tool "clear to
  loading", decided **at the server** from the tool it is invoking (no dedicated `PreToolUse` ping). It
  relies on the agent's `meta.sessionId`/`agentId` — the envelope's identity headers.
- **Settle to idle:** a **`Stop`** hook (turn ended) — or a short activity-quiet window — flips
  `activity: "idle"`; the dot stops pulsing (green `ok` / red `error`) and the last `text` stays.
- **Replay:** on plugin `register`, the relay replays the channel's current records (so a reopened or
  reloaded plugin immediately shows the agents already working — mirrors today's `feedback-sync`).
- **Remove:** `SubagentStop`/`SessionEnd` hooks POST `{ sessionId, agentId? }`; the relay removes matching
  records from every channel map and broadcasts the removal. (The hooks carry no `fileKey`, so removal is
  keyed by `sessionId`/`agentId` across files — correct, since an agent's identity is file-independent.)

The store is **in-memory only** — never written to disk (unlike feedback). It self-heals: a relay restart
starts empty and repopulates from the next frames.

## Derived presence — traffic is presence

Every row above is born from a **push**: a `report_status`, or the server's busy+skeleton frame — which it
emits only for an **identity-bearing** command. Both are enrichments of a fact the panel can already see
for itself: **commands are arriving**. When neither push lands — the identity headers are absent, or the
agent simply never narrates — the panel would sit in **No agent active** while an hour of commands flowed
through it. That is not a missing nicety, it is a **false statement about the file**: the human is told
nobody is working while an agent edits under their cursor. So the roster carries a second, lower tier that
the panel derives itself:

> **The panel must never claim silence while command traffic is flowing.**

- **Source — the frames already in hand.** Each command frame the plugin receives, before it dispatches to
  the sandbox, is evidence of a live agent. No new frame, no new hook, no wire addition: the panel reads
  presence off the traffic it is already carrying. The liveness `ping` is excluded — that is the bridge
  probing itself, not an agent working.
- **Key — one row per session.** `derived:<sessionId>`, from the frame's `meta.sessionId`. With no
  `sessionId` in the envelope (the identity injector absent — see Degrade / fallback) every frame folds
  into **one** anonymous derived row: a single generic "an agent is working here", never a row per command.
- **Text — a verb class, not a narrative.** A derived row cannot know what the agent is *doing*, only what
  kind of call it is making, and it says exactly that much. The class is one question asked of the command
  registry — **can this call change the document?** It cannot (a read, or a context move such as selecting
  a layer or switching page) → `Reading`; it can → `Editing`; an **export** is its own class,
  `Exporting`; a command the registry does not know → `Working`. This is a *class*, never phrased as a
  report — a derived row never impersonates a `report_status` line. It stands in for the skeleton: a row
  that is provably busy shows the class it is busy with.
- **The dot means traffic, not a call in flight.** A derived row's progress dot is amber for as long as
  the row lives, because what the panel observed is *a frame within the window* — not whether that call
  has returned. Only a reported row's dot tracks an actual in-flight action (§ Row anatomy).
- **Reported pre-empts derived.** A reported row for the same session **replaces** that session's derived
  row; a derived frame never overwrites, revives, or sits beside it. One agent is one row, and the
  narrative always wins over the class. The anonymous row claims no session and so cannot be matched to
  one: **any** reported row pre-empts it, because an unattributable row standing next to an attributed one
  reads as a second agent that does not exist.
- **Expiry — 30s of quiet.** A derived row *is* the evidence of traffic, so it lives exactly as long as the
  evidence: it disappears 30 seconds after the last command frame for its session. It has no idle-fade
  tier — there is no narrative to leave behind — it is simply gone.

The tier is **panel-local**: derived rows exist only inside the iframe that synthesized them, are never
stored by the relay, never broadcast, and never reach another plugin. A `status-sync` replay repaints the
reported rows and leaves the derived ones alone.

### The ghost rule — a row never outlives its agent

Presence is a claim about *now*, so every row expires when its source goes quiet. Each tier sets its own
clock, and the new tier must not be given a row it can never retire:

| Row | Its source goes quiet when | It expires |
|---|---|---|
| Derived | no command frame arrives for its session | 30s after the last frame — the panel's own clock, since nothing outside it knows the row exists |
| Reported (`report_status` / server push) | no push arrives for that row | idle-fade at `IDLE_MS`, removed at the backstop `TTL_MS` (§ Lifecycle) |
| Either | the relay socket drops | at once — the invariant is **agent shown ⇒ connected** |

A killed agent that never fires `SubagentStop` / `SessionEnd` is exactly what the backstop `TTL_MS` is
for, and it retires that row without any hook. What the clocks cannot fix is a row that is being
*refreshed*: a reported row that carries no identity is keyed by its `label`, so a later agent choosing
the same label writes into the same row. Such a row stays truthful about its **latest** reporter and says
nothing about the one that ended — but a human reading it as the earlier agent sees a ghost that appears
to be still working. Distinguishing the two is what `sessionId` / `agentId` are for
(§ Identity & grouping); no timeout can separate agents that share a key.

## Lifecycle — busy / idle / removed

Two timescales drive a row: a fast **activity** state (seconds — the dot and the skeleton) and a slow
**presence** state (minutes — muted, then gone).

```mermaid
stateDiagram-v2
    [*] --> Busy: first command (report_status → text · other tool → skeleton)
    Busy --> Busy: report_status (text) / another tool (skeleton)
    Busy --> Idle: Stop hook / activity quiet
    Idle --> Busy: any command
    Busy --> [*]: SubagentStop / SessionEnd / TTL
    Idle --> [*]: SubagentStop / SessionEnd / TTL
```

- **Activity (the dot, seconds):**
  - **Busy** — amber, pulsing — a command (a `report_status` *or* any Figma tool call) is in flight/recent.
    The text shows the latest `report_status` narrative, or a **skeleton** when the current action has not
    been narrated yet — the *skeleton is just Busy with no text*, so the Busy transitions below cover it.
  - **Idle** — green (`ok`) / red (`error`), static — no recent activity, or the turn ended (**`Stop`**
    hook). The last `text` stays; a row that reaches idle having never been narrated settles to a default
    line ("Done") instead of a skeleton — a green row never shows a skeleton.
- **Presence (the row, minutes):**
  - **Muted** — after `IDLE_MS` (~45–60s) of no activity the whole row dims: present, so you can still see
    *who* is here, but clearly not working.
  - **Removed** — an authoritative end signal drops the row:
    - **`SubagentStop`** → that one `(sessionId, agentId)` subagent row;
    - **`SessionEnd`** → all rows for that `sessionId` (backstop for the top-level agent, which has no
      `SubagentStop`);
    - **Backstop TTL** (`TTL_MS`) → any row whose activity is older than the timeout, if no hook ever fires
      (hook absent, crash, lost signal). Prevents permanent ghosts.

`IDLE_MS` and `TTL_MS` are single tuning constants (`IDLE_MS` ≈ 45–60s, `TTL_MS` ≫ `IDLE_MS`, minutes); the
busy→idle activity-quiet window is a few seconds.

## Hooks

Three `hooks.json` entries are added alongside the existing `PreToolUse` identity injector and
`UserPromptSubmit` presence hook (all delivered by the plugin, per
[[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]]):

- **`Stop`** — POSTs `{ sessionId }` (the turn ended) → the relay settles that session's rows **busy →
  idle**.
- **`SubagentStop`** — POSTs `{ sessionId, agentId }` → removes that subagent's row.
- **`SessionEnd`** — POSTs `{ sessionId }` → removes all of that session's rows.

They reach the relay by an HTTP call (like the presence hook), needing no MCP server and no `fileKey`.

**No hook is needed for busy + skeleton.** That signal is derived at the relay from the command stream it
already forwards (§ Store & flow) — realising the intended per-tool "clear to loading" without a
`PreToolUse` ping, and avoiding a second `PreToolUse` hook racing the identity injector on `updatedInput`.

## Wire additions

New relay-level frames (transport only; not Figma commands):

The per-agent **status record** is `{ key, sessionId, agentId?, agentType?, label?, level, text, activity,
updatedAt }` where `text` is `null` while the row is a skeleton (no narrative yet) and `activity` is
`"busy" | "idle"`. New relay-level frames/endpoints (transport only; not Figma commands):

| Frame / endpoint | Direction | Payload / effect |
|---|---|---|
| `agent-status` | relay → plugins (one channel) | the relay's updated record after a command (text set · text→skeleton · busy · settled) |
| `status-sync` | plugin → relay (on register) | request the channel's current records; relay replies with the set |
| `agent-status-remove` | relay → plugins | `{ sessionId, agentId? }` — remove matching rows |
| `POST /agent-status/settle` | `Stop` hook → relay (HTTP) | `{ sessionId }` — busy → idle |
| `POST /agent-status/remove` | `SubagentStop` / `SessionEnd` hooks → relay (HTTP) | `{ sessionId, agentId? }` — remove rows |
| `version-mismatch` | relay → plugins (one channel) | `{ plugin, server }` — **route-only**: the relay stores nothing (unlike `agent-status`, it is never a roster row and is never TTL-swept). The frame, its server-side compare, and the `{ channel, plugin, server }` shape it arrives in are owned by [[figma-bridge/docs/specs/version-handshake|version-handshake.md]]. |

These are new message types, not changes to existing command/reply framing, so they carry no version-skew
risk beyond additive handling (an older plugin simply ignores an unknown broadcast type).

**Derived presence adds nothing to this table.** It is synthesized inside the plugin from the command
frames the panel already receives, so it needs no frame, no endpoint and no field on the wire — the only
mark a derived row carries (that it *is* derived) is panel-local and never serialized.

## What is removed from the panel

The status monitor **replaces** the old iframe surface. Removed:

- the **feedback panel** and its per-item **Send** buttons (feedback moves to an agent-driven flow — see
  Out of scope);
- the **connect / port form** and **Retry** (connection is automatic; discovery is internal);
- the **Disconnect** button (no manual disconnect);
- the **channel readout** (channel is internal transport, never agent- or human-facing).

The underlying relay connection, discovery, presence, and B3 identity plumbing are unchanged — only what
the iframe *renders* changes.

## The agent-facing skill

Knowing *when* and *what* to `report_status` is guidance, not mechanism, and is owned by a plugin **skill**
(agent-facing), not this spec. The skill's job: prompt an agent to report a concise, human-meaningful line
at the start of and during a unit of work, choose an appropriate `level`, and set a `label` when the
default (`agentType`) is unhelpful. This spec defines only the tool and the panel it feeds.

## Degrade / fallback

- **No `PreToolUse` identity hook** (headers absent) → `sessionId`/`agentId` are absent; an agent that
  still calls `report_status` is keyed by a self-supplied `label` if given, else shown as a single generic
  "Agent" row. The panel never errors on missing identity. An agent that reports nothing at all is still
  visible: its command traffic carries no identity either, so it derives the **one anonymous row**
  (Derived presence). Identity enriches the roster — it is never what the roster's existence depends on.
- **No cleanup hooks** → rows never receive an explicit clear; the **idle-fade** and **backstop TTL**
  guarantee they mute and then disappear anyway. Cleanup hooks are an optimisation over the TTL, not a
  correctness dependency.
- **Plugin reloaded / reopened** → `status-sync` replay repaints current agents immediately.
- **Relay restarted** → maps start empty; the next pushes repopulate; nothing is lost that isn't
  re-derivable from live agents.
- **No agent ever pushes** (relay connected) → the panel derives its rows from the command traffic
  instead, and reaches the "No agent active" resting state only once that traffic has been quiet for the
  derived window too. A resting panel with no traffic behind it is correct, not an error.
- **Version mismatch** → the panel shows the banner instead of the roster, however many agents are
  live. It **self-clears** on a matching (re)connect: the plugin resets its mismatch state on every
  connect attempt and again on socket close, so the banner only persists while a fresh, skewed
  connect keeps re-asserting it — the absence of a frame after a healthy reconnect *is* the clear, no
  separate "matched" push is needed.

## Out of scope

- **Feedback send-flow.** This spec removes the feedback *UI*; how feedback is sent now that the button is
  gone (an agent-driven send path) is a separate follow-up spec. `record_feedback` (writing feedback) is
  unchanged.
- **`meta` identity injection.** Building the `PreToolUse` hook and the `sessionId`/`agentId`/`agentType`
  plumbing is owned by [[figma-bridge/docs/specs/request-envelope|request-envelope.md]] and its
  implementation, not this spec. This panel *consumes* those headers.
`report_status` is a non-facade meta-tool (sibling of `record_feedback`), recorded in
[[figma-bridge/docs/specs/tool-surface|tool-surface.md]]'s count formula.
