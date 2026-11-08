/** Locate only canonical block IDs supplied by the authenticated save result. */
export function locateWordField(root: ParentNode | null, id: string | null): boolean {
  if (!root || !id || !/^n_[a-f0-9]{32}$/.test(id)) return false
  const block = root.querySelector(`[data-hcd-block-id="${id}"]`)
  if (!block || typeof block.scrollIntoView !== 'function') return false
  block.scrollIntoView({ block: 'center', behavior: 'smooth' })
  block.animate?.([{ outline: '2px solid #e0a12d', outlineOffset: '4px' }, { outline: '2px solid transparent', outlineOffset: '4px' }], { duration: 2200 })
  return true
}
