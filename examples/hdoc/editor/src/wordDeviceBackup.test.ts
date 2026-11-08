import {test} from 'node:test'
import assert from 'node:assert/strict'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import {WordDeviceDraft,wordDeviceIdentity} from './wordDeviceDraft.ts'
import {downloadWordDeviceBackup,hasWordDeviceBackup,listWordDeviceBackups,openExistingWordDevice,openWordDeviceCopy,wordDeviceBackup} from './wordDeviceBackup.ts'
import {wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'
import type {Session} from './api.ts'
import {nodeResourceHash} from './wordNodeResources.ts'
import {withRegionalFileLock} from './regionalFileBoundary.ts'
import {readWordDeviceBackup} from './wordDeviceBackupReader.ts'
import {wordDeviceImportId} from './wordDeviceBackupImport.ts'
const decode=(value:string)=>Uint8Array.from(atob(value),char=>char.charCodeAt(0))
function legacyBackup(backup:any,version:'2'|'3'|'4'){const {documentBase64,...rest}=backup;const result={...rest,schemaVersion:`hcd-word-device/${version}`,document:Array.from(decode(documentBase64)),nodeResources:backup.nodeResources.map(({bytesBase64,...item}:any)=>({...item,bytes:Array.from(decode(bytesBase64))}))};if(version!=='4'){delete result.scopeHash;delete result.localUpdates}return result}
const session:Session={documentId:'doc',token:'secret',scope:'write',format:'docx',apiUrl:'https://example.test/v1/documents',collabUrl:'wss://example.test/collab',userId:'alice',collaborationEpoch:4,collaborationProtocol:wordRegionalProtocol}
test('backup fingerprints remain stable and distinguish Unicode at chunk boundaries',async()=>{
 const text='x'.repeat(262143)+'😀'+'y';assert.equal(await wordDeviceImportId(text),await wordDeviceImportId(text));assert.notEqual(await wordDeviceImportId(text),await wordDeviceImportId('x'.repeat(262143)+'��'+'y'))
 const signal=new AbortController();signal.abort();await assert.rejects(wordDeviceImportId(text,signal.signal))
})
test('verified device backup stages text and pending files atomically and only once',async()=>{
 const sourceFactory=new IDBFactory(),targetFactory=new IDBFactory(),base='https://example.test/editor',identity=await wordDeviceIdentity(session,'alice',base),source=await WordDeviceDraft.open(identity.name,sourceFactory),target=await WordDeviceDraft.open(identity.name,targetFactory),doc=new Y.Doc(),data=new TextEncoder().encode('pending file'),assetHash=await nodeResourceHash(data),nodeId='n_'+'1'.repeat(32),visualHash='b'.repeat(64)
 const resource={key:'r_fixture',name:'note.bin',mediaType:'application/octet-stream',byteLength:data.length,hash:assetHash},item={version:1 as const,id:crypto.randomUUID(),regionId:nodeId,expected:{schemaVersion:'hcd.extension/1' as const,instanceId:'x_'+'2'.repeat(32),type:'test.card',version:1,display:'block' as const,data:{},fallback:{text:'note'}},resource,bytes:data,phase:'chosen' as const}
 const upload={name:'original.png',bytes:data,selection:{id:crypto.randomUUID(),nodeId,extension:'png' as const,assetHash,byteLength:data.length,revision:1,clientId:42,visualHash,seen:[]},before:{nodeId,visualHash,geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}}}
 try{
  doc.getText('body').insert(0,'base');await source.bind(doc);doc.getText('body').insert(4,' own');await source.putNodeResource(item);await source.putUpload(upload);await source.flush()
  const parsed=await readWordDeviceBackup(await wordDeviceBackup(source,session),session,base),input={...parsed,id:'a'.repeat(64)};assert.equal(parsed.sameScope,true)
  assert.equal(await target.importBackup(input),true);assert.equal(await target.importBackup(input),false);assert.equal((await target.pendingNodeResources()).length,1);assert.equal((await target.pendingUploads()).length,1);assert.equal((await target.pendingRecords()).records.filter(record=>record.local).length,1)
  const restored=await target.document();try{assert.equal(restored.getText('body').toString(),'base own')}finally{restored.destroy()}
  const conflict={...input,id:'b'.repeat(64),uploads:[{...upload,name:'different.png'}]};const before=(await target.records()).length;await assert.rejects(target.importBackup(conflict),/word-upload-local-changed/);assert.equal((await target.records()).length,before);assert.equal((await target.pendingNodeResources()).length,1)
 }finally{await source.close();await target.close();doc.destroy()}
})
test('compatibility backup never creates a missing journal and stays scoped to the authenticated member and epoch',async()=>{
 const factory=new IDBFactory(),base='https://example.test/editor',identity=await wordDeviceIdentity(session,'alice',base)
 assert.equal(await openExistingWordDevice(session,base,factory),null);assert.equal((await factory.databases()).length,0)
 const cache=await WordDeviceDraft.open(identity.name,factory),doc=new Y.Doc();try{
  doc.getText('body').insert(0,'saved');await cache.bind(doc);doc.getText('body').insert(5,' local draft');await cache.flush();assert.equal(await hasWordDeviceBackup(cache),true)
  const bytes=new TextEncoder().encode('pending attachment'),resource={key:'r_fixture',name:'note.bin',mediaType:'application/octet-stream',byteLength:bytes.length,hash:await nodeResourceHash(bytes)}
  await cache.putNodeResource({version:1,id:crypto.randomUUID(),regionId:'n_'+'1'.repeat(32),expected:{schemaVersion:'hcd.extension/1',instanceId:'x_'+'2'.repeat(32),type:'test.card',version:1,display:'block',data:{},fallback:{text:'note'}},resource,bytes,phase:'chosen'})
  const backup=JSON.parse(await wordDeviceBackup(cache,session)),reopened=new Y.Doc();try{Y.applyUpdate(reopened,decode(backup.documentBase64));assert.equal(reopened.getText('body').toString(),'saved local draft');assert.equal(backup.documentId,'doc');assert.equal(backup.epoch,4);assert.deepEqual(decode(backup.nodeResources[0].bytesBase64),bytes);assert.equal(backup.nodeResources[0].resource.hash,resource.hash)}finally{reopened.destroy()}
  const v4=await readWordDeviceBackup(JSON.stringify(legacyBackup(backup,'4')),session,base);assert.equal(v4.sameScope,true);assert.deepEqual(v4.nodeResources[0].bytes,bytes)
  const parsed=await readWordDeviceBackup(JSON.stringify(backup),session,base);assert.equal(parsed.sameScope,true);assert.deepEqual(parsed.nodeResources[0].bytes,bytes);assert.equal((await readWordDeviceBackup(JSON.stringify(backup),{...session,userId:'bob'},base)).sameScope,false)
  for(const altered of [{...backup,epoch:3},{...backup,scopeHash:'f'.repeat(64)}])assert.equal((await readWordDeviceBackup(JSON.stringify(altered),session,base)).sameScope,false)
  const damaged=structuredClone(backup);damaged.nodeResources[0].bytesBase64=damaged.nodeResources[0].bytesBase64.replace(/^./,'/');await assert.rejects(readWordDeviceBackup(JSON.stringify(damaged),session,base),/invalid/)
  for(const altered of [{...backup,documentId:'another'},{...backup,localUpdates:['%%%%']},{...backup,extra:true},{...backup,document:[256]}])await assert.rejects(readWordDeviceBackup(JSON.stringify(altered),session,base),/invalid/)
  const legacy=legacyBackup(backup,'2');const old=await readWordDeviceBackup(JSON.stringify(legacy),session,base);assert.equal(old.sameScope,false);assert.deepEqual(old.localUpdates,[])
  await assert.rejects(downloadWordDeviceBackup(cache,session,()=>false),/word-device-scope-changed/)
  assert.ok((await cache.localUpdates()).length>0);assert.equal(await openExistingWordDevice({...session,userId:'bob'},base,factory),null);assert.equal(await openExistingWordDevice({...session,collaborationEpoch:5},base,factory),null)
  const bad={version:1 as const,id:crypto.randomUUID(),regionId:'n_'+'1'.repeat(32),expected:{schemaVersion:'hcd.extension/1' as const,instanceId:'x_'+'3'.repeat(32),type:'test.card',version:1,display:'block' as const,data:{},fallback:{text:'corrupt'}},resource:{...resource,key:'r_corrupt',hash:'0'.repeat(64)},bytes,phase:'chosen' as const};await cache.putNodeResource(bad)
  await assert.rejects(wordDeviceBackup(cache,session),/word-node-resource-integrity/);assert.equal((await cache.pendingNodeResources()).length,2);assert.ok((await cache.localUpdates()).length>0)
 }finally{await cache.close();doc.destroy()}
 const found=await openExistingWordDevice(session,base,factory);assert.ok(found);try{assert.equal(await hasWordDeviceBackup(found),true)}finally{await found.close()}
})
test('older device copies are listed by authenticated scope and downloaded with their own epoch',async()=>{
 const factory=new IDBFactory(),base='https://example.test/editor',documents:Y.Doc[]=[],open:WordDeviceDraft[]=[]
 try{
  for(const [user,epoch,text] of [['alice',1,'older own'],['alice',4,'current own'],['alice',5,'future'],['bob',1,'other member']] as const){
   const scoped={...session,userId:user,collaborationEpoch:epoch},identity=await wordDeviceIdentity(scoped,user,base),cache=await WordDeviceDraft.open(identity.name,factory),doc=new Y.Doc();open.push(cache);documents.push(doc);doc.getText('body').insert(0,'seed');await cache.bind(doc);doc.getText('body').insert(4,text);await cache.flush()
  }
  const result=await listWordDeviceBackups(session,base,factory);assert.equal(result.olderDiscovery,true);assert.equal(result.unavailable,false);assert.deepEqual(result.copies.map(copy=>copy.epoch),[4,1])
  const old=result.copies[1],cache=await openWordDeviceCopy(session,base,old,factory);assert.ok(cache);try{const backup=JSON.parse(await wordDeviceBackup(cache,{...session,collaborationEpoch:old.epoch}));assert.equal(backup.epoch,1);const restored=new Y.Doc();try{Y.applyUpdate(restored,decode(backup.documentBase64));assert.match(restored.getText('body').toString(),/older own/)}finally{restored.destroy()}}finally{await cache.close()}
  const bob=await wordDeviceIdentity({...session,userId:'bob'},'bob',base);await assert.rejects(openWordDeviceCopy(session,base,{name:bob.name,epoch:4},factory),/word-device-scope/)
  const future=await wordDeviceIdentity({...session,collaborationEpoch:5},'alice',base);await assert.rejects(openWordDeviceCopy(session,base,{name:future.name,epoch:5},factory),/word-device-scope/)
  const noEnumeration=new Proxy(factory,{get(target,key){if(key==='databases')return undefined;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
  const fallback=await listWordDeviceBackups(session,base,noEnumeration);assert.equal(fallback.olderDiscovery,false);assert.deepEqual(fallback.copies.map(copy=>copy.epoch),[4])
 }finally{for(const cache of open)await cache.close();for(const doc of documents)doc.destroy()}
})
test('large device inventory keeps the current draft available and reports an incomplete list',async()=>{
 const factory=new IDBFactory(),base='https://example.test/editor',identity=await wordDeviceIdentity(session,'alice',base),doc=new Y.Doc(),cache=await WordDeviceDraft.open(identity.name,factory)
 try{
  doc.getText('body').insert(0,'seed');await cache.bind(doc);doc.getText('body').insert(4,' current');await cache.flush()
  for(let i=0;i<65;i++){const copy=await WordDeviceDraft.open(`${identity.name}-${i.toString(16).padStart(36,'0')}`,factory);try{if(i===64){const old=new Y.Doc();try{old.getText('body').insert(0,'seed');await copy.bind(old);old.getText('body').insert(4,' older copy');await copy.flush()}finally{old.destroy()}}}finally{await copy.close()}}
  const result=await listWordDeviceBackups(session,base,factory)
  assert.equal(result.truncated,true);assert.equal(result.unavailable,false);assert.deepEqual(result.copies.map(copy=>copy.name),[identity.name])
  assert.ok(result.next);const second=await listWordDeviceBackups(session,base,factory,result.next);assert.equal(second.truncated,false);assert.deepEqual(second.copies.map(copy=>copy.name),[`${identity.name}-${(64).toString(16).padStart(36,'0')}`])
  await assert.rejects(listWordDeviceBackups(session,base,factory,{name:'missing',epoch:4}),/word-device-list-changed/)
  const reopened=await openWordDeviceCopy(session,base,result.copies[0],factory);assert.ok(reopened);try{assert.ok(await hasWordDeviceBackup(reopened))}finally{await reopened.close()}
 }finally{await cache.close();doc.destroy()}
})
test('download stops if the session changes while its backup is being assembled',async()=>{
 const factory=new IDBFactory(),identity=await wordDeviceIdentity(session,'alice','https://example.test/editor'),cache=await WordDeviceDraft.open(identity.name,factory),doc=new Y.Doc()
 try{
  doc.getText('body').insert(0,'seed');await cache.bind(doc);doc.getText('body').insert(4,' unsaved');await cache.flush()
  const original=cache.records.bind(cache);let release!:()=>void,started!:()=>void
  const waiting=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
  cache.records=async()=>{started();await waiting;return original()}
  let active=true;const pending=downloadWordDeviceBackup(cache,session,()=>active);await entered;active=false;release()
  await assert.rejects(pending,/word-device-scope-changed/);assert.ok(await hasWordDeviceBackup(cache));assert.ok((await cache.localUpdates()).length>0)
 }finally{await cache.close();doc.destroy()}
})
test('device backup includes verified pending image bytes in the new schema',async()=>{
 const factory=new IDBFactory(),identity=await wordDeviceIdentity(session,'alice','https://example.test/editor'),cache=await WordDeviceDraft.open(identity.name,factory),bytes=Uint8Array.from({length:24581},(_,index)=>index%251),hash=await nodeResourceHash(bytes),nodeId='n_'+'1'.repeat(32),visualHash='b'.repeat(64)
 const choice={name:'original.png',bytes,selection:{id:crypto.randomUUID(),nodeId,extension:'png' as const,assetHash:hash,byteLength:bytes.length,revision:1,clientId:42,visualHash,seen:[]},before:{nodeId,visualHash,geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}}}
 try{await cache.putUpload(choice);const backup=JSON.parse(await wordDeviceBackup(cache,session));assert.equal(backup.schemaVersion,'hcd-word-device/5');assert.deepEqual(Uint8Array.from(atob(backup.uploads[0].bytesBase64),value=>value.charCodeAt(0)),bytes);assert.deepEqual((await readWordDeviceBackup(JSON.stringify(backup),session,'https://example.test/editor')).uploads[0].bytes,bytes);const legacy=legacyBackup(backup,'3');const old=await readWordDeviceBackup(JSON.stringify(legacy),session,'https://example.test/editor');assert.equal(old.sameScope,false);assert.deepEqual(old.uploads[0].bytes,bytes);const corrupted=structuredClone(backup);corrupted.uploads[0].bytesBase64=corrupted.uploads[0].bytesBase64.replace(/^./,'/');await assert.rejects(readWordDeviceBackup(JSON.stringify(corrupted),session,'https://example.test/editor'),/invalid/);const boundary=structuredClone(backup);boundary.uploads[0].bytesBase64=boundary.uploads[0].bytesBase64.slice(0,32767)+'='+boundary.uploads[0].bytesBase64.slice(32768);await assert.rejects(readWordDeviceBackup(JSON.stringify(boundary),session,'https://example.test/editor'),/invalid/);assert.equal(backup.uploads[0].selection.assetHash,hash);assert.equal((await cache.pendingUploads()).length,1);await assert.rejects(cache.putUpload({...choice,selection:{...choice.selection,id:crypto.randomUUID()},bytes:Uint8Array.from(bytes,byte=>byte^1)}),/integrity/);const cancelled=new AbortController();cancelled.abort();await assert.rejects(cache.putUpload({...choice,selection:{...choice.selection,id:crypto.randomUUID()}},cancelled.signal));assert.equal((await cache.pendingUploads()).length,1)}finally{await cache.close()}
})
test('device backup separates local updates from peer changes and keeps reviewed updates out',async()=>{
 const factory=new IDBFactory(),identity=await wordDeviceIdentity(session,'alice','https://example.test/editor'),cache=await WordDeviceDraft.open(identity.name,factory),local=new Y.Doc(),peer=new Y.Doc(),server=new Y.Doc()
 try{
  local.getText('body').insert(0,'Base');Y.applyUpdate(peer,Y.encodeStateAsUpdate(local));Y.applyUpdate(server,Y.encodeStateAsUpdate(local));await cache.bind(local)
  local.getText('body').insert(4,' Reviewed');await cache.flush();await cache.markReviewed((await cache.records()).length)
  Y.applyUpdate(server,Y.encodeStateAsUpdate(local));local.getText('body').insert(local.getText('body').length,' Own');let remote!:Uint8Array;peer.on('update',value=>{remote=value});peer.getText('body').insert(0,'Peer ');Y.applyUpdate(local,remote,'peer');await cache.flush()
  const backup=JSON.parse(await wordDeviceBackup(cache,session));assert.equal(backup.schemaVersion,'hcd-word-device/5');assert.equal(backup.scopeHash,identity.prefix.slice('hcd-local-draft-v1-'.length,-1));assert.equal(backup.localUpdates.length,1)
  for(const update of backup.localUpdates)Y.applyUpdate(server,Uint8Array.from(atob(update),value=>value.charCodeAt(0)));assert.equal(server.getText('body').toString(),'Base Reviewed Own')
  const comparison=new Y.Doc();try{Y.applyUpdate(comparison,decode(backup.documentBase64));assert.match(comparison.getText('body').toString(),/Peer/)}finally{comparison.destroy()}
  await assert.rejects(wordDeviceBackup(cache,{...session,collaborationEpoch:3}),/scope/)
 }finally{await cache.close();local.destroy();peer.destroy();server.destroy()}
})
test('backup retries when local updates arrive between journal reads',async()=>{
 const factory=new IDBFactory(),identity=await wordDeviceIdentity(session,'alice','https://example.test/editor'),cache=await WordDeviceDraft.open(identity.name,factory),doc=new Y.Doc()
 try{
  doc.getText('body').insert(0,'Base');await cache.bind(doc);await cache.flush();const read=cache.pendingRecords.bind(cache);let injected=false
  cache.pendingRecords=async()=>{if(!injected){injected=true;doc.getText('body').insert(4,' New');await cache.flush()}return read()}
  const backup=JSON.parse(await wordDeviceBackup(cache,session)),copy=new Y.Doc();try{Y.applyUpdate(copy,decode(backup.documentBase64));assert.equal(copy.getText('body').toString(),'Base New');assert.equal(backup.localUpdates.length,1)}finally{copy.destroy()}
 }finally{await cache.close();doc.destroy()}
})
test('backup refuses a continuously changing journal instead of producing a partial copy',async()=>{
 const factory=new IDBFactory(),identity=await wordDeviceIdentity(session,'alice','https://example.test/editor'),cache=await WordDeviceDraft.open(identity.name,factory),doc=new Y.Doc()
 try{doc.getText('body').insert(0,'Base');await cache.bind(doc);await cache.flush();const read=cache.pendingRecords.bind(cache);cache.pendingRecords=async()=>{doc.getText('body').insert(0,'x');await cache.flush();return read()};await assert.rejects(wordDeviceBackup(cache,session),/word-device-backup-changed/);assert.equal((await cache.records()).filter(record=>record.local).length,3)}finally{await cache.close();doc.destroy()}
})
test('cancelling while upload publication waits for a file lock cannot resurrect it',async()=>{
 const previous=globalThis.navigator,tails=new Map<string,Promise<void>>();let queued!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{queued=resolve}),hold=new Promise<void>(resolve=>{release=resolve});let count=0
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name:string,work:()=>Promise<unknown>)=>{const before=tails.get(name)??Promise.resolve();let end!:()=>void;const next=new Promise<void>(resolve=>{end=resolve});tails.set(name,before.then(()=>next));if(++count===2)queued();await before;try{return await work()}finally{end()}}}}})
 const factory=new IDBFactory(),identity=await wordDeviceIdentity(session,'alice','https://example.test/editor'),cache=await WordDeviceDraft.open(identity.name,factory),bytes=Uint8Array.of(1,2,3),assetHash=await nodeResourceHash(bytes),nodeId='n_'+'1'.repeat(32),visualHash='b'.repeat(64),controller=new AbortController()
 const choice={name:'original.png',bytes,selection:{id:crypto.randomUUID(),nodeId,extension:'png' as const,assetHash,byteLength:bytes.length,revision:1,clientId:42,visualHash,seen:[]},before:{nodeId,visualHash,geometry:{unit:'pt' as const,x:0,y:0,width:72,height:36}}}
 try{const locked=withRegionalFileLock(identity.name,()=>hold),publication=cache.putUpload(choice,controller.signal),failed=assert.rejects(publication);await waiting;controller.abort();release();await locked;await failed;assert.deepEqual(await cache.pendingUploads(),[]);assert.notEqual(cache.snapshot(),'failed')}finally{release();await cache.close();Object.defineProperty(globalThis,'navigator',{configurable:true,value:previous})}
})
test('large pending attachment remains compact and round-trips through backup inspection',async()=>{
 const factory=new IDBFactory(),base='https://example.test/editor',identity=await wordDeviceIdentity(session,'alice',base),cache=await WordDeviceDraft.open(identity.name,factory)
 const bytes=Uint8Array.from({length:8*1024*1024},(_,i)=>i%251),resource={key:'r_large',name:'附件😀.bin',mediaType:'application/octet-stream',byteLength:bytes.length,hash:await nodeResourceHash(bytes)}
 try{
  await cache.putNodeResource({version:1,id:crypto.randomUUID(),regionId:'n_'+'1'.repeat(32),expected:{schemaVersion:'hcd.extension/1',instanceId:'x_'+'2'.repeat(32),type:'test.card',version:1,display:'block',data:{},fallback:{text:'attachment'}},resource,bytes,phase:'chosen'})
  const body=await wordDeviceBackup(cache,session);assert.ok(body.length<bytes.length*1.35+4096)
  const parsed=await readWordDeviceBackup(body,session,base);assert.equal(parsed.nodeResources[0].resource.name,resource.name);assert.deepEqual(parsed.nodeResources[0].bytes,bytes)
 }finally{await cache.close()}
})
test('bounded UTF-8 length matches encoding across surrogate boundaries',async()=>{
 const {utf8Length}=await import('./wordDeviceBackupFormat.ts');const value='a'.repeat(1024*1024-1)+'😀中文\ud800'
 assert.equal(utf8Length(value),new TextEncoder().encode(value).length)
})

