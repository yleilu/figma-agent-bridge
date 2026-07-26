import { describe, it, expect } from 'bun:test'

// The release pipeline's invariants (docs/specs/dev-ops.md §4.4, §7).
// Every one of these is otherwise only exercised by cutting a real
// release, which is why they are asserted here instead.
const root = new URL('../', import.meta.url).pathname
const workflow = async (name: string) =>
  Bun.YAML.parse(
    await Bun.file(
      `${root}.github/workflows/${name}`,
    ).text(),
  ) as any

const stepNames = (job: any): string[] =>
  job.steps.map((s: any) => s.name ?? s.uses ?? '')

const indexOfStep = (job: any, needle: string) =>
  stepNames(job).findIndex(n => n.includes(needle))

describe('release.yml', () => {
  it('lives at the path npm trusted publishing is bound to', async () => {
    // The trusted-publisher config keys on the workflow FILENAME.
    // Renaming this file breaks publish with a misleading E404.
    expect(
      await Bun.file(
        `${root}.github/workflows/release.yml`,
      ).exists(),
    ).toBe(true)
  })

  it('has exactly the two triggers §7 allows', async () => {
    const w = await workflow('release.yml')
    expect(Object.keys(w.on).sort()).toEqual([
      'pull_request',
      'workflow_dispatch',
    ])
    // `closed` is not in the default activity set, so it must be named
    expect(w.on.pull_request.types).toEqual(['closed'])
    // a leftover `v*` tag trigger would cut a second release from the
    // tag this pipeline pushes
    expect(w.on.push).toBeUndefined()
    expect(
      w.on.workflow_dispatch.inputs.version.required,
    ).toBe(true)
  })

  it('carries the OIDC permission and no concurrency block', async () => {
    const w = await workflow('release.yml')
    // the entire npm publish credential — no token is stored anywhere
    expect(w.permissions['id-token']).toBe('write')
    // §7: the "has main moved?" precondition is the whole of the
    // pipeline's concurrency and staleness discipline
    expect('concurrency' in w).toBe(false)
  })

  it('checks main before doing anything, and checks out main itself', async () => {
    const w = await workflow('release.yml')
    const job = w.jobs.release
    // the precondition is the FIRST step: no gate, no stamp, no build
    // happens before main's tip is confirmed unmoved
    expect(job.steps[0].name).toContain('Precondition')
    expect(JSON.stringify(job.steps[0])).toContain(
      'merge_commit_sha',
    )
    const checkout = job.steps.find((s: any) =>
      (s.uses ?? '').startsWith('actions/checkout'),
    )
    // main as it stands — never a pull request's merge ref
    expect(checkout.with.ref).toBe('main')
    expect(checkout.with['fetch-depth']).toBe(0)
  })

  it('publishes before it pushes, and pushes the commit before the tag', async () => {
    const w = await workflow('release.yml')
    const job = w.jobs.release
    const gate = indexOfStep(job, 'Gate')
    const assertInstall = indexOfStep(
      job,
      'Assert the install',
    )
    const publish = indexOfStep(
      job,
      'Publish the plugin package',
    )
    const pushCommit = indexOfStep(
      job,
      'Push the release commit',
    )
    const pushTag = indexOfStep(job, 'Push the tag')
    const backMerge = indexOfStep(job, 'Back-merge')
    for (const i of [
      gate,
      assertInstall,
      publish,
      pushCommit,
      pushTag,
      backMerge,
    ]) {
      expect(i).toBeGreaterThan(-1)
    }
    // the release's last gate precedes publication (§7 step 5)
    expect(assertInstall).toBeLessThan(publish)
    // git must never claim more than the registry holds (§7)
    expect(publish).toBeLessThan(pushCommit)
    expect(pushCommit).toBeLessThan(pushTag)
    expect(pushTag).toBeLessThan(backMerge)
    // the back-merge alone cannot fail the release (§7 step 9)
    expect(job.steps[backMerge]['continue-on-error']).toBe(
      true,
    )
  })

  it('hands the version decider exactly the env it reads', async () => {
    const w = await workflow('release.yml')
    const job = w.jobs.release
    const step =
      job.steps[indexOfStep(job, 'Decide the version')]
    // scripts/release-version.ts reads these three and nothing else.
    // A dropped or typoed LABELS_JSON is the one silent failure in the
    // design: no labels means `patch`, so a `release:minor` PR would
    // ship an immutable wrong number with no error anywhere.
    expect(Object.keys(step.env).sort()).toEqual([
      'INPUT_VERSION',
      'LABELS_JSON',
      'RELEASE_TRIGGER',
    ])
    expect(step.env.LABELS_JSON).toContain(
      'pull_request.labels.*.name',
    )
  })

  it('commits the stamped version files and nothing else', async () => {
    const w = await workflow('release.yml')
    const job = w.jobs.release
    const step =
      job.steps[indexOfStep(job, 'release commit')]
    for (const f of [
      'package.json',
      'plugin/package.json',
      'plugin/.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
    ]) {
      expect(step.run).toContain(f)
    }
    // an explicit pathspec is what makes "nothing else" (§7) provable
    expect(step.run).toContain('git commit -m "Release')
    expect(step.run).not.toContain('git add')
  })
})

describe('ci.yml', () => {
  it('gates every write to a shared branch (§4.4)', async () => {
    const w = await workflow('ci.yml')
    // push AND pull_request: a merge pushed straight to dev, a hotfix
    // committed straight to main, and the pipeline's back-merge are
    // all gated by the push half
    expect(w.on.push.branches.sort()).toEqual([
      'dev',
      'main',
    ])
    expect('pull_request' in w.on).toBe(true)
    const names = stepNames(w.jobs.verify).join('\n')
    expect(names).toContain('Assert the install')
  })
})
