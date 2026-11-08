import * as Y from 'yjs'
import {stableExtension} from './extensionRegistry.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'

/** Common causal field protocol. Adapters keep their accepted envelopes and
 * namespaces separate; creating an adapter never widens an existing room. */
export type PropertyPayload=Omit<ExtensionNodePayload,'schemaVersion'|'contentModel'>&{schemaVersion:string;contentModel?:string}
export type PropertyEditIntent<T extends PropertyPayload>={version:1|2;id:string;root:T;before:T;after:T;parents:string[];touched:string[]}
export type NodeFieldChoice={intentId:string;present:boolean;value?:unknown}
export type PropertyEditGroup<T extends PropertyPayload>={root:T;base:T;intents:PropertyEditIntent<T>[];ids:string[];data:Record<string,unknown>;conflicts:Record<string,NodeFieldChoice[]>;value:T;ready:boolean}
export type PropertyCodec<T extends PropertyPayload>={resolve:(value:T)=>unknown;update:(value:T,data:Record<string,unknown>)=>T}
export const nodeFallbackField='\u0000fallback'
export const nodeEnvelopeField='\u0000envelope'
export const nodeMaterializeOrigin=Object.freeze({kind:'hcd-node-materialize/1'})
export function createNodePropertyProtocol<T extends PropertyPayload>(nodeEditFields:{intents:string;materialized:string},readExtensionNode:(input:unknown)=>T){
 type NodeEditIntent=PropertyEditIntent<T>
 type NodeEditGroup=PropertyEditGroup<T>
 const same=(a:unknown,b:unknown)=>stableExtension(a)===stableExtension(b)
 const identity=(a:T,b:T)=>a.instanceId===b.instanceId&&a.type===b.type&&a.version===b.version&&a.display===b.display
 const occurrence=(a:T,b:T)=>a.instanceId===b.instanceId&&a.type===b.type&&a.display===b.display
 const choice=(intent:NodeEditIntent,key:string):NodeFieldChoice=>key===nodeFallbackField?{intentId:intent.id,present:true,value:intent.after.fallback}:{intentId:intent.id,present:Object.hasOwn(intent.after.data,key),...(Object.hasOwn(intent.after.data,key)?{value:intent.after.data[key]}:{})}
 const changed=(before:T,after:T)=>{if(before.version!==after.version||before.schemaVersion!==after.schemaVersion||before.contentModel!==after.contentModel||!same(before.resources,after.resources))return[nodeEnvelopeField];const keys=[...new Set([...Object.keys(before.data),...Object.keys(after.data)])].filter(key=>Object.hasOwn(before.data,key)!==Object.hasOwn(after.data,key)||!same(before.data[key],after.data[key]));return keys.length?keys:!same(before.fallback,after.fallback)?[nodeFallbackField]:[]}
 function intent(input:unknown,key:string):NodeEditIntent{
  const v=input as NodeEditIntent
  if(!v||Object.keys(v).sort().join(',')!=='after,before,id,parents,root,touched,version'||![1,2].includes(v.version)||v.id!==key||!/^e_[a-f0-9]{32}$/.test(v.id)||!Array.isArray(v.parents)||v.parents.length>128||new Set(v.parents).size!==v.parents.length||v.parents.some(p=>!/^e_[a-f0-9]{32}$/.test(p)||p===v.id)||!Array.isArray(v.touched)||!v.touched.length||v.touched.length>1025||new Set(v.touched).size!==v.touched.length||v.touched.some(p=>p!==nodeFallbackField&&!(v.version===2&&p===nodeEnvelopeField)&&(typeof p!=='string'||new TextEncoder().encode(p).length>256||/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/u.test(p)||['__proto__','prototype','constructor'].includes(p)))||JSON.stringify(v).length>200000)throw new Error('node-edit-schema')
  const root=readExtensionNode(v.root),before=readExtensionNode(v.before),after=readExtensionNode(v.after)
  const equalIdentity=v.version===1?identity:occurrence
  if(!equalIdentity(root,before)||!equalIdentity(root,after)||!v.touched.includes(nodeEnvelopeField)&&changed(before,after).some(k=>!v.touched.includes(k)))throw new Error('node-edit-identity')
  return{...v,root,before,after,parents:[...v.parents],touched:[...v.touched]}
 }
 function extensionEditIndex(document:Y.Doc):Map<string,NodeEditGroup>{
  const map=document.getMap(nodeEditFields.intents),materialized=document.getMap(nodeEditFields.materialized),groups=new Map<string,NodeEditGroup>();let bytes=0
  if(map.size>2048||materialized.size>10000)throw new Error('node-edit-limit')
  for(const [key,raw]of map){bytes+=JSON.stringify(raw).length;if(bytes>16000000)throw new Error('node-edit-limit');const edit=intent(raw,key),id=edit.root.instanceId,group=groups.get(id)
   if(group){if(!same(group.root,edit.root)||group.intents.length>=128)throw new Error('node-edit-root');group.intents.push(edit)}else groups.set(id,{root:edit.root,base:edit.root,intents:[edit],ids:[],data:{},conflicts:{},value:edit.root,ready:false})
  }
  for(const [id,group]of groups){
   group.intents.sort((a,b)=>a.id.localeCompare(b.id));group.ids=group.intents.map(e=>e.id);group.data=structuredClone(group.root.data)
   const byId=new Map(group.intents.map(e=>[e.id,e])),ancestry=new Map<string,Set<string>>(),visiting=new Set<string>()
   const ancestors=(id:string):Set<string>=>{const known=ancestry.get(id);if(known)return known;if(visiting.has(id))throw new Error('node-edit-cycle');const edit=byId.get(id);if(!edit)return new Set();visiting.add(id);const found=new Set(edit.parents);for(const parent of edit.parents)for(const ancestor of ancestors(parent))found.add(ancestor);visiting.delete(id);ancestry.set(id,found);return found};group.ids.forEach(ancestors)
   if(group.intents.some(edit=>edit.touched.includes(nodeEnvelopeField)||edit.after.version!==group.root.version)){
    mergeMigratedGroup(group,ancestry)
    const receipt=materialized.get(id) as {ids?:unknown;value?:unknown}|undefined
    if(receipt&&Object.keys(receipt).sort().join(',')==='ids,value'&&same(receipt.ids,group.ids)){
     const value=readExtensionNode(receipt.value);if(!identity(group.value,value)||!same(value.data,group.data)||value.schemaVersion!==group.base.schemaVersion||value.contentModel!==group.base.contentModel||!same(value.resources,group.base.resources))throw new Error('node-edit-materialization');group.value=value;group.ready=true
    }
    continue
   }
   let fallback=group.root.fallback
   for(const key of new Set(group.intents.flatMap(e=>e.touched))){
    const edits=group.intents.filter(e=>e.touched.includes(key)),heads=edits.filter(e=>!edits.some(other=>other.id!==e.id&&ancestry.get(other.id)!.has(e.id))),options=heads.map(e=>choice(e,key)),unique=options.filter((v,index)=>!options.slice(0,index).some(p=>p.present===v.present&&same(p.value,v.value)))
    if(unique.length>1)group.conflicts[key]=options
    const selected=options.at(-1);if(!selected)throw new Error('node-edit-cycle')
    if(key===nodeFallbackField)fallback=selected.value as T['fallback'];else if(selected.present)group.data[key]=structuredClone(selected.value);else delete group.data[key]
   }
   const candidate=group.intents.at(-1)!.after
   group.value=readExtensionNode({...group.root,data:group.data,fallback:group.intents.some(e=>e.touched.includes(nodeFallbackField))?fallback:candidate.fallback,...(candidate.exports?{exports:candidate.exports}:{})})
   const receipt=materialized.get(id) as {ids?:unknown;value?:unknown}|undefined
   if(receipt&&Object.keys(receipt).sort().join(',')==='ids,value'&&same(receipt.ids,group.ids)){
    const value=readExtensionNode(receipt.value);if(!identity(group.root,value)||!same(value.data,group.data)||value.schemaVersion!==group.base.schemaVersion||value.contentModel!==group.base.contentModel||!same(value.resources,group.base.resources))throw new Error('node-edit-materialization');group.value=value;group.ready=true
   }else if(group.intents.length===1&&same(group.value,group.intents[0].after)){group.ready=true}
  }
  return new Map([...groups].sort(([a],[b])=>a.localeCompare(b)))
 }
 /** No business code runs on the coordinator. A host codec supplies a readable
  * materialization bound to the exact set of retained property intents. */
 function materializeExtensionEdits(document:Y.Doc,registry:PropertyCodec<T>){
  const index=extensionEditIndex(document),actions:Array<[string,{ids:string[];value:T}]>=[]
  for(const [id,group]of index){if(group.conflicts[nodeEnvelopeField]||!registry.resolve(group.base))continue;try{const value=registry.update(group.base,group.data);if(!group.ready||!same(group.value,value))actions.push([id,{ids:group.ids,value}])}catch{/* Invalid merged business data remains pending, never coerced. */}}
  if(actions.length)document.transact(()=>actions.forEach(([id,value])=>document.getMap(nodeEditFields.materialized).set(id,value)),nodeMaterializeOrigin)
 }
 function editBudget(document:Y.Doc,records:NodeEditIntent[]){
  if(!records.length)return
  const map=document.getMap(nodeEditFields.intents)
  if(records.some(record=>record.parents.length>=128)||map.size+records.length>2048||[...map.values(),...records].reduce<number>((sum,v)=>sum+JSON.stringify(v).length,0)>16000000||new Set([...document.getMap(nodeEditFields.materialized).keys(),...records.map(record=>record.root.instanceId)]).size>10000)throw new Error('node-edit-limit')
 }
 function prepareExtensionEdits(document:Y.Doc,before:Iterable<T>,after:Iterable<T>){
  const old=new Map([...before].map(value=>[value.instanceId,{value}]));if(!old.size)return[]
  const next=new Map([...after].map(value=>[value.instanceId,{value}])),index=extensionEditIndex(document),records:NodeEditIntent[]=[]
  for(const [id,entry]of old){const value=next.get(id)?.value;if(!value||same(entry.value,value))continue;if(!occurrence(entry.value,value))throw new Error('node-edit-identity');const group=index.get(id);if(group&&Object.keys(group.conflicts).length)throw new Error('node-drafts-conflict');const record:NodeEditIntent={version:2,id:`e_${crypto.randomUUID().replaceAll('-','')}`,root:group?.root??entry.value,before:entry.value,after:value,parents:group?.ids??[],touched:changed(entry.value,value)};intent(record,record.id);records.push(record)}
  editBudget(document,records)
  return records
 }
 function publishExtensionEdits(document:Y.Doc,records:NodeEditIntent[]){for(const record of records){document.getMap(nodeEditFields.intents).set(record.id,record);document.getMap(nodeEditFields.materialized).set(record.root.instanceId,{ids:[...record.parents,record.id].sort(),value:record.after})}}
 function resolveExtensionEdits(document:Y.Doc,registry:PropertyCodec<T>,instanceId:string,ids:unknown,choices:Record<string,string>,origin:unknown){
  const group=extensionEditIndex(document).get(instanceId);if(!group||!same(ids,group.ids)||!Object.keys(group.conflicts).length&&group.ready)throw new Error('extensionChanged')
  if(group.conflicts[nodeEnvelopeField]){
   if(!same(Object.keys(choices),[nodeEnvelopeField]))throw new Error('extensionChanged')
   const picked=group.conflicts[nodeEnvelopeField].find(option=>option.intentId===choices[nodeEnvelopeField]);if(!picked)throw new Error('extensionChanged')
   const after=readExtensionNode(picked.value),record:NodeEditIntent={version:2,id:`e_${crypto.randomUUID().replaceAll('-','')}`,root:group.root,before:group.value,after,parents:group.ids,touched:[nodeEnvelopeField]}
   intent(record,record.id);editBudget(document,[record]);document.transact(()=>publishExtensionEdits(document,[record]),origin);return after
  }
  const candidate=!Object.keys(group.conflicts).length&&!group.ready?group.intents.find(intent=>intent.id===choices['#candidate']):undefined
  if(candidate?!same(Object.keys(choices),['#candidate']):!same(Object.keys(choices).sort(),Object.keys(group.conflicts).sort()))throw new Error('extensionChanged')
  const data=structuredClone(candidate?candidate.after.data:group.data);let fallback=group.value.fallback
  for(const [key,options]of Object.entries(group.conflicts)){const picked=options.find(option=>option.intentId===choices[key]);if(!picked)throw new Error('extensionChanged');if(key===nodeFallbackField)fallback=picked.value as T['fallback'];else if(picked.present)data[key]=structuredClone(picked.value);else delete data[key]}
  if(group.ids.length>=128||document.getMap(nodeEditFields.intents).size>=2048)throw new Error('node-edit-limit')
  const after=registry.update(group.base,data);if(nodeFallbackField in group.conflicts&&!same(after.fallback,fallback))throw new Error('nodeExtensionInvalidData')
  const record:NodeEditIntent={version:2,id:`e_${crypto.randomUUID().replaceAll('-','')}`,root:group.root,before:group.value,after,parents:group.ids,touched:[...new Set([...changed(group.value,after),...Object.keys(group.conflicts),...(candidate?group.intents.flatMap(intent=>intent.touched):[])])]};intent(record,record.id);editBudget(document,[record]);document.transact(()=>publishExtensionEdits(document,[record]),origin);return after
 }

 /** A schema transition is an atomic barrier. Only descendants of a common
  * schema base may merge by field; crossing branches retain full candidates. */
 function mergeMigratedGroup(group:NodeEditGroup,ancestry:Map<string,Set<string>>){
  const heads=group.intents.filter(edit=>!group.intents.some(other=>other.id!==edit.id&&ancestry.get(other.id)!.has(edit.id)))
  if(!heads.length)throw new Error('node-edit-cycle')
  const candidate=heads.at(-1)!.after
  if(heads.length===1||heads.every(edit=>same(edit.after,candidate))){group.base=candidate;group.value=candidate;group.data=structuredClone(candidate.data);group.ready=true;return}
  const common=group.intents.filter(edit=>edit.after.version===candidate.version&&heads.every(head=>head.id===edit.id||ancestry.get(head.id)!.has(edit.id))).sort((a,b)=>ancestry.get(a.id)!.size-ancestry.get(b.id)!.size||a.id.localeCompare(b.id)).at(-1)
  const base=common?.after??(group.root.version===candidate.version?group.root:undefined),edits=group.intents.filter(edit=>edit.id!==common?.id&&(!common||ancestry.get(edit.id)!.has(common.id)))
  if(!base||heads.some(edit=>edit.after.version!==candidate.version)||edits.some(edit=>edit.touched.includes(nodeEnvelopeField)||edit.after.version!==base.version)){
   group.base=candidate;group.value=candidate;group.data=structuredClone(candidate.data);group.ready=true
   group.conflicts[nodeEnvelopeField]=heads.map(edit=>({intentId:edit.id,present:true,value:edit.after}));return
  }
  group.base=base;group.data=structuredClone(base.data)
  let fallback=base.fallback
  for(const key of new Set(edits.flatMap(edit=>edit.touched))){
   const changed=edits.filter(edit=>edit.touched.includes(key)),heads=changed.filter(edit=>!changed.some(other=>other.id!==edit.id&&ancestry.get(other.id)!.has(edit.id))),options=heads.map(edit=>choice(edit,key)),unique=options.filter((v,index)=>!options.slice(0,index).some(p=>p.present===v.present&&same(p.value,v.value)))
   if(unique.length>1)group.conflicts[key]=options
   const picked=options.at(-1);if(!picked)throw new Error('node-edit-cycle')
   if(key===nodeFallbackField)fallback=picked.value as T['fallback'];else if(picked.present)group.data[key]=structuredClone(picked.value);else delete group.data[key]
  }
  group.value=readExtensionNode({...base,data:group.data,fallback:edits.some(edit=>edit.touched.includes(nodeFallbackField))?fallback:candidate.fallback,...(candidate.exports?{exports:candidate.exports}:{})})
 }

 return{index:extensionEditIndex,materialize:materializeExtensionEdits,prepare:prepareExtensionEdits,publish:publishExtensionEdits,resolve:resolveExtensionEdits}
}