test('layout device journals and compact backups remain isolated from legacy despite the same user, epoch and endpoint',async()=>{
 const factory=new IDBFactory(),base='https://example.test/editor',layoutSession={...session,collaborationProtocol:wordLayoutProtocol},legacyId=await wordDeviceIdentity(session,'alice',base),layoutId=await wordDeviceIdentity(layoutSession,'alice',base),legacy=await WordDeviceDraft.open(legacyId.name,factory),layout=await WordDeviceDraft.open(layoutId.name,factory),oldDoc=new Y.Doc(),newDoc=new Y.Doc()
 try{
  assert.notEqual(legacyId.name,layoutId.name);assert.equal(legacyId.prefix,layoutId.prefix)
  assert.match(layoutId.name,/-wordregions2-device1$/);assert.equal(layout.protocol,wordLayoutProtocol)
  oldDoc.getText('body').insert(0,'old base');await legacy.bind(oldDoc);oldDoc.getText('body').insert(8,' old draft')
  newDoc.getText('body').insert(0,'new base');await layout.bind(newDoc);newDoc.getText('body').insert(8,' new draft');await Promise.all([legacy.flush(),layout.flush()])
  const oldFile=await wordDeviceBackup(legacy,session),newFile=await wordDeviceBackup(layout,layoutSession),raw=JSON.parse(newFile)
  assert.equal(raw.schemaVersion,'hcd-word-device/6');assert.equal(raw.collaborationProtocol,wordLayoutProtocol)
  assert.equal((await readWordDeviceBackup(newFile,layoutSession,base)).sameScope,true);assert.equal((await readWordDeviceBackup(newFile,session,base)).sameScope,false);assert.equal((await readWordDeviceBackup(oldFile,layoutSession,base)).sameScope,false)
  await assert.rejects(wordDeviceBackup(layout,session),/scope/);await assert.rejects(wordDeviceBackup(legacy,layoutSession),/scope/)
  for(const patch of [{collaborationProtocol:wordRegionalProtocol},{collaborationProtocol:undefined}])await assert.rejects(readWordDeviceBackup(JSON.stringify({...raw,...patch}),layoutSession,base),/invalid/)
  const downgraded={...raw,schemaVersion:'hcd-word-device/5'};delete downgraded.collaborationProtocol
  assert.equal((await readWordDeviceBackup(JSON.stringify(downgraded),layoutSession,base)).sameScope,false)
  const copies=await listWordDeviceBackups(layoutSession,base,factory);assert.deepEqual(copies.copies.map(copy=>copy.name),[layout.name]);await assert.rejects(openWordDeviceCopy(layoutSession,base,{name:legacy.name,epoch:session.collaborationEpoch!},factory),/scope/)
  assert.deepEqual((await listWordDeviceBackups(session,base,factory)).copies.map(copy=>copy.name),[legacy.name])
 }finally{await legacy.close();await layout.close();oldDoc.destroy();newDoc.destroy()}
})
