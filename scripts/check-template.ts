// Safety-contract lint for the figma-bridge-prefs template (docs/specs/customization.md §6).
// The template may only make the assistant STRICTER — it must never relax verification or
// destructive-op safety. (Accessibility is a user preference, not a floor — the template sets
// its thresholds, WCAG AA by default.) Runs in `bun run verify` via `check:template`.
const MAX_LINES = 400
// A directive that RELAXES a floor: a relaxing verb (any inflection) within ~40 chars of a floor keyword.
const RELAX =
  /\b(?:skip|relax|disabl|ignor|bypass|suppress|omit|forego|forgo|avoid|leave out|no need to|don'?t (?:run|do|bother)|never (?:run|verify))\w*[^.\n]{0,40}\b(?:verif|read-?back|safety|destructiv|delete)/i

// The a11y default is a PREFERENCE, so the relax scan ignores it (§6). This positive assertion
// guards it instead: the shipped template must still carry its WCAG AA thresholds.
const A11Y_DEFAULTS: [string, RegExp][] = [
  ['normal-text contrast 4.5:1', /4\.5:1/],
  ['touch-target minimum 44', /\b44\b/],
]

export type TFile = { path: string; content: string }

// Meta-statements ABOUT the floor (the sentinel comment + frontmatter) must not trip the relax scan.
function scanBody(content: string): string {
  return content
    .replace(/^---\n[\s\S]*?\n---/, '')
    .replace(/<!--\s*FLOOR:[\s\S]*?-->/gi, '')
}

export function lintTemplateFiles(
  files: TFile[],
): string[] {
  const v: string[] = []
  const skill = files.find(
    f =>
      f.path === 'SKILL.md.tmpl' ||
      f.path.endsWith('/SKILL.md.tmpl'),
  )
  if (!skill) {
    v.push(
      'missing SKILL.md.tmpl (the template skill file, renamed to SKILL.md on copy)',
    )
  }
  const standards = files.find(
    f =>
      f.path === 'references/review-standards.md' ||
      f.path.endsWith('/references/review-standards.md'),
  )
  if (!standards) {
    v.push(
      'missing references/review-standards.md (it ships the WCAG AA accessibility default)',
    )
  } else {
    for (const [what, re] of A11Y_DEFAULTS) {
      if (!re.test(standards.content)) {
        v.push(
          `${standards.path}: no longer ships the WCAG AA accessibility default (${what})`,
        )
      }
    }
  }
  for (const f of files) {
    const m = f.content.match(/^---\n([\s\S]*?)\n---/)
    if (!m) {
      v.push(`${f.path}: missing YAML frontmatter`)
      continue
    }
    let fm: any
    try {
      fm = Bun.YAML.parse(m[1])
    } catch (e) {
      v.push(
        `${f.path}: invalid YAML frontmatter (${(e as Error).message})`,
      )
      continue
    }
    if (!fm?.name) {
      v.push(`${f.path}: frontmatter missing name`)
    }
    if (!fm?.description) {
      v.push(`${f.path}: frontmatter missing description`)
    }
    if (f === skill) {
      if (
        !/^\d+\.\d+\.\d+/.test(
          String(fm?.template_version ?? ''),
        )
      ) {
        v.push(
          `${f.path}: missing/invalid template_version (semver)`,
        )
      }
      if (fm?.seeded_by !== 'figma-agent-bridge') {
        v.push(
          `${f.path}: missing seeded_by: figma-agent-bridge`,
        )
      }
    }
    const lines = f.content.split('\n').length
    if (lines > MAX_LINES) {
      v.push(
        `${f.path}: ${lines} lines exceeds size cap (${MAX_LINES})`,
      )
    }
    if (RELAX.test(scanBody(f.content))) {
      v.push(
        `${f.path}: contains a directive that relaxes a safety/verification floor (forbidden — the template may only tighten)`,
      )
    }
  }
  return v
}

if (import.meta.main) {
  const dir =
    'plugin/skills/figma-setup/references/figma-bridge-prefs-template'
  const glob = new Bun.Glob('**/*')
  const files: TFile[] = []
  for await (const p of glob.scan(dir)) {
    if (p.endsWith('.md') || p.endsWith('.tmpl')) {
      files.push({
        path: p,
        content: await Bun.file(`${dir}/${p}`).text(),
      })
    }
  }
  const v = lintTemplateFiles(files)
  if (v.length) {
    throw new Error(
      'figma-bridge-prefs template failed the safety-contract lint:\n' +
        v.map(x => '  - ' + x).join('\n'),
    )
  }
  console.log(
    `ok: template lint passed (${files.length} files)`,
  )
}
