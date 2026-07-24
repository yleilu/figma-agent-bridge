// Pure window-height math shared by the resize hooks AND the
// main thread (code.ts). NO DOM / react-spring here so it unit-
// tests under `bun test`. These bounds are the single source of
// truth — code.ts imports them — so the spring can never target
// a height the main thread would refuse.

// The iframe width is fixed; Figma only resizes height.
export const WINDOW_WIDTH = 340

// Portrait aspect cap: the window never grows taller than a 9:16
// portrait of its own width (h : w = 16 : 9). Beyond this the
// roster scrolls instead of growing.
export const PORTRAIT_RATIO = 16 / 9

// One-message floor, composed from the fallback block's own box
// model (Tailwind p-3.5 = 14px padding, gap-1 = 4px, text-11
// line-height = 16px). The window never shrinks below a single
// title + description.
const BLOCK_PADDING = 14
const BLOCK_GAP = 4
const LINE_HEIGHT = 16
export const ONE_MESSAGE_HEIGHT =
  BLOCK_PADDING * 2 + LINE_HEIGHT + BLOCK_GAP + LINE_HEIGHT

export const MIN_WINDOW_HEIGHT = ONE_MESSAGE_HEIGHT
export const MAX_WINDOW_HEIGHT = Math.round(
  WINDOW_WIDTH * PORTRAIT_RATIO,
)

export const clamp = (h: number) =>
  Math.max(
    MIN_WINDOW_HEIGHT,
    Math.min(MAX_WINDOW_HEIGHT, h),
  )

// Target from a raw measured border-box height: ceil so the
// window never UNDER-sizes the content (a round-down leaves
// sub-px overflow -> 1px scrollbar flicker), then clamp.
export const measuredTarget = (raw: number) =>
  clamp(Math.ceil(raw))

// Per-frame post value: round, clamp, dedupe against the last
// sent integer. null => identical to last -> drop (a settled
// spring goes quiet, no echo).
export const nextHeight = (raw: number, last: number) => {
  const h = clamp(Math.round(raw))
  return h === last ? null : h
}
