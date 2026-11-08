import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {WordSaveCoordinator} from '../examples/hdoc/editor/src/wordSaveCoordinator.ts'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {CollaborativeImageDraftStore,imageIntents} from '../examples/hdoc/editor/src/collaborativeImages.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),phase=process.argv[3]
const headers={Authorization:`Bearer ${config.service}`,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1','X-HCD-Collaboration-Epoch':'0','X-HCD-Collaboration-Protocol':'hcd-default/1'}
let uploadPosts=0,canonicalPosts=0
async function request(route:string,init:RequestInit={}){if(route.startsWith('/staged-assets?'))uploadPosts++;if(route==='/word/checkpoints')canonicalPosts++;const url=phase==='upload-prepare'&&route.startsWith('/staged-assets?')?config.uploadProxy+'/upload-drop':config.apiUrl+route;return fetch(url,{...init,headers:{...headers,...init.headers},signal:init.signal??AbortSignal.timeout(60_000)})}
async function json(route:string,token?:string){const response=await request(route,token?{headers:{Authorization:`Bearer ${token}`}}:{});assert.ok(response.ok,`${route}: ${response.status}`);return response.json()}
async function actor(userId:string){const auth=await json('/auth',config[userId]);assert.equal(auth.scope,'write');return{userId:auth.userId,displayName:auth.displayName,scope:'write' as const}}
async function authorized(user:any){if(!config[user.userId])return false;const auth=await json('/auth',config[user.userId]);return auth.scope==='write'&&auth.userId===user.userId&&auth.collaborationEpoch===0}
const bytes=await readFile(config.root+'/replacement.png'),assetHash=createHash('sha256').update(bytes).digest('hex')
if(phase==='upload-prepare'){
 const lineage=randomUUID().replaceAll('-',''),journal=new WordCheckpointJournal(config.root+'/sidecar-owner',config.apiUrl,'rich',0,lineage,config.secret),owner=await WordSaveCoordinator.open({journal,protocol:'hcd-default/1',request,uploadActorAuthorized:authorized,uploadRequest:(user,route,init={})=>request(route,{...init,headers:{...init.headers,Authorization:`Bearer ${config[user.userId]}`}})}),alice=await actor('alice'),bob=await actor('bob')
 const image=(await json('/images')).entries[0],images=new CollaborativeImageDraftStore(owner.model.document);owner.change(bob,()=>images.edit(image,1,{...image.geometry,width:Math.round(image.geometry.width*.8)},undefined,'width'))
 const upload=owner.uploads.start(bob,{nodeId:image.nodeId,extension:'png',bytes}),done=upload.done.then(()=>{throw new Error('expected native upload response loss')},error=>error)
 const deadline=Date.now()+30_000
 while(true){const status=await(await fetch(config.uploadProxy+'/upload-state')).json();if(status.committed)break;assert.ok(Date.now()<deadline,'native upload not received');await new Promise(resolve=>setTimeout(resolve,30))}
 const projection=await json('/editor?revision=1'),body=projection.flowLayout.sections[0].id
 owner.change(alice,()=>{const before=owner.model.region(body),block=before.find(value=>value.node.isTextblock)!;owner.model.reconcile(body,before,before.map(value=>value===block?{key:value.key,node:value.node.type.createChecked(value.node.attrs,owner.model.schema.text('上传中继续输入，恢复后仍保留 😀'))}:value))})
 const blocked=await owner.save();assert.equal(blocked.pending,true);assert.equal(blocked.uploads!.active,1);assert.equal(canonicalPosts,0);assert.equal((await json('/revisions?limit=1')).headRevision,1)
 const durable=(await journal.load())!.capsule;assert.equal(durable.uploads![0].id,upload.id);assert.equal(durable.uploads![0].assetHash,assetHash);assert.equal(durable.uploads![0].phase,'reserved')
 await fetch(config.uploadProxy+'/release-upload',{method:'POST'});assert.ok(await done instanceof Error);assert.equal(owner.state().problem,'word-upload-interrupted')
 await writeFile(config.root+'/upload-prepare.json',JSON.stringify({lineage,id:upload.id,pid:process.pid,imageId:image.nodeId,assetHash}));owner.dispose();owner.model.document.destroy();console.log('PASS native upload committed; save blocked; TCP dropped with durable pending choice')
}else if(phase==='upload-resume'){
 const saved=JSON.parse(await readFile(config.root+'/upload-prepare.json','utf8'));assert.notEqual(process.pid,saved.pid);assert.equal(config.gcAfterUpload,true)
 const journal=new WordCheckpointJournal(config.root+'/sidecar-owner',config.apiUrl,'rich',0,saved.lineage,config.secret),owner=await WordSaveCoordinator.open({journal,protocol:'hcd-default/1',request,uploadActorAuthorized:authorized,uploadRequest:(user,route,init={})=>request(route,{...init,headers:{...init.headers,Authorization:`Bearer ${config[user.userId]}`}})}),bob=await actor('bob')
 assert.equal(owner.state().uploads!.interrupted,1);assert.equal(owner.state().status,'failed');assert.match(owner.model.structure.project().textContent,/上传中继续输入/);assert.equal((await owner.save()).pending,true);assert.equal(canonicalPosts,0)
 const wrong=await actor('alice');assert.throws(()=>owner.uploads.resume(wrong,saved.id),/word-upload-owner-required/)
 const applied=await owner.uploads.resume(bob,saved.id);assert.equal(applied.phase,'applied');assert.equal(uploadPosts,0);assert.equal(imageIntents(owner.model.document).find(entry=>entry.intentId===saved.id)!.assetHash,assetHash)
 await owner.uploads.resume(bob,saved.id);assert.equal(imageIntents(owner.model.document).filter(entry=>entry.intentId===saved.id).length,1);assert.equal((await json('/revisions?limit=1')).headRevision,1)
 const evidence={lineage:saved.lineage,uploadId:saved.id,assetHash,nativeUploadCommittedBeforeResponseDrop:true,saveBlockedWhileUpload:true,canonicalPostsWhilePending:0,separateProcesses:{prepare:saved.pid,resume:process.pid},explicitOwnerResume:true,otherActorCannotClaim:true,stageBytesSurvivedNativeGc:true,resumeUploadedAgain:false,appliedOnce:true,textDuringUploadRetained:true,beforeJointSaveRevision:1}
 await writeFile(config.root+'/upload-recovery.json',JSON.stringify(evidence,null,2)+'\n');await owner.drain();owner.dispose();owner.model.document.destroy();console.log(JSON.stringify(evidence))
}else throw new Error('upload-prepare or upload-resume required')
