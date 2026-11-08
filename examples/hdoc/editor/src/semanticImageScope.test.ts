import {test} from 'node:test'
import assert from 'node:assert/strict'
import {semanticImageScopeMatches} from './semanticImageScope.ts'
import type {Session} from './api.ts'

test('image task authority follows document, member, endpoints, model and device journal',()=>{
 const session:Session={documentId:'doc',userId:'alice',scope:'write',format:'docx',token:'old',apiUrl:'/v1/documents',collabUrl:'ws://local',collaborationEpoch:2,collaborationProtocol:'hcd-semantic-blocks/3'},document={},localJournal={},bound={session,userId:'alice',document,localJournal}
 assert.equal(semanticImageScopeMatches(bound,{...bound,session:{...session,token:'refreshed',displayName:'Alice'}}),true)
 for(const change of [{documentId:'other'},{userId:'bob'},{apiUrl:'/other'},{collabUrl:'ws://other'},{collaborationEpoch:3},{collaborationProtocol:undefined},{flowLayoutVersion:2 as const},{format:'pdf'}])assert.equal(semanticImageScopeMatches(bound,{...bound,session:{...session,...change}}),false)
 for(const change of [{userId:'bob'},{document:{}},{localJournal:{}}])assert.equal(semanticImageScopeMatches(bound,{...bound,...change}),false)
})
