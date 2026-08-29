// dev-prefs-link — converge the dev machine's figma-bridge-prefs onto the
// shipped template via entry-level symlinks (customization.md §6 "Dev mode").
//
// A real user gets a COPY on the initial install and owns it. A dev checkout
// links the instance onto the template instead, so editing the example is
// testing it. This script is the sanctioned way to create or repair those
// links (dev-ops.md §3.6): `install-local.sh --dev` runs it after the install.
//
// Two scopes exist and user scope SHADOWS project scope, so the convergence
// target is ONE project-scoped linked instance:
//   - project (<repo>/.claude/skills/figma-bridge-prefs): linked.
//   - user (~/.claude/skills/figma-bridge-prefs): removed when it holds
//     nothing of its own (links, or a byte-identical copy).
// A DIVERGENT copy is never touched, in either scope: the guard names the
// differing files and the remedy (fold the wanted changes into the template,
// then re-run). Deleting divergence would eat someone's edits; the linked
// model only ever replaces what the template already holds.
//
// The `template_version:` line is IGNORED when comparing SKILL.md against
// SKILL.md.tmpl — the stamp is the §9 contract marker for USER copies, and
// killing its drift class is the whole point of the links.
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

export type InstanceState =
  | 'absent'
  | 'linked'
  | 'wrong-links'
  | 'identical-copy'
  | 'divergent-copy'

export type Classification = {
  state: InstanceState
  /** The files that differ / are missing / are extra (divergent-copy only). */
  divergent?: string[]
}

/** SKILL.md compared without the §9 stamp line. */
export const stripTemplateVersion = (s: string): string =>
  s
    .split('\n')
    .filter(l => !/^template_version:/.test(l))
    .join('\n')

