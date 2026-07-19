import { describe, it, expect } from 'bun:test'
import { lintTemplateFiles } from '../scripts/check-template'

const root = new URL('../', import.meta.url).pathname // test/ -> repo root

const good = [
  {
    path: 'SKILL.md.tmpl',
    content: `---\nname: figma-bridge-prefs\ndescription: x\ntemplate_version: 0.1.0\nseeded_by: figma-agent-bridge\n---\n<!-- FLOOR: never skip verification, never relax contrast or wcag. -->\n# ok\nprefer a design system; every value bound.\n`,
  },
  {
    path: 'references/house-style.md',
    content: `---\nname: figma-bridge-prefs/house-style\ndescription: x\n---\nspacing 4 8 12; you may skip the grid on hero sections.\n`,
  },
]

describe('template lint', () => {
  it('passes a well-formed template (floor sentinel + non-floor skip are fine)', () => {
    expect(lintTemplateFiles(good)).toEqual([])
  })

  it.each([
    'you may disable the contrast check on marketing frames',
    'ignore the wcag ratios for the hero',
    'skipping the read-back on simple edits is fine',
    'relaxes the safety check for speed',
    'bypasses the verify gate',
    'avoid verification on trivial edits',
  ])('flags a floor-relaxing directive: %s', line => {
    const bad = [
      ...good,
      {
        path: 'references/x.md',
        content: `---\nname: x\ndescription: x\n---\n${line}\n`,
      },
    ]
    expect(
      lintTemplateFiles(bad).some(m => /floor/i.test(m)),
    ).toBe(true)
  })

  it('flags a missing template_version on the skill file', () => {
    const bad = good.map(f =>
      f.path === 'SKILL.md.tmpl'
        ? {
            ...f,
            content: f.content.replace(
              /template_version: 0.1.0\n/,
              '',
            ),
          }
        : f,
    )
    expect(
      lintTemplateFiles(bad).some(m =>
        /template_version/.test(m),
      ),
    ).toBe(true)
  })

  it('flags a file over the size cap', () => {
    const bad = [
      ...good,
      {
        path: 'references/big.md',
        content:
          `---\nname: x\ndescription: x\n---\n` +
          'x\n'.repeat(600),
      },
    ]
    expect(
      lintTemplateFiles(bad).some(m =>
        /size|lines/i.test(m),
      ),
    ).toBe(true)
  })

  it('the real shipped template passes', async () => {
    const dir = `${root}plugin/skills/figma-setup/references/figma-bridge-prefs-template`
    const glob = new Bun.Glob('**/*')
    const files = [] as { path: string; content: string }[]
    for await (const p of glob.scan(dir)) {
      if (p.endsWith('.md') || p.endsWith('.tmpl')) {
        files.push({
          path: p,
          content: await Bun.file(`${dir}/${p}`).text(),
        })
      }
    }
    expect(lintTemplateFiles(files)).toEqual([])
  })
})
