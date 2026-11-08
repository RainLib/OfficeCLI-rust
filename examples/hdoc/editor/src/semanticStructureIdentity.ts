import {Extension} from '@tiptap/core'
/** Opt-in schema identity for structural rooms. It never leaves through HTML
 * and is separate from canonical/source IDs assigned by save receipts. */
export const SemanticStructureIdentity=Extension.create({
 name:'hcdSemanticStructureIdentity',
 addGlobalAttributes(){return[{
  types:['paragraph','heading','listItem','codeBlock','blockquote','horizontalRule','bulletList','orderedList','hcdOpaque','hcdExtensionBlock','hcdExtensionContainer'],
  attributes:Object.fromEntries(['hcdStructureKey','hcdCanonicalKey'].map(name=>[name,{default:null,keepOnSplit:false,parseHTML:()=>null,renderHTML:()=>({})}])),
 }]},
})
