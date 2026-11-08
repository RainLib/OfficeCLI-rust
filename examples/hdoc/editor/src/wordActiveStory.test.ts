import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WordActiveStory,readActiveStoryPending} from './wordActiveStory.ts'
import type {WordActiveTopologyContext} from './wordActiveTopology.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,member={userId:'alice',displayName:'Alice 王',scope:'write' as const},nonce='d'.repeat(32)
function pending(){return{actor:{userId:member.userId,displayName:member.displayName,generation:1},request:{documentId:'doc',transactionId:nonce,expectedRevision:1,baseLayoutHash:'a'.repeat(64),candidateHash:'b'.repeat(64),actor:{userId:member.userId,displayName:member.displayName}},intent:{sectionId:id(1),kind:'footer' as const,variant:'even' as const,expectedInheritedStoryId:null},story:{id:`n_${nonce}`,kind:'footer' as const,sourcePart:`word/hcd-${nonce}.xml`},blocks:[{flowRegionId:`n_${nonce}`,region:'footer',readOnly:false,blockId:id(10),blockHash:'c'.repeat(64),content:{kind:'paragraph',inlines:[{text:'Copied text',nodeId:id(11)}]}}],copyChoices:{referenceIds:[],extensions:[]}}}
test('story parsing pins actor, deterministic destination and bounded full candidate identity',()=>{
 const p=pending(),parsed=readActiveStoryPending(p,'doc',member)
 const reordered=JSON.parse(JSON.stringify(p,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v));assert.deepEqual(readActiveStoryPending(reordered,'doc',member),parsed)
 assert.throws(()=>readActiveStoryPending(p,'other',member),/invalid/);assert.throws(()=>readActiveStoryPending(p,'doc',{...member,scope:'read'}),/unauthorized/)
 for(const change of [(v:any)=>{v.request.actor.userId='bob'},(v:any)=>{v.story.id=id(99)},(v:any)=>{v.blocks[0].flowRegionId=id(1)},(v:any)=>{v.copyChoices.extensions=[{}]},(v:any)=>{v.blocks[0].content.inlines[0].text='x'.repeat(901*1024)}]){const v=structuredClone(p);change(v);assert.throws(()=>readActiveStoryPending(v,'doc',member))}
})
test('story retries retain their stage and original review identity separately from layout status',async()=>{
 const active=new WordActiveStory(),p={...readActiveStoryPending(pending(),'doc',member),reviewHash:'e'.repeat(64)},calls:string[]=[];let held=false,installs=0
 const context:WordActiveTopologyContext={held:()=>held,prepare:async()=>{calls.push('prepare')},transition:async()=>{held=true;calls.push('native')},promote:async()=>{calls.push('promote')},retire:async()=>{calls.push('retire')},isRetired:()=>calls.includes('retire'),install:async()=>{if(++installs===1)throw Error('install-response-unknown');held=false},activate:()=>{calls.push('activate')},release:()=>{calls.push('release')}}
 await assert.rejects(active.run(p,async()=>member,()=>context,1),/install-response-unknown/)
 assert.equal(active.status('doc',1,nonce).schemaVersion,'hcd-word-active-story-status/1');assert.equal(active.status('doc',1,nonce).status,'pending')
 const result=await active.run(p,async()=>member,()=>context,1);assert.equal(result.revision,2);assert.equal(calls.filter(v=>v==='native').length,1);assert.equal(calls.filter(v=>v==='prepare').length,1)
 assert.deepEqual(await active.run(p,async()=>member,()=>context,1),result)
 await assert.rejects(active.run({...p,reviewHash:'f'.repeat(64)},async()=>member,()=>context,1),/request-changed/)
 await assert.rejects(active.run(p,async()=>({...member,scope:'read'}),()=>context,1),/unauthorized/)
 assert.equal(active.status('doc',2,nonce).status,'recovery-required')
})
