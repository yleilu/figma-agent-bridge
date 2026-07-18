import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { DesignSystemPreview } from './DesignSystemPreview'

// Dev flag: flip to true to render the design-system kitchen sink instead of the app.
// Keep false on commit; used to live-verify the design system in Figma.
const SHOW_DS_PREVIEW = false

const rootEl = document.getElementById('root')

if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>{SHOW_DS_PREVIEW ? <DesignSystemPreview /> : <App />}</StrictMode>,
  )
}
