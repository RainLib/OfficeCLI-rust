/** Independent process verifies that a reopened pending checkpoint retains its
 * initiating identity and rejects another member before touching the server. */
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {dirname,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {saveStoppedWordDraft} from '../examples/hdoc/editor/src/wordStoppedSave.ts'
import {WordRoomLease,wordRecoveryStoreId} from '../examples/hdoc/editor/src/wordRoomLease.ts'

const [rootArg,api,mode]=process.argv.slice(2),secret=process.env.HCD_TOKEN_SECRET!,root=resolve(rootArg),allowed=resolve(dirname(fileURLToPath(import.meta.url)),'../target/layout-live-')
if(!root.startsWith(allowed)||!root.endsWith(`${sep}journal`)||Buffer.byteLength(secret)<32||!/^http:\/\/127\.0\.0\.1:\d+$/.test(api))throw Error('isolated fixture required')
const lineage=createHmac('sha256',secret).update(`word-room/1:${api}:region-test:0`).digest('hex').slice(0,32),journal=new WordCheckpointJournal(root,api,'region-test',0,lineage,secret,true)
const before=await journal.load();assert.ok(before?.capsule.pending);assert.deepEqual(before.capsule.pending.initiator,{userId:'alice',displayName:'Alice'})
let requests=0
await assert.rejects(saveStoppedWordDraft({journal,lease:{assert:()=>{},renew:async()=>{},recordJournal:async()=>{}},assertStopped:()=>{},initiator:{userId:'bob',displayName:'Bob'},request:async()=>{requests++;throw Error('unexpected network request')}}),/word-checkpoint-initiator-mismatch/)
assert.equal(requests,0);const after=await journal.load();assert.equal(after?.hash,before.hash);assert.deepEqual(after?.capsule.pending,before.capsule.pending)
if(mode==='recover'){
 const token=process.env.HCD_TEST_TOKEN;if(!token)throw Error('fixture token required')
 const common={'Authorization':`Bearer ${token}`,'X-HCD-Collaboration-Epoch':'0','X-HCD-Collaboration-Protocol':'hcd-word-regions/2','X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'}
 let lease:WordRoomLease
 const request=(route:string,init:RequestInit={})=>fetch(`${api}/v1/documents/region-test${route}`,{...init,headers:{...common,...init.headers,...(['word/checkpoints','word/checkpoint-receipt'].some(path=>route===`/${path}`)||route.startsWith('/editor')?lease.headers():{})}})
 const storeId=await wordRecoveryStoreId(root,api,secret),deadline=Date.now()+30000;let leaseRetries=0
 for(;;){lease=new WordRoomLease({epoch:0,storeId,journalHashes:journal.knownHashes(),request});try{await lease.acquire();break}catch(error){await lease.close();if(process.env.HCD_TEST_OWNER_EXPIRED_RETRY!=='1'||Date.now()>=deadline)throw error;leaseRetries++;await new Promise(resolve=>setTimeout(resolve,500))}}
 try{const result=await saveStoppedWordDraft({journal,lease,request,assertStopped:()=>{},initiator:{userId:'alice',displayName:'Alice'}});assert.equal(result.saved,true);const saved=await journal.load();assert.deepEqual(saved?.capsule.checkpointAcknowledgement?.request,before.capsule.pending.request);console.log(JSON.stringify({wrongMemberRejected:true,requests,tip:before.hash,checkpointId:before.capsule.pending.request.checkpointId,recovered:true,revision:result.revision,leaseRetries}))}finally{await lease.close()}
}else console.log(JSON.stringify({wrongMemberRejected:true,requests,tip:before.hash,checkpointId:before.capsule.pending.request.checkpointId}))
