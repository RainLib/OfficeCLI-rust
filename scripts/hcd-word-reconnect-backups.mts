/** Decode only the two actual product downloads with the production reader. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {readWordDeviceBackup} from '../examples/hdoc/editor/src/wordDeviceBackupReader.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
const [root,out]=process.argv.slice(2).map(value=>resolve(value)),config=JSON.parse(await readFile(root+'/private.json','utf8')),projection=JSON.parse(await readFile(out+'/final-projection.json','utf8'))
assert.equal(config.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
const session={documentId:config.documentId,token:config.bob,userId:'bob',scope:'write' as const,format:'docx',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${config.browserCollabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const},results=[]
for(const name of ['before-restart','after-reconnect']){
 const raw=await readFile(`${out}/${name}.hcd-word-draft`,'utf8'),copy=await readWordDeviceBackup(raw,session,config.pages.bob),document=new Y.Doc()
 try{
  Y.applyUpdate(document,copy.document);const model=new WordRegionStore(document,wordRegionSchema(),config.documentId,projection.flowLayout,projection.flowLayoutHash),text=model.capture().regions.map(region=>model.project(region.regionId).textContent).join('\n')
  for(const marker of ['Alice 重连前输入','Bob 重连前草稿'])assert.equal(text.split(marker).length-1,1)
  assert.equal(text.split('Bob 重连后续存').length-1,Number(name==='after-reconnect'));assert.deepEqual(model.layoutState().layout,projection.flowLayout)
  results.push({name,schemaVersion:JSON.parse(raw).schemaVersion,markersOnce:true,exactLayout:true,documentBytes:copy.document.length,localUpdates:copy.localUpdates.length})
 }finally{document.destroy()}
}
await writeFile(out+'/backups.json',JSON.stringify(results,null,2)+'\n')
