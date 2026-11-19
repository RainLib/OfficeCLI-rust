import source from './assets/agent-pointer.svg?raw'
import './agent-pointer.css'

export type AgentPhase = 'idle' | 'writing' | 'done'

// An inline SVG inherits its participant's color. The artwork has no IDs, so
// every pointer can share it, including ProseMirror's non-React widgets.
// Whitespace inside the editor must not become part of a copied sentence.
const artwork = source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>')).trim().replace(/>\s+</g, '><')
const viewBox = '0 0 24 24'

type Props = { phase: AgentPhase; className?: string; color?: string; label?: string }

export function AgentPointer({ phase, className, color, label }: Props) {
  return <svg className={className ? 'agent-nib ' + className : 'agent-nib'} data-phase={phase}
    viewBox={viewBox} fill="none" style={color ? { color } : undefined} focusable="false"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    dangerouslySetInnerHTML={{ __html: artwork }} />
}

export function pointerElement(doc: Document, phase: AgentPhase) {
  const node = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  node.setAttribute('class', 'agent-nib')
  node.setAttribute('viewBox', viewBox)
  node.setAttribute('fill', 'none')
  node.setAttribute('focusable', 'false')
  node.setAttribute('aria-hidden', 'true')
  node.dataset.phase = phase
  node.innerHTML = artwork
  return node
}
