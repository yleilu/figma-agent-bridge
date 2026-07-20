---
title: figma-agent-bridge — Feedback System Spec
created: 2026-07-06T20:45:00+08:00
tags:
  - spec
  - figma-bridge
  - feedback
type: spec
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/architecture]]"
  - "[[figma-bridge/docs/specs/tool-surface]]"
  - "[[figma-bridge/docs/specs/claude-plugin]]"
  - "[[figma-bridge/docs/specs/status-monitor]]"
---

# figma-agent-bridge — Feedback System

> Defines a dogfooding loop: the agent **records** friction it hits while driving the MCP; at
> the end of a unit of work the agent runs a **fast three-way gate with the human** — **Report**,
> **Defer**, or **Discard** — and on **Report** **files every recorded item** as a **comment** on
> one of two standing category issues (bugs, proposals) — either **anonymously** (a shared bot
> identity, via a CloudFlare Worker) or **as the human's own GitHub account** (a token the human
> authorizes once, in-browser). Governed by `docs/principles.md`; transport reuses
> `docs/architecture.md`.

> **The agent records; the human decides whether to ship, and under whose name.** Nothing is
> filed until the human picks **Report** at the end-of-work gate — that is the human gate. _When_
> to record and _how_ to run the review is plugin-layer guidance (the `figma-feedback` skill, P1),
> never a tool opinion — the tools themselves are neutral mechanisms.

## Purpose

While the agent uses the MCP it encounters friction — a tool that silently no-ops, a missing
capability, a confusing result. Today that signal evaporates at the end of the session. This
feature captures it at the moment it happens and, on human approval, routes it into the
project's own GitHub issues so it can be triaged.

The design goals, in priority order:

1. **Zero-friction capture** — one neutral tool call (`record_feedback`) persists an item
   mid-task without derailing. The tool holds no opinion about _when_ to call it; that guidance
   is a plugin-layer skill (P1).
2. **Human gate** — nothing is filed automatically. At the end of a unit of work the agent runs a
   **fast three-way gate** on the whole batch: **Report** the recorded issues to the developer,
   **Defer** them to a later review, or **Discard** them. **Defer or dismiss → nothing is sent and
   nothing is deleted** (the backlog is kept); **Report files them as a batch**; **Discard deletes
   the whole batch unsent** — the human is never asked to triage issues one by one. On **Report**, a
   first-run user is then asked how to attribute it and may add one issue in their own words.
3. **Attributable** — the human files either **anonymously** (a shared bot identity) or **as
   themselves** (their own GitHub account, so the comment is authored by them). The choice is
   made once and **remembered**.
4. **Easy triage, tidy tracker** — one standing GitHub issue per category (`bugs`, `proposals`);
   each item is a **comment** on its category's issue, so a weekly read is one thread per stream
   and the issue list stays uncluttered. Both identity paths comment on the same two issues; only
   the comment's author differs.
5. **Rides existing rails** — reuse the store and the tool/handler patterns; add the minimum new
   surface, and keep the bridge contract uniform (B1).

### Layer split (P1)

The feature is divided across layers so no opinion leaks into the tools:

