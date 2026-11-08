import {test} from 'node:test'
import assert from 'node:assert/strict'
import {authorizeWordMember} from './wordMemberAuthority.ts'
import {parseCollaborationRoom} from './collaborationProtocol.ts'
import type {CollaborationAccess} from './collaborationAccess.ts'

const room=parseCollaborationRoom('doc:2:wordregions2:save6',{wordLayoutV2:true})
const member:CollaborationAccess={scope:'write',userId:'alice',displayName:'Alice',expiresAt:101,collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2'}
test('member authority binds current token, authenticated identity, session and lease',async()=>{
 let token:string|undefined='token-a',leased=true,reply=member
 const options={room,userId:'alice',displayName:'Alice',token:()=>token,access:async()=>reply,assertLease:()=>{if(!leased)throw Error('lease lost')},now:()=>100_000}
 assert.deepEqual(await authorizeWordMember(options),{token:'token-a',member:{userId:'alice',displayName:'Alice',scope:'write'}})
 for(const changed of [{...member,scope:'read' as const},{...member,userId:'bob'},{...member,displayName:'Changed'},{...member,collaborationEpoch:3},{...member,collaborationProtocol:'hcd-word-regions/1' as const},{...member,expiresAt:100}]){reply=changed;await assert.rejects(authorizeWordMember(options),/word-member-authority-changed/)}
 reply=member;token=undefined;await assert.rejects(authorizeWordMember(options),/word-member-authority-changed/)
 token='token-a';leased=false;await assert.rejects(authorizeWordMember(options),/lease lost/)
 leased=true;await assert.rejects(authorizeWordMember({...options,room:parseCollaborationRoom('fixed:doc:2')}),/word-member-authority-changed/)
})
test('authority does not release a stale token or lease after asynchronous access',async()=>{
 let token='old',leased=true,clock=100_000,resolve!:(value:CollaborationAccess)=>void
 const access=()=>new Promise<CollaborationAccess>(done=>resolve=done),options={room,userId:'alice',token:()=>token,access,assertLease:()=>{if(!leased)throw Error('lease lost')},now:()=>clock}
 const stale=authorizeWordMember(options);token='new';resolve(member);await assert.rejects(stale,/word-member-authority-changed/)
 const lost=authorizeWordMember(options);leased=false;resolve(member);await assert.rejects(lost,/lease lost/)
 leased=true;const expired=authorizeWordMember(options);clock=101_000;resolve(member);await assert.rejects(expired,/word-member-authority-changed/)
})
test('authority rejects a room changed during asynchronous authorization',async()=>{
 for(const change of [(value:typeof room)=>{value.documentId='other'},(value:typeof room)=>{value.epoch=3},(value:typeof room)=>{value.protocol='hcd-word-regions/1'},(value:typeof room)=>{value.fixed=true}]){
  const selected={...room};let resolve!:(value:CollaborationAccess)=>void
  const pending=authorizeWordMember({room:selected,userId:'alice',token:()=> 'token',access:()=>new Promise(done=>resolve=done),assertLease:()=>{},now:()=>100_000})
  change(selected);resolve(member);await assert.rejects(pending,/word-member-authority-changed/)
 }
})
