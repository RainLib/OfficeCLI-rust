import {inlineContainerEditIndex,materializeInlineContainerEdits,resolveInlineContainerEdits,type InlineContainerPropertyCodec} from '../src/inlineContainerEdits.ts'
import {readInlineContainerPayload} from '../src/inlineContainerPayload.ts'
/** Explicit internal coordinator only: no active sidecar/SDK negotiation. */
import assert from 'node:assert/strict'
import {readFile,writeFile,access} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions,projectionToJson,jsonToSnapshot,type Projection} from '../src/schema.ts'
import {SemanticInlineContainerNode} from '../src/semanticInlineNode.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../src/semanticBlockStore.ts'
import {SemanticSaveCoordinator} from '../src/semanticSaveCoordinator.ts'
import {structureTextEdits} from '../src/semanticStructureBinding.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),phase=process.argv[3],models={inlineContainers:true} as const,schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),mentionId='m_'+'f'.repeat(32)
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex'),pause=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const headers={'Authorization':`Bearer ${config.service}`,'X-HCD-Collaboration-Epoch':'0','X-HCD-Node-Edits-Version':'7','X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Custom-Marks-Version':'1'}
let drop=phase==='prepare'
async function request(route:string,init:RequestInit={}){
 const body=route==='/checkpoints'?JSON.parse(String(init.body)):undefined
 if(body)await writeFile(join(config.root,`request-r${body.expectedRevision+1}.json`),JSON.stringify(body,null,2)+'\n')
 const target=route==='/checkpoints'&&drop?(drop=false,config.dropUrl):config.apiUrl+route
 return fetch(target,{...init,headers:{...headers,...init.headers},signal:init.signal??AbortSignal.timeout(60_000)})
}
async function json(route:string,token?:string){const response=await request(route,token?{headers:{Authorization:`Bearer ${token}`}}:{});assert.ok(response.ok,`${route}: ${response.status}`);return response.json()}
async function untilFile(name:string){const end=Date.now()+40_000;while(Date.now()<end){try{await access(join(config.root,name));return}catch{await pause(25)}}throw Error('commit signal missing')}
const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,models),states:unknown[]=[]
let stateHash='none'
const projection:Projection=await json('/editor')
if(phase==='prepare'){
 store.initialize(schema.nodeFromJSON(projectionToJson(projection,models)));document.getMap('hcdSchema').set('typography',2);document.getMap('hcdSchema').set('sourceIdentity',1)
}else{
 const response=await request('/collaboration/state');assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());stateHash=hash(bytes);Y.applyUpdate(document,bytes)
}
const owner=new SemanticSaveCoordinator({documentId:'inline-native',epoch:0,document,structure:store,inlineContainers:1,secret:config.secret,stateHash,request,broadcast:state=>states.push(state),autoSave:false})
const save=(name:string,value:unknown)=>writeFile(join(config.root,name),JSON.stringify(value,null,2)+'\n')
function start(doc:import('@tiptap/pm/model').Node,id:string){let value:number|undefined;doc.descendants((node,pos)=>{if(node.type.name==='hcdExtensionInlineContainer'&&node.attrs.extension.instanceId===id)value=pos+1});assert.ok(value!==undefined);return value}
function prefix(id:string,value:string){const state=EditorState.create({schema,doc:store.project()}),tr=state.tr.insertText(value,start(state.doc,id));store.reconcile(store.blocks(),[...tr.doc.content.content].map(node=>({key:node.attrs.hcdStructureKey,node})),{textEdits:structureTextEdits([tr],true)})}
const propertyCodec:InlineContainerPropertyCodec={resolve:()=>true,update:(base,data)=>{
 const label=`[属性：${data.reviewTitle??'Initial'} · ${data.reviewDone?'已确认':'未确认'}]`,exports=structuredClone(base.exports)
 if(exports)for(const portable of Object.values(exports))for(const block of portable.blocks??[])if('runs' in block)for(const run of block.runs)if('text' in run&&(/\[项目\]|\[属性：/u.test(run.text)))run.text=label+' '
 return readInlineContainerPayload({...base,data,fallback:{text:label},...(exports?{exports}:{})})
}}
function property(target:SemanticBlockStore,id:string,patch:Record<string,unknown>){const state=EditorState.create({schema,doc:target.project()}),pos=start(state.doc,id)-1,node=state.doc.nodeAt(pos)!,base=readInlineContainerPayload(node.attrs.extension),tr=state.tr.setNodeMarkup(pos,undefined,{...node.attrs,extension:propertyCodec.update(base,{...base.data,...patch})});target.reconcile(target.blocks(),[...tr.doc.content.content].map(node=>({key:node.attrs.hcdStructureKey,node})))}
function propertyValue(id:string){return store.flow.containers!.readBody(id).attrs.extension}
async function actor(id:'alice'|'bob'){const auth=await json('/auth',config[id]);assert.equal(auth.userId,id);assert.equal(auth.scope,'write');return{userId:id,displayName:auth.displayName}}
try{
 await owner.initialize(projection);assert.equal(owner.state().conflict,undefined)
 if(phase==='prepare'){
  assert.equal(projection.revision,8);let chosen:string|undefined;store.project().descendants(node=>{if(!chosen&&node.type.name==='hcdExtensionInlineContainer')chosen=node.attrs.extension.instanceId});assert.ok(chosen)
  const alice=await actor('alice'),bob=await actor('bob')
  if(config.propertyEdits){
   const peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));const other=new SemanticBlockStore(peer,schema,undefined,models),history=store.undoManager()
   try{
    property(store,chosen,{reviewTitle:'Alice'});history.stopCapturing();property(other,chosen,{reviewTitle:'Bob',reviewDone:true})
    const state=EditorState.create({schema,doc:other.project()}),tr=state.tr.insertText('属性协同正文😀 ',start(state.doc,chosen));other.reconcile(other.blocks(),[...tr.doc.content.content].map(node=>({key:node.attrs.hcdStructureKey,node})),{textEdits:structureTextEdits([tr],true)})
    Y.applyUpdate(document,Y.encodeStateAsUpdate(peer));owner.changed(alice);assert.equal(owner.state().problem,'node-drafts-conflict');const blocked=await owner.save();assert.equal(blocked.problem,'node-drafts-conflict');await assert.rejects(access(join(config.root,'request-r9.json')))
    const group=inlineContainerEditIndex(document).get(chosen)!;assert.equal(group.conflicts.reviewTitle.length,2);const pick=group.conflicts.reviewTitle.find(choice=>choice.value==='Bob')!.intentId;resolveInlineContainerEdits(document,propertyCodec,chosen,group.ids,{reviewTitle:pick},store.origin);history.stopCapturing();assert.equal(propertyValue(chosen).data.reviewTitle,'Bob');history.undo();assert.equal(inlineContainerEditIndex(document).get(chosen)!.conflicts.reviewTitle.length,2);history.redo();assert.equal(propertyValue(chosen).data.reviewDone,true);assert.match(store.flow.containers!.readBody(chosen).textContent,/^属性协同正文😀 /);materializeInlineContainerEdits(document,propertyCodec)
   }finally{history.destroy();peer.destroy()}
  }
  prefix(chosen,'保存捕获😀 ');owner.changed(alice)
  const state=EditorState.create({schema,doc:store.project()}),at=start(state.doc,chosen)+store.flow.containers!.readBody(chosen).content.size,reference={type:'hcd.mention',version:1,mentionId,target:{kind:'person',id:'bob'},snapshot:{label:'Bob 李'}},tr=state.tr.insert(at,schema.nodes.hcdMention.createChecked({reference}))
  store.reconcile(store.blocks(),[...tr.doc.content.content].map(node=>({key:node.attrs.hcdStructureKey,node})));owner.changed(alice)
  const pending=owner.save();const outcome=pending.then(value=>({value}),error=>({error:String(error)}));await untilFile('committed-response.json')
  if(config.propertyEdits)property(store,chosen,{reviewTitle:'迟到属性'})
  prefix(chosen,'迟到输入😀 ');owner.changed(bob);await owner.persist();await writeFile(join(config.root,'release-drop'),'release')
  const lost=await outcome;assert.ok('error' in lost,JSON.stringify(lost));assert.equal((await json('/revisions?limit=1')).headRevision,9);await owner.persist()
  const token=document.getMap('hcdSave').get('imageAttempt') as string,attempt=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString());assert.equal(attempt.inlineContainers,1)
  await writeFile(join(config.root,'lost-state.yjs'),Y.encodeStateAsUpdate(document));await save('prepare-evidence.json',{pid:process.pid,chosen,mentionId,committedRevision:9,realTcpResponseLost:true,lateBodyPersisted:true,propertyCandidatesResolvedAndLatePropertyPersisted:!!config.propertyEdits,signedAttemptModel:1,captures:attempt.nodes.length,error:lost.error})
  console.log('PASS prepare: actual native commit, lost TCP response, recursive signed capture and persisted later body')
 }else{
  const preparation=JSON.parse(await readFile(join(config.root,'prepare-evidence.json'),'utf8'));assert.notEqual(preparation.pid,process.pid);assert.equal(owner.state().revision,9);assert.equal(owner.state().pending,true);assert.match(store.flow.containers!.readBody(preparation.chosen).textContent,/^迟到输入😀 保存捕获😀 /)
  if(config.propertyEdits){assert.equal(propertyValue(preparation.chosen).data.reviewTitle,'迟到属性');assert.equal(propertyValue(preparation.chosen).data.reviewDone,true);assert.equal(inlineContainerEditIndex(document).get(preparation.chosen)!.intents.length,4)}
  const recovered=jsonToSnapshot(store.project().toJSON(),models);await save('recovered-before-save.json',recovered)
  const state=await owner.save();assert.equal(state.status,'saved');assert.equal(state.revision,10)
  const canonical:Projection=await json('/editor?revision=10');assert.deepEqual(jsonToSnapshot(store.project().toJSON(),models),jsonToSnapshot(projectionToJson(canonical,models),models))
  const r9=await json('/references?revision=9',config.alice),r10=await json('/references?revision=10',config.bob);assert.equal(r9.transition.events.length,1);assert.equal(r9.transition.events[0].kind,'reference.created');assert.equal(r9.transition.events[0].context.actorId,'alice');assert.equal(r10.transition.events.length,0);assert.equal(r10.reminders.enabled,false)
  const occurrence=r9.items.find((item:any)=>item.reference.mentionId===mentionId),laterOccurrence=r10.items.find((item:any)=>item.reference.mentionId===mentionId);assert.ok(occurrence&&laterOccurrence);assert.equal(r9.transition.events[0].mentionId,mentionId);assert.equal(occurrence.reference.target.id,'bob');assert.ok(occurrence.inlinePath.length>0);assert.deepEqual(laterOccurrence.reference,occurrence.reference);assert.equal(r9.items.length,5);assert.equal(r10.items.length,5);await save('references-r9.json',r9);await save('references-r10.json',r10)
  const original=JSON.parse(await readFile(join(config.root,'request-r9.json'),'utf8')),replay=await request('/checkpoints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(original)});assert.equal(replay.status,200);const receipt=await replay.json();assert.equal(receipt.revision,9);assert.equal(receipt.idempotentReplay,true);assert.equal((await json('/revisions?limit=1')).headRevision,10)
  const legacyHeaders={...headers};delete (legacyHeaders as Partial<typeof headers>)['X-HCD-Inline-Containers-Version'];const legacy=await fetch(config.apiUrl+'/checkpoints',{method:'POST',headers:{...legacyHeaders,'Content-Type':'application/json'},body:JSON.stringify(original)});assert.equal(legacy.status,426)
  const denied=await request('/checkpoints',{method:'POST',headers:{Authorization:`Bearer ${config.reader}`,'Content-Type':'application/json'},body:JSON.stringify(original)});assert.equal(denied.status,403)
  assert.equal((await json('/revisions?limit=1')).headRevision,10);assert.equal(document.getMap('hcdSave').has('imageAttempt'),false);await owner.persist();await writeFile(join(config.root,'saved-state.yjs'),Y.encodeStateAsUpdate(document));await save('postreceipt.json',jsonToSnapshot(store.project().toJSON(),models))
  await save('resume-evidence.json',{scope:'Actual authenticated native HTTP and signed coordinator, two separate Node processes; no active Hocuspocus inline room or browser SDK activation',preparePid:preparation.pid,resumePid:process.pid,unknownCommitRecoveredRevision:9,lateInputSavedRevision:10,recursiveSourcesExactlyMatchNative:true,propertyCandidatesAndLatePropertyRecovery:!!config.propertyEdits,originalRequestReplayRevision:9,replayDidNotAdvanceHead:true,oldModelStatus:legacy.status,readOnlyStatus:denied.status,mention:{mentionId,actor:'alice',createdEvents:1,laterTextEvents:0,remindersEnabled:false},pendingAttemptCleared:true,states})
  console.log('PASS resume: native HMAC lineage, recursive source recovery, late body, exact replay and nested mention authors')
 }
}finally{owner.dispose();document.destroy()}
