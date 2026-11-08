/** Production fixed controller against a real native API; no credentials in evidence. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {api,type Session} from '../examples/hdoc/editor/src/api.ts'
import {FixedSaveController} from '../examples/hdoc/editor/src/fixedSaveController.ts'
import {ImageDraftStore,type PositionedImage} from '../examples/hdoc/editor/src/imageDrafts.ts'
import {TextDraftStore,type TextRun} from '../examples/hdoc/editor/src/textDrafts.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),evidence=[]
for(const document of config.documents){
 const session:Session={documentId:document.documentId,token:document.token,scope:'write',format:document.format,apiUrl:config.apiUrl}
 const peer={...session,token:document.peerToken},texts=new TextDraftStore(),images=new ImageDraftStore(),controller=new FixedSaveController(session,texts,images)
 const textId=document.text.nodeId
 const image=async()=>(await(await api(session,'/images')).json()).entries[0] as PositionedImage
 const text=async()=>(await(await api(session,`/text/${textId}`)).json()) as TextRun&{revision:number}
 const head=async()=>(await(await api(session,'')).json()).revision as number
 const staged=async(name:string)=>(await(await api(session,'/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await readFile(config.root+'/'+name+'.png')})).json()).hash as string
 const peerEdit=async(geometry:Partial<PositionedImage['geometry']>,body?:string,asset?:string)=>{
  const current=await image(),revision=await head(),t=new TextDraftStore(),i=new ImageDraftStore(),c=new FixedSaveController(peer,t,i)
  try{if(body!==undefined)t.edit(await text(),revision,body);if(asset){const upload=i.prepareReplacement(current,revision);upload.commit(asset);upload.finish()}i.edit(current,revision,{...current.geometry,...geometry});return await c.save(revision)}finally{c.dispose()}
 }
 const refresh=async()=>{const revision=await head();images.reconcile([await image()],revision);texts.reconcile([await text()],revision)}
 const record=async(name:string,expectedText:string,color:string)=>{
  const revision=await head(),picture=await image();assert.equal((await text()).text,expectedText)
  const data=await(await api(session,`/export/${session.format}?revision=${revision}${session.format==='pdf'?'&source=true':''}`)).arrayBuffer()
  await writeFile(config.root+`/choice-${document.format}-${name}.${session.format}`,Buffer.from(data))
  return{name,revision,text:expectedText,image:picture,color}
 }
 try{
  const original=await image(),factor=original.geometry.unit==='emu'?12700:1,red=await staged('red'),green=await staged('green')
  const item:any={format:document.format,phases:[]}
  images.edit(original,0,{...original.geometry,x:20*factor},0,'x');images.edit(original,0,{...original.geometry,width:130*factor},0,'width')
  const upload=images.prepareReplacement(original,0);upload.commit(red);upload.finish();texts.edit(document.text,0,'Own chosen text',0)
  assert.equal(await peerEdit({width:180*factor,height:75*factor,y:40*factor},'Peer chosen text',green),1);await refresh()
  assert.ok(images.get(original.nodeId)?.remote);assert.ok(texts.get(textId)?.remote)
  images.resolve(original.nodeId,true);texts.resolve(await text(),1,true);assert.equal(await controller.save(1),2)
  item.phases.push(await record('chosen','Own chosen text','red'))
  await controller.history.step('undo');assert.equal(await controller.save(2),3)
  assert.equal(await peerEdit({height:90*factor}),4);await refresh()
  await controller.history.step('undo');assert.equal(images.get(original.nodeId)?.geometry.x,20*factor);assert.equal(images.get(original.nodeId)?.geometry.width,180*factor);assert.equal(images.get(original.nodeId)?.geometry.height,90*factor)
  assert.equal(await controller.save(4),5);item.phases.push(await record('undo','Peer chosen text','green'))
  await controller.history.step('redo');assert.equal(await controller.save(5),6)
  await controller.history.step('redo');assert.equal(await controller.save(6),7);item.phases.push(await record('redo','Own chosen text','red'))
  const current=await image();images.edit(current,7,{...current.geometry,width:150*factor},0,'width');texts.edit(await text(),7,'Own rejected text',0)
  assert.equal(await peerEdit({width:210*factor,height:95*factor},'Peer newer text'),8);await refresh()
  images.resolve(original.nodeId,false);texts.resolve(await text(),8,false);assert.equal(images.size+texts.size,0)
  await controller.history.step('undo');await controller.history.step('undo');assert.ok(images.get(original.nodeId)?.remote);assert.ok(texts.get(textId)?.remote)
  await assert.rejects(controller.save(8),/draftsNotReady/);assert.equal(await head(),8)
  assert.equal(await peerEdit({height:105*factor}),9);await refresh()
  await controller.history.step('redo');await controller.history.step('redo');assert.equal(images.size+texts.size,0);assert.equal(await image().then(value=>value.geometry.height),105*factor)
  await controller.history.step('undo');await controller.history.step('undo');assert.equal(await peerEdit({width:230*factor}),10);await refresh()
  await assert.rejects(controller.history.step('redo'),/historyConflict/);assert.equal(await head(),10);assert.equal(images.get(original.nodeId)?.geometry.width,150*factor)
  // Later saved edits can be unwound across choices without intermediate saves,
  // even when another target lies between those actions in the timeline.
  images.resolve(original.nodeId,false);texts.resolve(await text(),10,false)
  images.edit(await image(),10,{...(await image()).geometry,width:250*factor},0,'width')
  assert.equal(await controller.save(10,original.nodeId),11)
  await controller.history.step('undo');await controller.history.step('undo');await controller.history.step('undo')
  assert.equal(images.get(original.nodeId)?.geometry.width,150*factor);assert.ok(images.get(original.nodeId)?.remote);assert.ok(texts.get(textId)?.remote)
  await controller.history.step('redo');await controller.history.step('redo');await controller.history.step('redo')
  assert.equal(images.size+texts.size,0);assert.equal(await head(),11)
  texts.edit(await text(),11,'Own second rejected',0);assert.equal(await peerEdit({},'Peer second text'),12);await refresh()
  texts.resolve(await text(),12,false);texts.edit(await text(),12,'Own after choice',0);assert.equal(await controller.save(12),13)
  await controller.history.step('undo');await controller.history.step('undo');assert.ok(texts.get(textId)?.remote)
  await controller.history.step('redo');await controller.history.step('redo');assert.equal(texts.size,0);assert.equal((await text()).text,'Own after choice')
  item.remoteChoiceUndoRestoresConflict=true;item.redoPreservesUnrelatedPeerFields=true;item.newerConflictingPeerValueBlocksRedo=true;item.sequentialHistoryAcrossLaterSavedEdits=true;item.finalRevision=13;evidence.push(item)
  console.log(`PASS ${document.format}: saved local choices, remote choice recovery and newer peer conflict`)
 }finally{controller.dispose()}
}
await writeFile(config.root+'/fixed-choice-evidence.json',JSON.stringify(evidence,null,2)+'\n')
