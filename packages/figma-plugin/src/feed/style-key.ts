// A style's IDENTITY is its KEY (change-feed.md), and its id is NOT one stable
// string. `create_styles` returns `S:<key>,` — trailing segment empty — while
// the documentchange event for the same style carries a further segment that
// varies per event: `S:<key>,1:8`. The KEY is the stable part. Matching whole
// strings therefore never succeeds: attribution missed every agent-created
// style, and collapse filed every event for one style under its own bucket.
//
// Node ids are NOT normalised: they are exact, and a prefix match would
// wrongly equate `1:8` with `1:80`. This helper is for STYLE ids only — its
// callers gate on the `style_` op family before reaching for it.
export const styleKey = (id: string): string => {
  const comma = id.indexOf(',')
  return comma === -1 ? id : id.slice(0, comma)
}
