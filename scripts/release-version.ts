// Decide the version argument the release pipeline hands to `bump`
// (docs/specs/dev-ops.md §6.5 and §7 step 3).
//
//   merge trigger   -> the bump TYPE derived from the release PR's labels
//   manual dispatch -> the exact version STRING the operator supplied
//
// The whole decision lives here, not in workflow YAML, because a wrong
// answer mis-numbers a release and inline shell in a workflow is only
// ever exercised by cutting a real one.

export type Bump = 'patch' | 'minor' | 'major'

const RANK: Record<Bump, number> = {
  patch: 0,
  minor: 1,
  major: 2,
}

const isBump = (s: string): s is Bump =>
  s === 'patch' || s === 'minor' || s === 'major'

// Larger bump wins when several release labels are present, and no
// release label at all resolves to `patch` (§6.5). Labels that are not
// `release:*` are ignored — a release PR carries others too.
export const resolveBump = (labelNames: string[]): Bump => {
  let winner: Bump = 'patch'
  for (const name of labelNames) {
    const suffix = name.trim().replace(/^release:/, '')
    if (
      suffix !== name.trim() &&
      isBump(suffix) &&
      RANK[suffix] > RANK[winner]
    ) {
      winner = suffix
    }
  }
  return winner
}

// A bare X.Y.Z, optionally with a pre-release tail. Shared with
// scripts/stamp-version.ts so the two agree by construction: the
// release turns this number into the git tag `vX.Y.Z`, an `npm view`
// argument, and a tarball filename.
const BARE_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const isBareSemver = (s: string) =>
  BARE_SEMVER.test(s)

// A dispatched release stamps the string it is given, verbatim (§7):
// the pipeline deliberately does NOT check it is >= the
// version-of-record, which is operator discipline.
//
// Checking its SHAPE is a different rule and is not that check. `bump`
// reads its first argument as a release TYPE when it looks like one, so
// a dispatch of `patch` would compute a bump instead of stamping a
// version, `prompt` would block on a TTY that CI does not have, and
// `v0.4.0` would be read as a filename. Anything that is not a bare
// semver number is refused here.
export const assertExplicitVersion = (raw: string) => {
  const v = raw.trim()
  if (!isBareSemver(v)) {
    throw new Error(
      `dispatch version must be a bare semver number such as 0.4.0 — got ${JSON.stringify(raw)}. ` +
        'A leading "v", a bump word (patch/minor/major/prompt), or an empty value is refused: ' +
        '`bump` would read it as a release type or a filename, not as the version to stamp.',
    )
  }
  return v
}

export const decide = (
  env: Record<string, string | undefined>,
) => {
  const trigger = env.RELEASE_TRIGGER
  if (trigger === 'workflow_dispatch') {
    return assertExplicitVersion(env.INPUT_VERSION ?? '')
  }
  if (trigger === 'pull_request') {
    const raw = env.LABELS_JSON ?? '[]'
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        `LABELS_JSON is not valid JSON: ${JSON.stringify(raw)}`,
      )
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `LABELS_JSON is not an array: ${JSON.stringify(raw)}`,
      )
    }
    return resolveBump(parsed.map(String))
  }
  throw new Error(
    `unknown RELEASE_TRIGGER: ${JSON.stringify(trigger ?? null)}`,
  )
}

if (import.meta.main) {
  try {
    process.stdout.write(`${decide(process.env)}\n`)
  } catch (err) {
    console.error(
      `release-version: ${(err as Error).message}`,
    )
    process.exitCode = 1
  }
}
