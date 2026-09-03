import { expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  act,
  classifyInstance,
  stripTemplateVersion,
} from '../scripts/dev-prefs-link'

const SKILL_TMPL =
  '---\nname: figma-bridge-prefs\ntemplate_version: 0.2.0\n---\nbody\n'

const exists = async (p: string): Promise<boolean> => {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

/** A fake template + a sandbox to put instances in. */
const sandbox = async (): Promise<{
  template: string
  root: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'dev-prefs-'))
  const template = join(root, 'template')
  await mkdir(join(template, 'references'), {
    recursive: true,
  })
  await writeFile(
    join(template, 'SKILL.md.tmpl'),
    SKILL_TMPL,
  )
  await writeFile(
    join(template, 'references/house-style.md'),
    '# house\n',
  )
  await writeFile(
    join(template, 'references/review-standards.md'),
    '# review\n',
  )
  return { template, root }
}

const copyInstance = async (
  template: string,
  dir: string,
  skill = SKILL_TMPL,
): Promise<void> => {
  await mkdir(join(dir, 'references'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skill)
  for (const f of [
    'house-style.md',
    'review-standards.md',
  ]) {
    await writeFile(
      join(dir, 'references', f),
      await readFile(join(template, 'references', f)),
    )
  }
}

test('stripTemplateVersion drops only the stamp line', () => {
  expect(
    stripTemplateVersion('a\ntemplate_version: 0.1.0\nb'),
  ).toBe('a\nb')
  expect(stripTemplateVersion('a\nb')).toBe('a\nb')
})

test('an absent instance classifies absent and gains links', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'instance')
  expect(
    (await classifyInstance(dir, template)).state,
  ).toBe('absent')
  const r = await act(dir, template, 'project')
  expect(r.action).toBe('created-links')
  expect(
    (await lstat(join(dir, 'SKILL.md'))).isSymbolicLink(),
  ).toBe(true)
  expect(await readlink(join(dir, 'references'))).toContain(
    'template/references',
  )
  expect(
    (await classifyInstance(dir, template)).state,
  ).toBe('linked')
})

test('a linked instance is a no-op (idempotent)', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'instance')
  await act(dir, template, 'project')
  const r = await act(dir, template, 'project')
  expect(r.action).toBe('noop')
  expect(r.state).toBe('linked')
})

test('links onto the wrong target are repaired', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'instance')
  await mkdir(dir, { recursive: true })
  await symlink('/nowhere', join(dir, 'SKILL.md'))
  await symlink('/nowhere-else', join(dir, 'references'))
  expect(
    (await classifyInstance(dir, template)).state,
  ).toBe('wrong-links')
  const r = await act(dir, template, 'project')
  expect(r.action).toBe('repaired-links')
  expect(
    (await classifyInstance(dir, template)).state,
  ).toBe('linked')
})

test('a byte-identical copy swaps to links', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'instance')
  await copyInstance(template, dir)
  expect(
    (await classifyInstance(dir, template)).state,
  ).toBe('identical-copy')
  const r = await act(dir, template, 'project')
  expect(r.action).toBe('swapped-to-links')
  expect(
    (await classifyInstance(dir, template)).state,
  ).toBe('linked')
})

test('a copy differing only by template_version still counts identical', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'instance')
  await copyInstance(
    template,
    dir,
    SKILL_TMPL.replace('0.2.0', '0.1.0'),
  )
  expect(
    (await classifyInstance(dir, template)).state,
  ).toBe('identical-copy')
})

test('a divergent copy guards and touches nothing', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'instance')
  await copyInstance(template, dir)
  await writeFile(
    join(dir, 'references/house-style.md'),
    '# house\nlocal edit\n',
  )
  const c = await classifyInstance(dir, template)
  expect(c.state).toBe('divergent-copy')
  expect(c.divergent).toEqual(['references/house-style.md'])
  const r = await act(dir, template, 'project')
  expect(r.action).toBe('guard')
  expect(
    (await lstat(join(dir, 'SKILL.md'))).isSymbolicLink(),
  ).toBe(false)
})

test('an extra file is divergence, named as extra', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'instance')
  await copyInstance(template, dir)
  await writeFile(
    join(dir, 'references/notes.md'),
    'mine\n',
  )
  const c = await classifyInstance(dir, template)
  expect(c.state).toBe('divergent-copy')
  expect(c.divergent).toEqual([
    'references/notes.md (extra)',
  ])
})

test('user scope: an identical copy is removed, not linked', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'user-instance')
  await copyInstance(template, dir)
  const r = await act(dir, template, 'user')
  expect(r.action).toBe('removed')
  expect(await exists(dir)).toBe(false)
})

test('user scope: a divergent copy guards and stays', async () => {
  const { template, root } = await sandbox()
  const dir = join(root, 'user-instance')
  await copyInstance(template, dir)
  await writeFile(
    join(dir, 'SKILL.md'),
    'rewritten entirely\n',
  )
  const r = await act(dir, template, 'user')
  expect(r.action).toBe('guard')
  expect(await exists(dir)).toBe(true)
})

test('user scope: absent stays absent', async () => {
  const { template, root } = await sandbox()
  const r = await act(join(root, 'nope'), template, 'user')
  expect(r.action).toBe('noop')
  expect(r.state).toBe('absent')
})