const isSymlink = async (p: string): Promise<boolean> => {
  try {
    return (await lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

const resolves = async (
  link: string,
  target: string,
): Promise<boolean> => {
  try {
    return (
      (await realpath(link)) === (await realpath(target))
    )
  } catch {
    return false
  }
}

/** Every file under `dir`, as paths relative to it. */
const walk = async (
  dir: string,
  prefix = '',
): Promise<string[]> => {
  const out: string[] = []
  for (const e of await readdir(dir, {
    withFileTypes: true,
  })) {
    const rel =
      prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) {
      out.push(...(await walk(join(dir, e.name), rel)))
    } else {
      out.push(rel)
    }
  }
  return out.sort()
}

export const classifyInstance = async (
  dir: string,
  template: string,
): Promise<Classification> => {
  if (
    !(await exists(dir)) ||
    (await readdir(dir)).length === 0
  ) {
    return { state: 'absent' }
  }
  const skill = join(dir, 'SKILL.md')
  const refs = join(dir, 'references')
  const tmplSkill = join(template, 'SKILL.md.tmpl')
  const tmplRefs = join(template, 'references')

  const skillLinked = await isSymlink(skill)
  const refsLinked = await isSymlink(refs)
  if (skillLinked || refsLinked) {
    return skillLinked &&
      refsLinked &&
      (await resolves(skill, tmplSkill)) &&
      (await resolves(refs, tmplRefs))
      ? { state: 'linked' }
      : { state: 'wrong-links' }
  }

  // Real files: byte-compare against the template.
  const divergent: string[] = []
  if (!(await exists(skill))) {
    divergent.push('SKILL.md (missing)')
  } else if (
    stripTemplateVersion(await readFile(skill, 'utf8')) !==
    stripTemplateVersion(await readFile(tmplSkill, 'utf8'))
  ) {
    divergent.push('SKILL.md')
  }
  const tmplFiles = (await exists(tmplRefs))
    ? await walk(tmplRefs)
    : []
  const instFiles = (await exists(refs))
    ? await walk(refs)
    : []
  for (const f of tmplFiles) {
    if (!instFiles.includes(f)) {
      divergent.push(`references/${f} (missing)`)
    } else if (
      !(await readFile(join(refs, f))).equals(
        await readFile(join(tmplRefs, f)),
      )
    ) {
      divergent.push(`references/${f}`)
    }
  }
  for (const f of instFiles) {
    if (!tmplFiles.includes(f)) {
      divergent.push(`references/${f} (extra)`)
    }
  }
  for (const e of await readdir(dir)) {
    if (e !== 'SKILL.md' && e !== 'references') {
      divergent.push(`${e} (extra)`)
    }
  }
  return divergent.length === 0
    ? { state: 'identical-copy' }
    : { state: 'divergent-copy', divergent }
}

const link = async (
  from: string,
  to: string,
): Promise<void> => {
  await symlink(relative(dirname(from), to), from)
}

/** What `act` did, for the report and the tests. */
export type ActionResult = {
  state: InstanceState
  action:
    | 'created-links'
    | 'repaired-links'
    | 'swapped-to-links'
    | 'removed'
    | 'noop'
    | 'guard'
  divergent?: string[]
}

export const act = async (
  dir: string,
  template: string,
  scope: 'project' | 'user',
): Promise<ActionResult> => {
  const c = await classifyInstance(dir, template)
  const tmplSkill = join(template, 'SKILL.md.tmpl')
  const tmplRefs = join(template, 'references')
  const makeLinks = async (): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await rm(join(dir, 'SKILL.md'), { force: true })
    await rm(join(dir, 'references'), {
      recursive: true,
      force: true,
    })
    await link(join(dir, 'SKILL.md'), tmplSkill)
    await link(join(dir, 'references'), tmplRefs)
  }

  if (c.state === 'divergent-copy') {
    return {
      state: c.state,
      action: 'guard',
      divergent: c.divergent,
    }
  }
  if (scope === 'user') {
    // One instance on a dev machine: a user-scope duplicate SHADOWS the
    // project links, so anything it does not own is removed.
    if (c.state === 'absent') {
      return { state: c.state, action: 'noop' }
    }
    await rm(dir, { recursive: true, force: true })
    return { state: c.state, action: 'removed' }
  }
  switch (c.state) {
    case 'linked':
      return { state: c.state, action: 'noop' }
    case 'absent':
      await makeLinks()
      return { state: c.state, action: 'created-links' }
    case 'wrong-links':
      await makeLinks()
      return { state: c.state, action: 'repaired-links' }
    case 'identical-copy':
      await makeLinks()
      return { state: c.state, action: 'swapped-to-links' }
  }
}

const report = (
  label: string,
  dir: string,
  r: ActionResult,
): void => {
  if (r.action === 'guard') {
    console.log(
      `!! ${label}: DIVERGENT copy at ${dir} — not touched.`,
    )
    for (const f of r.divergent ?? []) {
      console.log(`     differs: ${f}`)
    }
    console.log(
      '     Remedy: fold the wanted changes into the shipped template',
    )
    console.log(
      '     (plugin/skills/figma-setup/references/figma-bridge-prefs-template/),',
    )
    console.log(
      '     then re-run install:local --dev. The template is the example;',
    )
    console.log('     dev instances only ever link to it.')
    return
  }
  const verb = {
    'created-links': 'links created',
    'repaired-links': 'links repaired',
    'swapped-to-links':
      'identical copy swapped to links (nothing lost)',
    removed: `${r.state} removed (user scope shadows the project links)`,
    noop:
      r.state === 'absent'
        ? 'absent — nothing to do'
        : 'already linked',
  }[r.action]
  console.log(`   ${label}: ${verb}`)
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '..')
  const template = join(
    repoRoot,
    'plugin/skills/figma-setup/references/figma-bridge-prefs-template',
  )
  if (!(await exists(join(template, 'SKILL.md.tmpl')))) {
    throw new Error(
      `dev-prefs-link: template not found at ${template}`,
    )
  }
  console.log(
    '=== dev prefs (customization.md §6 Dev mode: the instance links onto the template) ===',
  )
  const project = join(
    repoRoot,
    '.claude/skills/figma-bridge-prefs',
  )
  const user = join(
    homedir(),
    '.claude/skills/figma-bridge-prefs',
  )
  report(
    'project scope',
    project,
    await act(project, template, 'project'),
  )
  report(
    'user scope   ',
    user,
    await act(user, template, 'user'),
  )
}
