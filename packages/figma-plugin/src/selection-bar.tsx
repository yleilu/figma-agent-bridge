import { selectionLabel } from './selection-label'

// Roster-scoped context strip: "N frames selected" with the current
// page trailing. Plain text — no dot, no icon, no emphasised count —
// so it never competes with a row's progress dot (design-system:
// section strip, 24px, 11px body, 10px trailing metadata).
// Height is owned by the animated wrapper in app.tsx; this renders
// the line's contents at full height.
export const SelectionBar = ({
  count,
  kind,
  page,
}: {
  count: number
  kind: string | null
  page: string | null
}) => (
  <div className="flex items-center gap-2 px-3 h-full text-11 border-b border-figma-border">
    <span className="shrink-0 text-figma-text-secondary">
      {selectionLabel(count, kind)}
    </span>
    <span className="ml-auto min-w-0 truncate text-figma-text-tertiary text-[10px]">
      {page ?? ''}
    </span>
  </div>
)
