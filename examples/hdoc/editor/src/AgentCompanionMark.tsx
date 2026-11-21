import { createContext, useContext } from 'react'
import glyphs from './assets/ai-companion.svg?raw'
import './companion-motion.css'

export type CompanionState = 'idle' | 'listening' | 'active' | 'complete' | 'still'
export const CompanionStateContext = createContext<CompanionState>('idle')

// Local SVG artwork only. Keep the two mounted paths as their motion changes.
const artwork = { __html: glyphs }

export function AgentCompanionMark({ size, state, label }: {
  size: number
  state?: CompanionState
  label?: string
}) {
  const inherited = useContext(CompanionStateContext)
  return <span className="agent-companion-mark oc-companion" data-companion-state={state ?? inherited}
    style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label}
    aria-hidden={label ? undefined : true} dangerouslySetInnerHTML={artwork} />
}