- **Tool layer** — neutral capabilities: `record_feedback` (capture), and `list_feedback` /
  `send_feedback` / `discard_feedback` / `github_auth_start` / `github_auth_poll` (the
  review-and-file mechanism and the identity handshake). None of them decide _when_ to fire or _what_ to send. They are
  **non-facade meta-tools** — the documented T6/T7 carve-out (see [Principle
  alignment](#principle-alignment)), siblings of `record_feedback` and `report_status`.
- **Plugin layer** — the **`figma-feedback` skill** teaches the agent _when_ to record and
  _when/how_ to run the end-of-work review (the three-way gate, the first-run form) and resolve
  identity. This opinionated workflow lives in
  [[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]] §6.3 (P1), never in a tool
  description.

## Architecture

The **record path** persists a `pending` item to a local store (below). The **send path** is
**agent-driven**: at the end of a unit of work the agent reads the backlog (`list_feedback`), runs
the end-of-work review (owned by the skill), and — on **Report** — files the recorded issues as a
batch (`send_feedback`), or on **Discard** deletes them unsent (`discard_feedback`). Filing an item
is a single GitHub
call — a **comment** on the item's category issue. There are two identity paths, differing only in
the comment's author:

- **Anonymous** → MCP server → **CloudFlare Worker** (holds the shared bot PAT) → the bot posts
  the comment.
- **Logged-in** → MCP server → **GitHub API directly**, with the human's own OAuth token → the
  comment is **authored by the human**.

Feedback flows **agent → MCP server → (Worker | GitHub)**. It never traverses the relay or the
plugin iframe: the relay carries **no feedback semantics**, and the Figma sandbox thread
(`packages/figma-plugin/src/code.ts`) is never involved. The plugin panel renders the agent
status monitor ([[figma-bridge/docs/specs/status-monitor|status-monitor.md]]) and shows no
feedback surface.

```mermaid
sequenceDiagram
    participant Agent
    participant Server as MCP server
    participant Store as Local store
    participant Cred as Credential store
    participant Worker as CF Worker
    participant GH as GitHub

    Agent->>Server: record_feedback(category, title, description, tool?)
    Server->>Store: write feedbacks/<cat>/<file>.md (status pending)

    Note over Agent: end of a unit of work (skill-driven)
    Agent->>Server: list_feedback()
    Server->>Store: read pending (bounded, T10)
    Server->>Cred: read identity preference + cached identity
    Server-->>Agent: { pending[], identity }

    Note over Agent: gate — Report · Defer · Discard (+ optional "something else" on Report; dismiss = Defer)
    alt Report
        opt first run — no remembered identity (Form)
            Note over Agent: attribution — GitHub login vs anonymous
            opt human chooses "Log in with GitHub"
                Agent->>Server: github_auth_start()
                Server->>GH: POST /login/device/code (client_id, scope)
                GH-->>Server: { user_code, verification_uri, expires_in, interval }
                Server-->>Agent: { user_code, verification_uri, ... }
                Note over Agent: shows code + URL to the human
                Agent->>Server: github_auth_poll()
                Server->>GH: POST /login/oauth/access_token (client_id, device_code)
                GH-->>Server: { access_token }  (or authorization_pending / slow_down)
                Server->>GH: GET /user  (fetch identity for display)
                Server->>Cred: store token + identity
                Server-->>Agent: { status: authorized, identity }
            end
        end
        Agent->>Server: send_feedback({ send[], add?, identity })
        Server->>Cred: remember preference = identity (first run)
        loop each sent
            alt anonymous
                Server->>Worker: POST { category, title, body, version, secret }
                Worker->>GH: POST /repos/:o/:r/issues/:n/comments (bot)
            else logged-in
                Server->>Cred: read user token
                Server->>GH: POST /repos/:o/:r/issues/:n/comments (as the human)
            end
            GH-->>Server: { html_url }  (the new comment)
            Server->>Store: frontmatter → status sent, sent_at, comment_url
        end
        Server-->>Agent: { results[] }
    else Discard
        Agent->>Server: discard_feedback({ paths[] })
        loop each path
            Server->>Store: delete file
        end
        Server-->>Agent: { results[] }
    else Defer or dismiss
        Note over Agent: no-op — backlog kept
    end
```

## Identity & authentication

The logged-in path authors the comment as the human, so it needs a GitHub token that acts as the
human. It is obtained with the **GitHub OAuth App device flow** — the flow GitHub prescribes for
headless/CLI clients — and the human **never pastes a token to the agent**; they authorize
in-browser.

- **Public client, no secret shipped.** The device-flow token exchange requires only the OAuth
  App's **`client_id`** (public) — GitHub's docs are explicit that _"the `client_secret` is not
  needed for the device flow."_ The `client_id` is embedded in the build; no secret is ever
  distributed. The OAuth App must have **"Enable Device Flow"** turned on (an app-owner setting,
  set once).
- **Scope, and who can file.** A single build-time constant `OAUTH_SCOPE` — **`public_repo`** now
  that the repo is public (`repo` if it ever goes private again). Commenting on a **public** repo's
  issue is available to **any authenticated GitHub user**, so the logged-in path is open to
  everyone, not just collaborators — a key reason comments (over sub-issues) suit a public,
  community-facing tracker.
- **The handshake** (`github_auth_start` → `github_auth_poll`):
  1. `github_auth_start` requests a device + user code and returns
     `{ user_code, verification_uri, expires_in, interval }`.
  2. The agent shows the human the `user_code` and `verification_uri`
     (`https://github.com/login/device`).
  3. `github_auth_poll` polls the token endpoint, honoring `interval` and backing off on
     `slow_down`. It resolves to `authorized` (token obtained), `pending`, `denied`
     (`access_denied` — the human cancelled), or `expired` (`expired_token` — restart).
  4. On `authorized` the server fetches the identity (`GET /user`) and caches it.
- **Token lifetime.** An OAuth App user token does not expire by default (GitHub revokes it only
  after a year unused), so the human authorizes **once**; there is no refresh loop.
- **Identity for display.** `GET /user` yields `login`, `name`, and `email`. `email` is `null`
  when the human keeps it private; the display email then falls back to the GitHub noreply
  address `{id}+{login}@users.noreply.github.com`, and the display name falls back to `login`.
  The gate shows `name <email>`.
- **No access.** A logged-in comment can still fail with `403`/`404` in edge cases (the user is
  blocked, the conversation is locked, or an interaction limit applies). The item is then kept and
  the human is offered the anonymous path instead.

**Prerequisites (provided out-of-band by the app owner):** register one OAuth App with Device
Flow enabled (→ `client_id`); create the two standing category issues and set their numbers
(`BUGS_ISSUE`, `PROPOSALS_ISSUE`).

## Credential & preference store

A local store (`~/.figma-agent-bridge`, the same root as the feedback store) holds the identity
**preference** (`anonymous` | `github`), the human's **OAuth token**, and the **cached identity**
(`login`, `name`, `email`). It is the piece that lets the gate show `name <email>` across
restarts and lets `send_feedback` reuse the remembered choice without re-asking. The **preference**
is written from the `identity` passed to `send_feedback`, so an **anonymous** choice is remembered
exactly like a GitHub login — the first-run attribution step never re-appears.

- **Secure by default, with a fallback.** The token is written via **`Bun.secrets`** — Bun's
  built-in credential API, which maps to the macOS **Keychain**, Windows **Credential Manager**
  (DPAPI-encrypted), and Linux **libsecret**, and works inside a `bun build --compile` binary
  with no native addon. `Bun.secrets` is feature-detected (it is recent and experimental); when
  it is unavailable the store falls back to a **`0600` file** at
  `~/.figma-agent-bridge/credentials.json` (POSIX perms are a no-op on Windows — a DPAPI-encrypted
  file is the Windows hardening option).
- **The client-side credential is the human's own.** It is minimally scoped, device-flow
  authorized (never pasted, never a shared secret), and lives only on the human's machine. The
  **shared bot PAT stays in the Worker** and is used only for the anonymous path.
- **Reset.** A send that returns `401` (revoked/invalid token) clears the stored token and marks
  the identity unauthenticated, so the next review re-offers login.

## Data model — one item, one Markdown file

The store is a directory tree under a configurable root (default `~/.figma-agent-bridge/feedbacks`).
**Each feedback item is one Markdown file. The subdirectory is the category, and each category
maps 1:1 to a standing GitHub issue.** The file path is the item's identity — the handle the agent
passes to `send_feedback`. There is no separate id field.

```
~/.figma-agent-bridge/
  feedbacks/
    bugs/        → comment on BUGS_ISSUE
      2026-07-06T2014-resize-node-locked.md
    proposals/   → comment on PROPOSALS_ISSUE
      2026-07-06T2030-batch-postop.md
```

Frontmatter holds everything needed to **show** an item in the gate preview; the body is natural
language for the human read and becomes the GitHub comment body, with the item's `title` as the
comment heading.

```markdown
---
title: resize_node silently no-ops on locked nodes
status: pending          # pending → sent | failed
version: 0.0.1           # figma-agent-bridge version at record time (from package.json)
created: 2026-07-06T20:14:00+08:00
tool: resize_node        # optional context chip; omitted if not tool-specific
sent_at:                 # ISO 8601, filled on successful send
comment_url:             # URL of the filed comment, filled on successful send
---

Called resize_node on a locked frame; got a success result but nothing changed.
Expected either a mutation or an explicit "node is locked" error.
```

| Field | Source | Purpose |
|---|---|---|
| `title` | agent (`record_feedback`) | Gate preview label; the comment's heading |
| `status` | server | `pending` → `sent` \| `failed` |
| `version` | server (`package.json`) | Ties the report to the build it came from |
| `created` | server | Sort order |
| `tool` | agent (optional) | Context chip; may be absent |
| `sent_at` | server | Audit; set on successful send |
| `comment_url` | server (from GitHub) | The filed comment's URL |

The **category is the directory**, not a frontmatter field — routing is unambiguous end to end
(file → category → standing issue). The category value **is** the directory name — so `bugs` and
`proposals` are the two categories to start; adding one is a new subdirectory + an issue mapping
(see *Extending categories*).

**Defer keeps, Discard deletes, Report files.** The gate acts on the whole batch: **Defer** (or
dismiss) leaves every item `pending` for a later review; **Report** files each item and moves it to
`sent`; **Discard** removes every pending item's file — it is not a status, it is gone. There is no
_per-item_ discard; the human chooses once for the whole batch.

### Filename convention

`<ISO-8601-compact>-<slug>.md`, e.g. `2026-07-06T2014-resize-node-locked.md`. The timestamp keeps
files sorted and unique; the slug (derived from the title) keeps them human-scannable. The server
owns filename generation.

## Components

### `packages/shared`
- A `FeedbackItem` type and a `FeedbackCategory` enum (`bugs` | `proposals` — values equal the
  directory names), colocated with the existing schema exports. **No feedback frame types in
  `ws-schemas`** — feedback does not travel over the relay.

### `packages/server`
- **`record_feedback` MCP tool** — a neutral capture capability. Runs entirely server-side: it
  writes the Markdown file with `status: pending`. Params: `{ category, title, description,
  tool? }`.
- **`feedback-store.ts`** — the only module that touches the feedback filesystem: create dirs,
  write an item, parse/serialize frontmatter, list `pending` (bounded), update status
  (`markSent` / `markFailed`), and **`discard`** (hard-delete a file — the removal behind
  `discard_feedback`). Frontmatter round-trips losslessly.
- **`credential-store.ts`** (new) — the identity preference + OAuth token + cached identity,
  backed by `Bun.secrets` with a `0600`-file fallback (see [Credential &
  preference store](#credential--preference-store)).
- **`github-client.ts`** (new) — the direct GitHub client for the logged-in path: the device
  flow (`startDeviceAuth`, `pollDeviceAuth`), `fetchIdentity` (`GET /user`), and
  **`postIssueComment`** — posts a comment on the category's issue
  (`POST /repos/:o/:r/issues/:n/comments`) and returns its `html_url`.
- **`worker-client.ts`** — the anonymous path: an HTTPS POST to the CloudFlare Worker sending
  `{ category, title, body, version, secret }`, returning `{ comment_url }` (the bot's comment
  URL).
- **The review-and-file meta-tools** — global (machine-scoped, no `fileKey`): they do **not**
  spread the `fileTargetParamsSchema` mixin, exactly like `record_feedback`.
  - `list_feedback({ cursor?, limit?=100 }) → { pending: FeedbackItem[], truncated, cursor?, identity: { preference, name?, login?, email? } | null }`
    — a bounded page of the pending backlog (Rule A, T10 — the skill drains the `cursor` until
    exhausted to present the whole backlog) plus the remembered identity, so the agent can build
    the gate and decide whether to ask about identity.
  - `send_feedback({ send: path[], add?: { title, description, category }, identity?: 'anonymous' | 'github' }) → { results: { path, status: 'sent' | 'failed', comment_url?, error? }[] }`
    — files each `send` item as a comment on its category issue (anonymous → Worker/bot; github →
    direct as the human via `postIssueComment`) and, when `add` is present, records that
    human-authored item and files it too. Each result carries the item's `path`, its terminal
    `status`, and the `comment_url` on success or an `error` on failure, so the skill can report
    partial outcomes. `identity` defaults to the remembered preference, and `send_feedback` persists
    the `identity` it used as the remembered preference (so an anonymous choice is remembered too).
    On **Report** the review passes every pending path as `send`.
  - `discard_feedback({ paths: path[] }) → { results: { path, ok, error? }[] }` — **hard-deletes**
    each item's Markdown file from the store (no soft state, no network). Each result carries the
    item's `path` and `ok`, or an `error` if the delete failed and the item was kept. On **Discard**
    the review passes every pending path.
  - `github_auth_start() → { user_code, verification_uri, expires_in, interval }` — begins the
    device flow.
  - `github_auth_poll() → { status: 'pending' | 'authorized' | 'expired' | 'denied', identity?, interval? }`
    — polls for the token; on `authorized`, the token + identity are stored and returned.
- **Config:** `FEEDBACK_DIR` (default `~/.figma-agent-bridge/feedbacks`); `WORKER_URL`,
  `WORKER_SECRET` (anonymous path); `REPO`, `BUGS_ISSUE`, `PROPOSALS_ISSUE` (the standing category
  issue numbers, required client-side for the direct logged-in path); `OAUTH_CLIENT_ID`,
  `OAUTH_SCOPE` (device flow).

### `packages/figma-plugin`
- **No feedback UI and no feedback relay handling.** The panel is the status monitor; feedback
  is agent-driven and never reaches the iframe. `code.ts` is not involved.

### `packages/worker` (CloudFlare Worker — anonymous path)
- Validates the shared secret (`SHARED_SECRET`), maps `category → issue#` by convention
  (`<CATEGORY>_ISSUE`), and files a **comment** via the GitHub API
  (`POST /repos/:o/:r/issues/:n/comments`) using `GITHUB_TOKEN` (a fine-grained bot PAT with
  issues:write, held as a Worker secret). Composes the comment body from `title`, `body`,
  `version`; returns `{ comment_url }`. Secrets: `GITHUB_TOKEN`, `SHARED_SECRET`. Vars: `REPO`,
  `BUGS_ISSUE`, `PROPOSALS_ISSUE`.

## The end-of-work review (plugin layer — `figma-feedback` skill, P1)

_When_ to raise the review and _how_ to frame it is opinion, owned by the `figma-feedback` skill
([[figma-bridge/docs/specs/claude-plugin|claude-plugin.md]] §6.3). Summarized here only to make
the mechanism above legible; the skill is the source of truth. The human is **never asked to triage
issues one by one** — the choice is on the whole batch:

- **When.** At the end of a unit of work, when the pending backlog is non-empty. The **top-level
  agent** runs it (`AskUserQuestion` is a main-agent affordance; subagents only `record_feedback`).
- **Gate — one three-way choice on the whole batch** (always shown). _"I hit N tool limitation(s)
  — ‹a few titles› — what should I do?"_
  - **Report them → file all N.** For a returning user the Report option carries the remembered
    attribution — _Report as `name <email>`_ or _Report anonymously_ — so they see whose account
    (or the bot) will author the comments before confirming.
  - **Defer to next time → stop:** nothing is sent and **nothing is deleted**; the items are kept
    for a later review. Dismissing the gate is treated as **Defer**.
  - **Discard → delete all N unsent:** the backlog is cleared and nothing is filed.
- **"Something else" — an add on any Report.** The gate always offers a free-text _"something else"_
  so the human can add one issue in their own words on any Report, independent of the first-run
  attribution step below.
- **Attribution — first-time users only.** On the first **Report** (when `identity` is `null`) the
  human is asked _under my GitHub account_ vs _anonymously_; logging in runs the device-flow
  handshake. **Either choice is remembered** (github or anonymous), so a returning user skips this
  step and Reports straight through under the remembered identity.
- **"Something else" is composed, never raw.** For the free-text, the agent does **not** forward
  the human's words. It investigates (reproduce, identify the tool + expected-vs-actual, gather
  context), writes a proper bug or proposal, classifies it, and files that as `send_feedback`'s
  `add`. The raw text never leaves the machine.
- **Filing.** **Report** files all pending items via `send_feedback` (`send` = every pending path)
  and the composed item, if any, rides `add`; `identity` is the resolved choice, which
  `send_feedback` remembers as the preference. **Discard** passes every pending path to
  `discard_feedback`, which hard-deletes the files. Either way the human chooses once for the whole
  batch — there is no per-item selection.

## Error handling

| Failure | Behaviour |
|---|---|
| Record — dir/write fails | `record_feedback` returns an error result; no file. |
| Send (anonymous) — Worker unreachable / non-2xx / 401 secret | Item's frontmatter → `failed`; `send_feedback` reports it in `results`; the item is kept for a later review. |
| Send (logged-in) — GitHub `401` (revoked/invalid token) | Clear the stored token, mark identity unauthenticated; item kept; next review re-offers login. |
| Send (logged-in) — GitHub `403`/`404` (blocked / locked / interaction limit) | Item kept; the human is offered the anonymous path. |
| Device flow — `access_denied` / `expired_token` / `slow_down` | Cancelled → re-offer the attribution choice with the anonymous option (items stay pending, nothing filed); expired → restart `github_auth_start`; slow_down → adopt the new `interval`. |
| Discard — delete fails | Reported in `results`; that item is kept in the backlog. |
| Server not running | The agent cannot call the tools; nothing is filed. |

The **shared bot secret never leaves the Worker**; the **human's own token never leaves their
machine** (server env + OS keychain). No shared credential is ever shipped in the build or sent to
the agent.

## Principle alignment

- **T6 / T7 — non-facade meta-tools (documented exception).** `record_feedback`, `list_feedback`,
  `send_feedback`, `discard_feedback`, `github_auth_start`, and `github_auth_poll` are meta-tools
  about the bridge
  experience, not Figma capabilities. They are admitted knowingly (the agent has no other channel
  to capture and file friction), quarantined in the `feedback` group, and recorded in
  [[figma-bridge/docs/specs/tool-surface|tool-surface.md]]'s count formula as non-facade —
  siblings of `report_status`. Precedent: `get_document_info` / `close_plugin`.
- **P1 — no opinion in the tools.** _When_ to record and _when/how_ to raise the review lives in
  the `figma-feedback` skill. Every feedback tool description states only what the tool does.
- **B1 — uniform contract; the relay stays dumb.** Every feedback tool uses the standard MCP
  result/error contract. Feedback carries **no relay frames at all** — it never touches the pipe,
  so the bridge gains no feedback semantics.
- **T10 — bounded by default.** `list_feedback` returns a bounded page of pending items, never an
  unbounded flush of a large backlog.
- **No shared secret on the client (a design property; principles.md is silent on credentials).**
  No _shared_ secret ever reaches the client — the bot PAT stays in the Worker (anonymous path).
  The only client-side credential is the **human's own** token: device-flow-authorized (no client
  secret shipped, nothing pasted), minimally scoped, OS-keychain-stored, on the human's own machine.

## Extending categories

Adding a category (e.g. `questions`) touches: (1) the `FeedbackCategory` enum in
`packages/shared`; (2) a new subdirectory under `feedbacks/` (created on first write); (3) a new
standing issue + its `category → issue#` mapping — a `QUESTIONS_ISSUE` var in the Worker
(anonymous path) and the client-side issue map (logged-in path). No new tools, no relay changes.

## Testing

- **server unit** — `feedback-store` frontmatter round-trip, status update, and `discard` (delete);
  `credential-store` round-trip against a `Bun.secrets` mock **and** the `0600`-file fallback (incl.
  feature-detect); `github-client` device flow (`start`/`poll`, including `slow_down` /
  `expired_token` / `access_denied`), `fetchIdentity`, and **`postIssueComment`** (success +
  `401`/`404`) against a mocked `fetch`; `send_feedback` — `send` (anonymous → mocked Worker; github
  → mocked GitHub comment, authored) and `add` (created + filed); `discard_feedback` — batch file
  delete.
- **e2e (mock plugin) — N/A for these tools.** The feedback meta-tools are machine-global and never
  round-trip through the Figma plugin, so the mock-plugin e2e harness does not apply; the handler
  tests above (real store + credential-store + mocked `fetch`) are the end-to-end coverage.
- **live-verify** — the real three-way gate + first-run form; one real device-flow login; a real
  comment posted **as the human** and **as the bot**; **Report** files every pending item; **Defer**
  leaves the backlog intact; **Discard** clears it unsent; the free-text "something else" ships a
  composed report (not the raw text).

## Out of scope (YAGNI)

- **Switching a remembered identity mid-flow / an explicit logout tool.** Re-auth happens
  automatically on a `401`; a deliberate identity switch is deferred.
- **A GitHub App / fine-grained least-privilege token.** The OAuth App device flow is the chosen
  mechanism; the repo is public, so `public_repo` suffices.
- **Editing feedback bodies from the review** — edit the Markdown file or the comment on GitHub.
- **Auto-send** — the gate is the point.
- **Reading GitHub comments back into the tool** — triage is a separate read of the two issues.
- **Per-item arbitrary issue targeting** — category → standing issue is the routing model.
