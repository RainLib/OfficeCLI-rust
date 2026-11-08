import {test} from 'node:test'
import assert from 'node:assert/strict'
import {requireCollaborationAccess} from './collaborationAccess.ts'

const access={scope:'write',userId:'alice',displayName:'Alice',expiresAt:101,collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/1',coordinatedRestore:true}
test('collaboration authority rejects missing, malformed or expired limits and scopes',()=>{
 for(const expiresAt of [undefined,null,0,-1,100,NaN,Infinity,'101',101.5])assert.throws(()=>requireCollaborationAccess({...access,expiresAt},undefined,100_000),/invalid-collaboration-authority/)
 for(const scope of [undefined,'manage','',null])assert.throws(()=>requireCollaborationAccess({...access,scope},undefined,100_000),/invalid-collaboration-authority/)
 assert.equal(requireCollaborationAccess(access,undefined,100_000).userId,'alice')
 const anonymous=requireCollaborationAccess({...access,scope:'read',userId:null,displayName:null},undefined,100_000);assert.equal(anonymous.userId,undefined);assert.equal(anonymous.displayName,undefined)
 assert.throws(()=>requireCollaborationAccess({...access,coordinatedRestore:'true'},undefined,100_000))
})
test('layout-aware authorization remains explicit and isolated from legacy protocol parsing',()=>{
 const next={...access,collaborationProtocol:'hcd-word-regions/2'}
 assert.throws(()=>requireCollaborationAccess(next,undefined,100_000),/unsupported-collaboration-session/)
 assert.equal(requireCollaborationAccess(next,{wordLayoutV2:true},100_000).collaborationProtocol,'hcd-word-regions/2')
})
