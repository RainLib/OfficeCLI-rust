import {nodeEditWireVersion,wordRegionalProtocol,wordLayoutProtocol,type CollaborationProtocol} from './collaborationProtocol.ts'
import type {WordSaveStatus} from './wordSaveCoordinator.ts'

export type WordRoomProtocol=typeof wordRegionalProtocol|typeof wordLayoutProtocol
export function isWordRoomProtocol(value:CollaborationProtocol):value is WordRoomProtocol{return value===wordRegionalProtocol||value===wordLayoutProtocol}
/** A second explicit host switch is required; enabling older regional rooms
 * never silently starts a layout-aware save owner. */
export function wordLayoutHostEnabled(env:Readonly<Record<string,string|undefined>>){return env.HCD_WORD_ROOMS==='1'&&env.HCD_WORD_LAYOUT_ROOMS==='1'}
export function wordRoomStatus(state:WordSaveStatus,protocol:WordRoomProtocol){return{type:'hcd-save-status' as const,nodeEditVersion:nodeEditWireVersion,wordRegionVersion:protocol===wordLayoutProtocol?2 as const:1 as const,...(protocol===wordLayoutProtocol?{wordLayoutVersion:1 as const}:{}),...state}}

/** HTTP uploads/recovery must make the same explicit model acknowledgement
 * as the socket. Header arrays or joined duplicate values never count. */
export function requireWordHttpModel(protocol:CollaborationProtocol,headers:Readonly<Record<string,unknown>>,layoutEnabled=false):WordRoomProtocol{
 if(protocol===wordRegionalProtocol){
  if(headers['x-hcd-word-regions-version']!==undefined&&headers['x-hcd-word-regions-version']!=='1'||headers['x-hcd-word-layout-version']!==undefined)throw new Error('word-room-client-upgrade-required')
  return protocol
 }
 if(protocol!==wordLayoutProtocol||!layoutEnabled)throw new Error('word-room-disabled')
 if(headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion)||headers['x-hcd-word-regions-version']!=='2'||headers['x-hcd-word-layout-version']!=='1')throw new Error('word-room-client-upgrade-required')
 return protocol
}
