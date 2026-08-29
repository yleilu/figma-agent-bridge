// build-id.ts — WHICH BUILD this bundle is, and what a mismatched pair says
// (I62).
//
// Under the CI-only versioning rule every dev build of both sides stamps the
// same version, so the major.minor handshake cannot tell a fresh bundle from a
// weeks-old one. On 2026-08-27 that cost a QA round a category verdict: an
// installed plugin bundle built from older source passed the handshake and
// then answered reads with data that was WRONG rather than absent — 115 text
// nodes reported as carrying no text style when every one of them did, every
// effect reported inline instead of as a style() reference, 71 spurious
// readErrors. All three vanished when dist/code.js was rebuilt from unchanged
// source. A read that is confidently wrong is worse than one that errors (T7),
// and nothing in the protocol could see it.
//
// So each bundle carries the identity of the BUILD that produced it, stamped
// by the bundler that produced it:
//
//   plugin  — vite `define` in vite.config.{code,ui}.ts
//   server  — `bun build --define` in scripts/build-bundle.sh
//
// Both take the value from scripts/build-id.sh, so one `bun run build` stamps
// one id on both halves and a pair that disagrees is a pair that came from two
// different builds.
//
// ADVISORY, ALWAYS. The comparison warns and never refuses: dev iterates fast,
// a half-rebuilt pair is a normal minute of work, and a bridge that refused
// would be unusable exactly when it is being changed. The version handshake
// keeps its refusal; this only adds the fact the version cannot carry.

/**
 * The identifier a bundler stamps in. Declared, never defined in source: the
 * `typeof` guard below is what makes an unstamped run legal, and a real
 * definition here would make the guard always true and the fallback dead.
 */
declare const FIGMA_BRIDGE_BUILD: string | undefined

/**
 * What an UNSTAMPED run reports.
 *
 * A server started as `bun run packages/server/src/index.ts` passed through no
 * build, so it has no build to name. Saying so is the honest answer, and it is
 * also what keeps the comparison quiet for it — see `buildSkew`.
 */
export const SOURCE_BUILD = 'source'

/** This bundle's build identity, or `SOURCE_BUILD` when it was never built. */
export const BUILD_ID: string =
  typeof FIGMA_BRIDGE_BUILD === 'string' &&
  FIGMA_BRIDGE_BUILD.length > 0
    ? FIGMA_BRIDGE_BUILD
    : SOURCE_BUILD

/**
 * What a mismatched pair says, or `null` when there is nothing to say.
 *
 * Silent in three cases, each because the evidence is absent rather than
 * reassuring:
 *   - the two stamps agree — one build made both halves;
 *   - either side ran from SOURCE — a working tree has no build to compare,
 *     and warning on every dev turn would train the reader to ignore this;
 *   - the plugin reported no build at all — an older plugin predates the
 *     stamp, which says nothing about how fresh it is.
 *
 * The message names BOTH stamps and neither side as "the stale one": which
 * half is behind is not knowable from the ids, and the rider on 00b7e10 made
 * exactly that correction to the version message.
 */
export const buildSkew = (
  pluginBuild: string | undefined,
  serverBuild: string = BUILD_ID,
): string | null => {
  if (
    pluginBuild === undefined ||
    pluginBuild.length === 0 ||
    pluginBuild === SOURCE_BUILD ||
    serverBuild === SOURCE_BUILD ||
    pluginBuild === serverBuild
  ) {
    return null
  }
  return (
    `Build skew (advisory): the Figma plugin is build '${pluginBuild}' and ` +
    `the server is build '${serverBuild}'. The two came out of different ` +
    'builds, so one of them is running older code than the other at the ' +
    'same version. Rebuild and reinstall both sides (bun run install:local, ' +
    'then re-run figma-setup) if reads or writes disagree with the source. ' +
    'Nothing is refused on this — it is a fact, not a gate.'
  )
}
