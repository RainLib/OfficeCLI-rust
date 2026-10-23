/** Native API/file proof using the same controller used by the fixed editor.
 * Run through the fixture wrapper hcd-fixed-history.py; no credentials in logs. */
import {readFile,writeFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {FixedSaveController} from '../examples/hdoc/editor/src/fixedSaveController.ts'
import {TextDraftStore,type TextRun} from '../examples/hdoc/editor/src/textDrafts.ts'
import {ImageDraftStore,type PositionedImage} from '../examples/hdoc/editor/src/imageDrafts.ts'
import {api,ApiError,type Session} from '../examples/hdoc/editor/src/api.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8'))
const evidence=[]
const originalFetch=globalThis.fetch
const sentPatches:any[]=[]
globalThis.fetch=async(url,init)=>{if(String(url).endsWith('/edits')&&init?.method==='POST')sentPatches.push(JSON.parse(String(init.body)));return originalFetch(url,init)}
for(const document of config.documents){
 const session:Session={documentId:document.documentId,format:document.format,token:document.token,scope:'write',apiUrl:config.apiUrl,userId:'history-writer'}
 const texts=new TextDraftStore(),images=new ImageDraftStore(),controller=new FixedSaveController(session,texts,images)
 try{
  const original=document.text as TextRun
  const picture=(await(await api(session,'/images')).json()).entries[0] as PositionedImage
  const staged=await(await api(session,'/staged-assets?extension=png',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:await readFile(config.root+'/red.png')})).json()
  if(document.format!=='pdf'){
   await assert.rejects(api(session,'/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:'hcd-patch/3',documentId:session.documentId,patchId:'invalid-restore-source',baseRevision:0,operations:[{op:'text.splice',nodeId:original.nodeId,start:0,deleteCount:[...original.text].length,insertText:'must roll back',precondition:{nodeHash:original.nodeHash}},{op:'image.restoreSource',nodeId:picture.nodeId,precondition:{visualHash:picture.visualHash}}]})}),error=>error instanceof ApiError&&error.status>=400)
   assert.equal((await(await api(session,'')).json()).revision,0)
   assert.equal((await(await api(session,'/text/'+original.nodeId)).json()).text,original.text)
  }
  const text=document.format==='pdf'?'Own undo text':'自己的编辑 中文😀'
  texts.edit(original,0,text,0);controller.history.stopCapturing()
  const upload=images.prepareReplacement(picture,0,0);upload.commit(staged.hash);upload.finish()
  images.edit(picture,0,{...picture.geometry,width:picture.geometry.width*1.25},0,'width')
  assert.equal(await controller.save(0),1)
  const own=(await(await api(session,'/images/'+picture.nodeId)).json()).image as PositionedImage
  const peerHeight=picture.geometry.height*1.5
  const peer=await(await api({...session,token:document.peerToken},'/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:'hcd-patch/3',documentId:session.documentId,patchId:'peer-height-'+crypto.randomUUID(),baseRevision:1,operations:[{op:'image.geometry',nodeId:picture.nodeId,geometry:{...own.geometry,height:peerHeight},precondition:{visualHash:own.visualHash}}]})})).json()
  assert.equal(peer.revision,2)
  const steps=[]
  for(const direction of ['undo','undo','undo','redo','redo','redo'] as const){
   const checked=await controller.history.step(direction)
   const saved=await controller.save(checked.revision)
   if(saved===3||saved===8){const patch=sentPatches.at(-1);assert.deepEqual(patch.operations.map((op:any)=>op.op),['image.geometry'])}
   steps.push({direction,revision:saved,type:checked.type})
   const current=(await(await api(session,'/images/'+picture.nodeId)).json()).image as PositionedImage
   assert.equal(current.geometry.height,peerHeight)
   if(saved===3)assert.equal(current.assetHash,staged.hash)
   if(saved===4)assert.equal(current.assetHash,picture.assetHash)
   if(saved===5||saved===8){
    const expected=saved===5?original.text:text
    assert.equal((await(await api(session,'/text/'+original.nodeId)).json()).text,expected)
    assert.equal(current.geometry.width,saved===5?picture.geometry.width:picture.geometry.width*1.25)
    const bytes=await(await api(session,`/export/${session.format}?revision=${saved}${session.format==='pdf'?'&source=true':''}`)).arrayBuffer()
    await writeFile(`${config.root}/history-${saved===5?'undo':'redo'}.${session.format}`,new Uint8Array(bytes))
   }
  }
  assert.equal((await(await api(session,'')).json()).revision,8)
  const inverse=sentPatches.find(patch=>patch.documentId===session.documentId&&patch.operations.some((op:any)=>op.op==='image.restoreSource')&&patch.patchId!=='invalid-restore-source')
  if(inverse){const resolved=await(await api(session,'/edits/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(inverse)})).json();assert.equal(resolved.status,'committed');assert.equal(resolved.revision,4);assert.equal(resolved.images[0].assetHash??null,picture.assetHash??null);assert.equal((await(await api(session,'')).json()).revision,8)}
  evidence.push({geometryInverseHasNoResourceOperation:true,sourceRestoreReceiptVerified:!!inverse,documentId:session.documentId,format:session.format,originalText:original.text,editedText:text,originalAsset:picture.assetHash,editedAsset:staged.hash,originalGeometry:picture.geometry,peerHeight,steps,undoRevision:5,redoRevision:8})
  process.stdout.write(`PASS ${session.format}: own text/resource/width undo+redo, peer height retained, exported r5/r8\n`)
 }finally{controller.dispose()}
}
globalThis.fetch=originalFetch
await writeFile(config.root+'/history-evidence.json',JSON.stringify(evidence,null,2)+'\n')
