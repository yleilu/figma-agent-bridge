---
title: figma-agent-bridge — Identifier Generation Spec
created: 2026-07-09T17:51:45+08:00
tags:
  - spec
  - figma-bridge
  - id-generation
type: spec
related:
  - "[[figma-bridge/docs/principles]]"
  - "[[figma-bridge/docs/specs/overview]]"
  - "[[figma-bridge/docs/specs/component-index]]"
---

# figma-agent-bridge — Identifier Generation

One standard for minting **random identifiers** — message-correlation ids and the
per-session channel token — across every runtime the codebase spans. A single
shared helper, a named library algorithm, short output, and no dependency on any
API that is absent in the plugin's iframe.

## Two families — do not cross them

The codebase mints identifiers for two fundamentally different purposes. They have
opposite requirements, so they use different tools.

| Family | Requirement | Tool | This spec |
|---|---|---|---|
| **Random identifier** — correlate a reply, name a session | every call **differs**; collision-resistant | `genId` / `genToken` (`nanoid/non-secure`) | ✅ governs |
| **Deterministic fingerprint** — detect change, version a set | same input **collides on purpose** | `sha1` (`node:crypto`) | ❌ out of scope |

The deterministic family (component-index `computeSignature` / `membershipFingerprint`,
the pagination cursor's `versionOf`) is content-hashing: identical input must yield
identical output. It runs Node-side only, is already a named algorithm, and is
**not** reached by this spec. Never use `genId` where a fingerprint is meant, or a
hash where a fresh id is meant.

## Constraints

- **Runs everywhere.** The same identifier code executes in three realms: Node/Bun
  (server, relay), the Figma **plugin sandbox** (`code.ts`), and the **plugin UI
  iframe**. On Figma desktop the iframe is a **non-secure context**, where the
  secure-context Web Crypto surface (`crypto.randomUUID`, `crypto.subtle`) is
  **undefined and throws**. The identifier path must therefore depend on **no
  secure-context API**.
- **Not a secret.** These ids are correlation keys within a localhost relay channel,
  not credentials. Uniqueness and collision-resistance are the only requirements;
  cryptographic-strength randomness is neither needed nor claimed.
- **Short.** Compact enough to read in logs and wire frames — not a 36-char UUID.
- **Named algorithm, from a library.** Not a hand-rolled `Date.now()`/`Math.random()`
  concatenation; a maintained, documented generator.

## The standard

**Library:** [`nanoid`](https://github.com/ai/nanoid), via its **`nanoid/non-secure`**
entry point. Same nanoid algorithm; its RNG is `Math.random()`, so it carries **no
crypto dependency** and runs identically in every realm — the code proven headlessly
in Node is byte-for-byte the code that runs in the iframe, so the iframe path cannot
silently diverge. The non-secure RNG is adequate precisely because these ids are not
secrets.

**Home:** `packages/shared/src/id.ts`, re-exported from the shared barrel
(`packages/shared/src/index.ts`) and imported by every package.

**Alphabet:** lowercase alphanumeric — `0123456789abcdefghijklmnopqrstuvwxyz` (36
symbols). Channel-safe and case-insensitive, matching the channel-name grammar.

```ts
import { customAlphabet } from 'nanoid/non-secure'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const id12 = customAlphabet(ALPHABET, 12)

/** A fresh random identifier. With a prefix: `<prefix>-<12 chars>`. */
export const genId = (prefix?: string): string =>
  prefix ? `${prefix}-${id12()}` : id12()

/** A fresh fixed-length token (default 8). */
export const genToken = (size = 8): string =>
  customAlphabet(ALPHABET, size)()
```

- **`genId(prefix?)`** → the id on any relay/message frame that expects a reply, plus
  any per-connection tracking id. 12-char body; the optional prefix is a human-readable
  tag (e.g. the command name) and never carries meaning for correlation.
- **`genToken(size = 8)`** → a fixed-length opaque token. 8-char default.

## Where it applies

- **Every random identifier goes through `genId` / `genToken`.** No inline
  `crypto.randomUUID()`, `Math.random()` id strings, or ad-hoc char loops remain in
  application code. This is the enforceable rule: a fresh identifier is a helper call.
- **Correlation ids (`genId`)** — the relay's system-message reply ids and
  per-connection client id; the server's command-send and notify ids (the request's
  `meta.requestId` is `genId('cmd')`, per
  [[figma-bridge/docs/specs/request-envelope|request-envelope.md]]); the plugin UI's
  relay request id and its index-stale push id. *(The request `sessionId` is **not** minted
  here — it is the Claude Code `session_id`, hook-injected, per request-envelope.)*
- **Channel token (`genToken(8)`)** — the per-session channel name for a **never-saved**
  file, which has no stable `figma.fileKey`. A **saved** file's channel is
  **deterministic** (`file-${fileKey}`, see [[figma-bridge/docs/specs/component-index]]
  file identity) and is **not** a random token — `genToken` does not apply there.

## Non-goals

- **Not a security token.** No unguessability guarantee; do not use for auth, signing,
  or anything a `Math.random()` stream would compromise.
- **Deterministic fingerprints and cursors** stay on `sha1` — see *Two families*.
- **Test fixtures.** Mock node ids in the test suite are throwaway sample data, not
  application identifiers, and are outside this standard.

## Collision characteristics

Over the 36-symbol alphabet, `genId`'s 12-char body spans 36¹² ≈ 4.7 × 10¹⁸ values and
`genToken(8)` spans 36⁸ ≈ 2.8 × 10¹² — both far beyond the count of concurrent
correlation ids in flight on a channel or of live per-session channels. Correlation ids
are also short-lived (matched and discarded on reply), so the effective population is
tiny. Non-secure RNG does not change this: collision-resistance here is a function of
output space and population, not of RNG cryptographic strength.
