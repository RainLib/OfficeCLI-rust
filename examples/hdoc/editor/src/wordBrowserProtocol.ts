/** Wire model declarations shared by regional browser transports. Selecting a
 * model here never migrates a document, a device journal or an existing room. */
import type {Session} from './api.ts'
import {nodeEditWireVersion,wordRegionalProtocol,wordLayoutProtocol} from './collaborationProtocol.ts'

export type WordBrowserProtocol=typeof wordRegionalProtocol|typeof wordLayoutProtocol
export function requireWordBrowserProtocol(protocol:Session['collaborationProtocol']):WordBrowserProtocol{
 if(protocol!==wordRegionalProtocol&&protocol!==wordLayoutProtocol)throw new Error('word-browser-protocol')
 return protocol
}
export function wordBrowserModelMatches(value:{wordRegionVersion?:unknown;wordLayoutVersion?:unknown;nodeEditVersion?:unknown},protocol:WordBrowserProtocol){
 return value.nodeEditVersion===nodeEditWireVersion&&(protocol===wordLayoutProtocol?value.wordRegionVersion===2&&value.wordLayoutVersion===1:value.wordRegionVersion===1&&value.wordLayoutVersion===undefined)
}
export function wordBrowserHeaders(session:Pick<Session,'collaborationProtocol'>){
 const protocol=requireWordBrowserProtocol(session.collaborationProtocol)
 return{'X-HCD-Node-Edits-Version':String(nodeEditWireVersion),'X-HCD-Word-Regions-Version':protocol===wordLayoutProtocol?'2':'1',...(protocol===wordLayoutProtocol?{'X-HCD-Word-Layout-Version':'1'}:{})}
}
export function wordBrowserConnection(session:Session){
 const protocol=requireWordBrowserProtocol(session.collaborationProtocol),epoch=session.collaborationEpoch
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(session.documentId)||!Number.isSafeInteger(epoch)||epoch!<0)throw new Error('word-browser-session')
 const url=new URL(session.collabUrl||'ws://127.0.0.1:8768')
 if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('word-browser-endpoint')
 url.searchParams.set('hcdNodeEdits',String(nodeEditWireVersion));url.searchParams.set('hcdWordRegions',protocol===wordLayoutProtocol?'2':'1')
 if(protocol===wordLayoutProtocol){url.searchParams.set('hcdWordLayout','1');url.searchParams.set('hcdWordTopology','1');url.searchParams.set('hcdWordStory','1');url.searchParams.set('hcdWordLink','1')}
 return{url:url.href,name:`${session.documentId}:${epoch}:${protocol===wordLayoutProtocol?'wordregions2:save6':'wordregions1:save5'}`,protocol}
}
