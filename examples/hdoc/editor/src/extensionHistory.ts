import type {Node as PmNode} from '@tiptap/pm/model'
import {extensionNodes,sameNodeExceptSourceMarks} from './extensionNode.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import {customMarkHistoryGuard} from './customMarks.ts'

/** Capture only occurrences the current host cannot interpret. Unrelated text
 * edits remain undoable; restoration may add an inert, read-only occurrence.
 * Never cache a codec decision in an old history item. */
export function prepareExtensionHistoryGuard(before:PmNode,registry?:NodeExtensionRegistry){
 const protectedNodes=new Map<string,PmNode>()
 const checkMarks=customMarkHistoryGuard(before,registry?.marks)
 for(const [id,entry]of extensionNodes(before))if(!registry?.resolve(entry.value))protectedNodes.set(id,before.nodeAt(entry.position)!)
 if(!protectedNodes.size&&!checkMarks)return undefined
 return(after:PmNode)=>{
  checkMarks?.(after)
  const next=extensionNodes(after)
  for(const [id,node]of protectedNodes){const entry=next.get(id);if(!entry||!sameNodeExceptSourceMarks(node,after.nodeAt(entry.position)!))throw new Error('historyExtensionUnavailable')}
 }
}
