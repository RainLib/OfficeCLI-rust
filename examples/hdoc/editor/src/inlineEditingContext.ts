import type {EditorState} from '@tiptap/pm/state'
import type {ResolvedPos} from '@tiptap/pm/model'
import {inlineContainerAccessKey} from './inlineContainerPreservation.ts'
import {inlineContainerNodeName,readInlineContainerPayload} from './inlineContainerPayload.ts'

export function insideInlineContainer(position:ResolvedPos){
 for(let depth=position.depth;depth>0;depth--)if(position.node(depth).type.name===inlineContainerNodeName)return true
 return false
}
/** Suggestions use the same live codec resolver as the transaction guard.
 * Every enclosing inline body must be available, including nested wrappers. */
export function availableInlineAncestors(state:EditorState,position=state.selection.$from){
 const resolve=inlineContainerAccessKey.getState(state)?.resolve
 try{for(let depth=position.depth;depth>0;depth--){const node=position.node(depth);if(node.type.name===inlineContainerNodeName&&!resolve?.(readInlineContainerPayload(node.attrs.extension)))return false};return true}catch{return false}
}
export function editableInlineTextParent(state:EditorState,from=state.selection.$from,to=state.selection.$to){
 return from.sameParent(to)&&['paragraph','heading',inlineContainerNodeName].includes(from.parent.type.name)&&availableInlineAncestors(state,from)
}
