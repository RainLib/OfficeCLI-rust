import type {BlockContent} from './schema.ts'
import {Node} from '@tiptap/core'
export type InlineReference={type:'hcd.mention';version:1;mentionId:string;target:{kind:string;id:string};snapshot:{label:string}}
const keys=(value:unknown,names:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',')
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&new TextEncoder().encode(value).length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value)&&![...value].some(char=>{const code=char.codePointAt(0)!;return code>=0xd800&&code<=0xdfff})
export function readInlineReference(value:unknown):InlineReference{
 const v=value as InlineReference
 if(!keys(v,['type','version','mentionId','target','snapshot'])||v.type!=='hcd.mention'||v.version!==1||!/^m_[a-f0-9]{32}$/.test(v.mentionId)||!keys(v.target,['kind','id'])||!text(v.target.id,256)||typeof v.target.kind!=='string'||!/^[a-z][a-z0-9._-]{0,63}$/.test(v.target.kind)||!keys(v.snapshot,['label'])||!text(v.snapshot.label,256))throw new Error('unsupportedInlineReference')
 return structuredClone(v)
}
export function referenceText(value:unknown){return`@${readInlineReference(value).snapshot.label}`}
export function copyInlineReference(value:unknown):InlineReference{return{...readInlineReference(value),mentionId:`m_${crypto.randomUUID().replaceAll('-','')}`}}
export const HcdMention=Node.create({
 name:'hcdMention',inline:true,group:'inline',atom:true,selectable:true,
 extendNodeSchema(extension){return extension.name==='hcdMention'?{leafText:(node:{attrs:{reference:unknown}})=>referenceText(node.attrs.reference)}:{}},
 addAttributes(){return{reference:{default:null,validate:readInlineReference,renderHTML:()=>({})}}},
 parseHTML(){return[{tag:'span[data-hcd-mention]',getAttrs:element=>{try{return{reference:copyInlineReference(JSON.parse(element.getAttribute('data-hcd-mention')||''))}}catch{return false}}}]},
 renderHTML({node}){const reference=readInlineReference(node.attrs.reference);return['span',{'data-hcd-mention':JSON.stringify(reference),class:'hcd-mention',contenteditable:'false',role:'button',tabindex:'0','aria-haspopup':'dialog','aria-label':referenceText(reference)},referenceText(reference)]},
 renderText({node}){return referenceText(node.attrs.reference)},
})

export function hasInlineReferences(blocks:readonly {content:BlockContent}[]):boolean{const has=(content:Pick<BlockContent,'inlines'|'children'>):boolean=>content.inlines.some(inline=>!!inline.reference||!!inline.content&&has(inline.content))||(content.children??[]).some(has);return blocks.some(block=>has(block.content))}
