import type { SpringConfig } from '@react-spring/web'

// The one home for the motion the team reviewed & approved
// (Motion Review artifact, 2026-07-24). No spring tuning lives
// inline in a hook/component. mass omitted = react-spring
// default (1).

// Outer Figma window edge — springs height toward measured
// content.
export const WINDOW_SPRING: SpringConfig = {
  tension: 320,
  friction: 30,
}

// Roster item enter/exit (collapse: height + opacity).
export const ITEM_SPRING: SpringConfig = {
  tension: 260,
  friction: 26,
}

// Status-text crossfade.
export const TEXT_SPRING: SpringConfig = {
  tension: 300,
  friction: 30,
}

// Typing-dots trail.
export const DOTS_SPRING: SpringConfig = {
  tension: 250,
  friction: 12,
}
