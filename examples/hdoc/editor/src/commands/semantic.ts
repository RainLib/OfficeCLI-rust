import {readInlineContainerPayload} from '../inlineContainerPayload.ts'
import {readExtensionNode} from '../extensionNode.ts'
import {blockActionStates} from './blocks.ts'
import type {Editor} from '@tiptap/core'
import type {CommandContext} from './types.ts'
import type {InlineContainerRegistry} from '../inlineContainerRegistry.ts'
import {insideInlineContainer} from '../inlineEditingContext.ts'
export function topLevelBlocks(editor:Editor){const nodes:Array<{pos:number;node:typeof editor.state.doc}>=[];editor.state.doc.forEach((node,pos)=>nodes.push({node,pos}));const index=nodes.findIndex(({pos,node})=>editor.state.selection.from>=pos&&editor.state.selection.from<pos+node.nodeSize);return{nodes,index}}
const unavailableInline=(node:Editor['state']['doc'],registry?:InlineContainerRegistry)=>node.type.name==='hcdExtensionInlineContainer'&&!registry?.resolve(readInlineContainerPayload(node.attrs.extension))
const protectedNode=(node:Editor['state']['doc'],registry?:InlineContainerRegistry)=>{let protectedContent=['hcdOpaque','hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name)||unavailableInline(node,registry);node.descendants(child=>{if(child.type.name==='hcdOpaque'||unavailableInline(child,registry))protectedContent=true;return !protectedContent});return protectedContent}
export function semanticSelection(editor:Editor|null,generation:number,inlineRegistry?:InlineContainerRegistry):CommandContext['selection']{
 if(!editor||editor.isDestroyed)return{kind:'none',empty:true,anchor:null,protected:false,parentTypes:[]}
 const {state}=editor,selection=state.selection,parents:string[]=[];for(let depth=selection.$from.depth;depth>=0;depth--)parents.push(selection.$from.node(depth).type.name)
 let isProtected='node'in selection&&protectedNode(selection.node as typeof state.doc,inlineRegistry)
 // A collapsed caret inside a retained unknown wrapper must be protected too.
 // nodesBetween alone does not visit its ancestors for an empty selection.
 for(let depth=selection.$from.depth;depth>0;depth--)if(unavailableInline(selection.$from.node(depth),inlineRegistry))isProtected=true
 state.doc.nodesBetween(selection.from,selection.to,node=>{if(['hcdOpaque','hcdExtensionInline','hcdExtensionBlock'].includes(node.type.name)||unavailableInline(node,inlineRegistry))isProtected=true;return !isProtected})
 let anchor:string
 try{anchor=JSON.stringify([editor.utils.createMappablePosition(selection.from).toJSON(),editor.utils.createMappablePosition(selection.to).toJSON(),generation])}catch{anchor=JSON.stringify([selection.from,selection.to,generation])}
 const extension='node'in selection&&(selection.node as typeof state.doc).type.name==='hcdExtensionInlineContainer'?readInlineContainerPayload((selection.node as typeof state.doc).attrs.extension):'node'in selection&&['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes((selection.node as typeof state.doc).type.name)?readExtensionNode((selection.node as typeof state.doc).attrs.extension):undefined
 return{kind:'text',empty:selection.empty,anchor,protected:!!isProtected,...(extension?{nodeId:extension.instanceId,extension}:{}),from:selection.from,to:selection.to,text:state.doc.textBetween(selection.from,selection.to,'\n').slice(0,4096),parentTypes:parents}
}
export function semanticActionStates(editor:Editor|null):CommandContext['actions']{
 if(!editor||editor.isDestroyed)return{}
 const can=editor.can(),{nodes,index}=topLevelBlocks(editor),safe=(test:()=>boolean)=>{try{return test()}catch{return false}}
 const states:Record<string,{enabled:boolean;active?:boolean;reason?:string}>={
  'edit.copy':{enabled:!editor.state.selection.empty},'edit.paste':{enabled:editor.state.selection.$from.parent.inlineContent},'text.insert':{enabled:editor.state.selection.$from.parent.inlineContent},
  'block.paragraph':{enabled:editor.state.selection.$from.parent.type.name==='paragraph'||safe(()=>can.setParagraph()),active:editor.isActive('paragraph')},'block.heading':{enabled:safe(()=>can.toggleHeading({level:2})),active:editor.isActive('heading')},
  'block.bulletList':{enabled:safe(()=>can.toggleBulletList()),active:editor.isActive('bulletList')},'block.orderedList':{enabled:safe(()=>can.toggleOrderedList()),active:editor.isActive('orderedList')},
  'block.quote':{enabled:safe(()=>can.toggleBlockquote()),active:editor.isActive('blockquote')},'block.code':{enabled:safe(()=>can.toggleCodeBlock()),active:editor.isActive('codeBlock')},'block.divider':{enabled:safe(()=>can.setHorizontalRule())},
  'block.insertParagraph':{enabled:safe(()=>can.insertContent({type:'paragraph'}))},'block.delete':{enabled:index>=0&&!protectedNode(nodes[index].node)},
  'block.up':{enabled:index>0&&!protectedNode(nodes[index].node)&&!protectedNode(nodes[index-1].node)},'block.down':{enabled:index>=0&&index+1<nodes.length&&!protectedNode(nodes[index].node)&&!protectedNode(nodes[index+1].node)},
  'text.link.open':{enabled:safe(()=>can.setLink({href:'https://example.invalid'})),active:editor.isActive('link')},'text.link.set':{enabled:safe(()=>can.setLink({href:'https://example.invalid'}))},'text.link.clear':{enabled:editor.isActive('link')},
  'text.color':{enabled:safe(()=>can.setMark('textColor',{color:'#1f2328'}))},'text.color.clear':{enabled:safe(()=>can.unsetMark('textColor'))},
  'text.highlight':{enabled:safe(()=>can.setMark('textBackground',{color:'#fff2a8'}))},'text.highlight.clear':{enabled:safe(()=>can.unsetMark('textBackground'))},
  'text.border':{enabled:safe(()=>can.setMark('textBorder',{color:'#1f2328',widthPt:1,style:'solid'}))},'text.border.clear':{enabled:safe(()=>can.unsetMark('textBorder'))},
  'text.fontSize.set':{enabled:safe(()=>can.setMark('textTypography',{sizePt:12,explicitSize:true}))},
 }
 for(const mark of ['bold','italic','underline','strike'])states[`text.${mark}`]={enabled:safe(()=>can.toggleMark(mark)),active:editor.isActive(mark)}
 for(const[id,action]of Object.entries(blockActionStates(editor.state)))states[id]={...states[id],...action}
 if(insideInlineContainer(editor.state.selection.$from))for(const id of ['block.paragraph','block.heading','block.bulletList','block.orderedList','block.quote','block.code','block.divider','block.insertParagraph'])states[id]={enabled:false}
 let hasReference=false;editor.state.doc.nodesBetween(editor.state.selection.from,editor.state.selection.to,node=>{if(node.type.name==='hcdMention')hasReference=true})
 if(hasReference)for(const id of ['text.link.open','text.link.set'])states[id]={enabled:false,reason:'mentionIncompatibleFormat'}
 return states
}
