// Dev-only kitchen sink for docs/specs/design-system.md.
// Rendered when SHOW_DS_PREVIEW is true in main.tsx. Exercises every design-system
// token so the Tailwind build emits its utilities and the system is visually verifiable.
const SWATCHES: Array<{ label: string; cls: string }> = [
  { label: 'bg', cls: 'bg-figma-bg' },
  { label: 'bg-secondary', cls: 'bg-figma-bg-secondary' },
  { label: 'bg-tertiary', cls: 'bg-figma-bg-tertiary' },
  { label: 'bg-hover', cls: 'bg-figma-bg-hover' },
  { label: 'bg-selected', cls: 'bg-figma-bg-selected' },
  { label: 'bg-pressed', cls: 'bg-figma-bg-pressed' },
  { label: 'bg-disabled', cls: 'bg-figma-bg-disabled' },
  { label: 'bg-brand', cls: 'bg-figma-bg-brand' },
  { label: 'bg-success', cls: 'bg-figma-bg-success' },
  { label: 'bg-warning', cls: 'bg-figma-bg-warning' },
  { label: 'bg-danger', cls: 'bg-figma-bg-danger' },
]

const Dot = ({ cls }: { cls: string }) => (
  <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
)

export const DesignSystemPreview = () => (
  <div className="p-3 bg-figma-bg text-figma-text">
    <h2 className="text-11 font-semibold text-figma-text-secondary mb-2">Design system preview</h2>

    <section className="mb-3">
      <div className="text-11 font-semibold text-figma-text-secondary mb-1">Type</div>
      <div className="text-11 text-figma-text">Body 11px / 16px, weight 400 (Inter)</div>
      <div className="text-11 font-semibold text-figma-text">Label 11px, weight 600</div>
      <div className="text-11 text-figma-text-secondary">Secondary text</div>
      <div className="text-11 text-figma-text-tertiary">Tertiary text</div>
    </section>

    <section className="mb-3">
      <div className="text-11 font-semibold text-figma-text-secondary mb-1">Status dots</div>
      <div className="flex items-center gap-3 text-11">
        <span className="flex items-center gap-1"><Dot cls="bg-figma-icon-warning" /> busy</span>
        <span className="flex items-center gap-1"><Dot cls="bg-figma-icon-success" /> ok</span>
        <span className="flex items-center gap-1"><Dot cls="bg-figma-icon-danger" /> error</span>
        <span className="flex items-center gap-1"><Dot cls="bg-figma-icon-tertiary" /> idle/skeleton</span>
      </div>
    </section>

    <section className="mb-3">
      <div className="text-11 font-semibold text-figma-text-secondary mb-1">
        Row emphasis (full-width, no radius — merges when adjacent)
      </div>
      <div className="-mx-3">
        <div className="flex items-center gap-2 px-3 py-1 bg-figma-bg-secondary text-11">
          <Dot cls="bg-figma-icon-warning" /><span className="font-semibold">Explore</span>
          <span className="text-figma-text-secondary">Scanning nodes</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 bg-figma-bg-secondary text-11">
          <Dot cls="bg-figma-icon-warning" /><span className="font-semibold">figma-designer</span>
          <span className="text-figma-text-secondary">Placing hero frame</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 text-11">
          <Dot cls="bg-figma-icon-success" /><span className="font-semibold">Claude</span>
          <span className="text-figma-text-secondary">Reviewed contrast</span>
        </div>
      </div>
    </section>

    <section className="mb-3">
      <div className="text-11 font-semibold text-figma-text-secondary mb-1">Radius</div>
      <div className="flex items-center gap-3 text-11">
        <span className="px-2 py-1 rounded bg-figma-bg-secondary border border-figma-border">input 4px</span>
        <span className="px-2 py-1 rounded-md bg-figma-bg-secondary border border-figma-border">button 6px</span>
        <span className="px-2 py-1 rounded-lg bg-figma-bg-secondary border border-figma-border">window 8px</span>
      </div>
    </section>

    <section>
      <div className="text-11 font-semibold text-figma-text-secondary mb-1">Color tokens</div>
      <div className="grid grid-cols-3 gap-1">
        {SWATCHES.map((s) => (
          <div key={s.label} className="text-11 text-figma-text-tertiary">
            <div className={`h-6 rounded border border-figma-border ${s.cls}`} />
            {s.label}
          </div>
        ))}
      </div>
    </section>
  </div>
)
