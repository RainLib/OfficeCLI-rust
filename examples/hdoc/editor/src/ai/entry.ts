import type {EditorState} from '@tiptap/pm/state'
import {canAiSelection} from './semantic.ts'
/** Plain space opens AI only on a truly empty editable line. Composition,
 * shortcuts and ordinary spaces remain native editor input. */
export function aiSpaceEntry(state:EditorState,event:{key:string;isComposing?:boolean;keyCode?:number;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;shiftKey?:boolean},enabled:boolean){return enabled&&event.key===' '&&!event.isComposing&&event.keyCode!==229&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&state.selection.empty&&state.selection.$from.parent.content.size===0&&canAiSelection(state,'insert')}
