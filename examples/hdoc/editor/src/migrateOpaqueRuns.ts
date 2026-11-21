import * as Y from 'yjs'
import type { BlockContent } from './schema.ts'

/** Server-only room migration. Preserve existing shared paragraph drafts and
 * seed mapped table runs once, before accepting browser connections. */
export function migrateOpaqueRuns(document: Y.Doc) {
  document.transact(() => {
    for (const block of document.getXmlFragment('default').toArray()) {
      if (!(block instanceof Y.XmlElement) || block.nodeName !== 'hcdOpaque' || block.length) continue
      const content = block.getAttribute('hcdContent') as unknown as BlockContent | undefined
      if (!content) continue
      const runs = content.inlines.filter(inline => inline.nodeId).map(inline => {
        const run = new Y.XmlElement('hcdOpaqueRun')
        run.setAttribute('nodeId', inline.nodeId!)
        const text = new Y.XmlText()
        text.insert(0, inline.text)
        run.insert(0, [text])
        return run
      })
      block.insert(0, runs)
    }
  }, 'hcd-canonical-ids')
}
