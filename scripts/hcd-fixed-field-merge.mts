/** Continue the isolated r8 fixtures from hcd-fixed-history.py using ordinary
 * draft edits and two actual server identities, including an upload-only target. */
import {readFile,writeFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {FixedSaveController} from '../examples/hdoc/editor/src/fixedSaveController.ts'
import {TextDraftStore} from '../examples/hdoc/editor/src/textDrafts.ts'
import {ImageDraftStore,desiredAsset,type PositionedImage} from '../examples/hdoc/editor/src/imageDrafts.ts'
import {refreshImageDrafts} from '../examples/hdoc/editor/src/saveEdits.ts'
import {api,type Session} from '../examples/hdoc/editor/src/api.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),evidence=[]
for(const doc of config.documents){
 const session:Session={documentId:doc.documentId,format:doc.format,token:doc.token,scope:'write',apiUrl:config.apiUrl,userId:'history-writer'}
 const texts=new TextDraftStore(),images=new ImageDraftStore(),controller=new FixedSaveController(session,texts,images)
 const get=async(route:string)=>(await api(session,route)).json()
 const picture=async()=>((await get('/images')).entries[0]) as PositionedImage
 const stage=async(color:string)=>(await(await api(session,'/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await readFile(`${config.root}/${color}.png`)})).json()).hash as string
 const peer=async(base:number,image:PositionedImage,geometry:PositionedImage['geometry'],assetHash?:string)=>{
  const precondition={visualHash:image.visualHash}
  return (await api({...session,token:doc.peerToken},'/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:'hcd-patch/3',documentId:doc.documentId,patchId:'field-peer-'+crypto.randomUUID(),baseRevision:base,operations:[...(assetHash?[{op:'image.replace',nodeId:image.nodeId,assetHash,precondition}]:[]),{op:'image.geometry',nodeId:image.nodeId,geometry,precondition}]})})).json()
 }
 try{
  assert.equal((await get('')).revision,8)
  const initial=await picture(),original=doc.format==='pdf'?{width:40,height:30}: {width:1270000,height:635000}
  const green=await stage('green'),blue=await stage('blue'),red=await stage('red')
  const pendingUpload=images.prepareReplacement(initial,8,0)
  assert.equal(images.size,0);assert.deepEqual(images.trackingIds,[initial.nodeId])
  const height=original.height*1.8
  assert.equal((await peer(8,initial,{...initial.geometry,height})).revision,9)
  let observed=0;await refreshImageDrafts(session,images,revision=>{observed=revision});assert.equal(observed,9)
  pendingUpload.commit(green);pendingUpload.finish()
  images.edit(initial,8,{...initial.geometry,width:original.width*1.5},0,'width')
  const content=doc.format==='pdf'?'Field merge':'字段合并 中文😀'
  const run=await get('/text/'+doc.text.nodeId);texts.edit(run,run.revision,content,0)
  assert.equal(images.get(initial.nodeId)?.geometry.height,height);assert.equal(images.get(initial.nodeId)?.remote,undefined)
  assert.equal(await controller.save(9),10)
  const merged=await picture();assert.equal(merged.geometry.width,original.width*1.5);assert.equal(merged.geometry.height,height);assert.equal(merged.assetHash,green)
  await writeFile(`${config.root}/field-merged.${doc.format}`,new Uint8Array(await(await api(session,`/export/${doc.format}?revision=10${doc.format==='pdf'?'&source=true':''}`)).arrayBuffer()))
  const delta=original.width*.1
  images.edit(merged,10,{...merged.geometry,width:original.width*2,x:merged.geometry.x+delta})
  const upload=images.prepareReplacement(merged,10,0);upload.commit(red);upload.finish()
  const remoteGeometry={...merged.geometry,width:original.width*1.75,height:original.height*2,y:merged.geometry.y+delta}
  assert.equal((await peer(10,merged,remoteGeometry,blue)).revision,11)
  await refreshImageDrafts(session,images,()=>{})
  assert.deepEqual(new Set(images.get(initial.nodeId)?.conflictingFields),new Set(['width','assetHash']))
  assert.equal(images.get(initial.nodeId)?.geometry.x,merged.geometry.x+delta)
  images.resolve(initial.nodeId,false)
  const chosen=images.get(initial.nodeId)!
  assert.equal(chosen.geometry.width,remoteGeometry.width);assert.equal(chosen.geometry.height,remoteGeometry.height);assert.equal(chosen.geometry.y,remoteGeometry.y);assert.equal(chosen.geometry.x,merged.geometry.x+delta)
  assert.equal(desiredAsset(chosen),blue);assert.equal(chosen.assetHash,undefined);assert.equal(chosen.remote,undefined)
  assert.equal(await controller.save(11),12)
  const final=await picture();assert.equal(final.geometry.x,merged.geometry.x+delta);assert.equal(final.geometry.width,remoteGeometry.width);assert.equal(final.assetHash,blue)
  assert.equal((await get('/text/'+doc.text.nodeId)).text,content)
  await writeFile(`${config.root}/field-choice.${doc.format}`,new Uint8Array(await(await api(session,`/export/${doc.format}?revision=12${doc.format==='pdf'?'&source=true':''}`)).arrayBuffer()))
  evidence.push({format:doc.format,documentId:doc.documentId,uploadOnlyTrackingVerified:true,mergedRevision:10,choiceRevision:12,expectedText:content,merged:{geometry:merged.geometry,assetHash:green,rgb:[0,255,0]},choice:{geometry:final.geometry,assetHash:blue,rgb:[0,0,255]},conflicts:['width','assetHash'],remoteChoiceRetainsLocalX:true})
  process.stdout.write(`PASS ${doc.format}: upload + geometry merge r10; field-specific remote choice retains local X at r12\n`)
 }finally{controller.dispose()}
}
await writeFile(config.root+'/field-merge-evidence.json',JSON.stringify(evidence,null,2)+'\n')
