import type {SharedImageDraft} from './collaborativeImages.ts'
import {validGeometry,type ImageField,type PositionedImage} from './imageDrafts.ts'
import {compareRecoveryImageFields,type RecoveryImageBaselineReport} from './recoveryImageBaselines.ts'
import {recoveryImageFieldValues} from './recoveryImageFieldValues.ts'
import {imageFileHash} from './imageFileIntegrity.ts'

export type RecoveryImageChoice=Partial<Record<ImageField,'draft'|'saved'>>
export type RecoveryImagePlan={nodeId:string;sourceIntentId:string;revision:number;rootHash:string;base:PositionedImage;geometry:PositionedImage['geometry'];assetHash?:string;assetBytes?:Uint8Array;changed:ImageField[]}

/** Prepare a proposed new intent only. The caller must recheck the pinned head,
 * room intents and authority, pin any asset, and explicitly commit the choice. */
export async function planRecoveryImage(draft:SharedImageDraft,report:RecoveryImageBaselineReport,current:readonly SharedImageDraft[],resources:ReadonlyMap<string,Uint8Array>,choices:RecoveryImageChoice):Promise<RecoveryImagePlan>{
 const fail=():never=>{throw Error('recovery-image-plan-invalid')}
 draft=structuredClone(draft);report=structuredClone(report);choices=structuredClone(choices)
 if(!Number.isSafeInteger(report.headRevision)||report.headRevision<draft.revision||!/^[a-f0-9]{64}$/.test(report.rootHash))fail()
 const matches=report.items.filter(item=>item.intentId===draft.intentId)
 if(matches.length!==1)fail()
 const item=matches[0],saved=item.saved
 if(item.nodeId!==draft.base.nodeId||item.revision!==draft.revision||item.baseline!=='verified'||item.current==='deleted'||!saved||saved.nodeId!==draft.base.nodeId||!validGeometry(saved.geometry))fail()
 if(current.some(entry=>entry.base.nodeId===draft.base.nodeId))throw Error('recovery-image-room-draft')
 const comparison=compareRecoveryImageFields(draft,saved!)
 if(!comparison)throw Error('recovery-image-plan-invalid')
 if(JSON.stringify(comparison)!==JSON.stringify(item.fields))fail()
 const conflicts=new Set(comparison.filter(item=>item.status==='conflict').map(item=>item.field))
 for(const [key,value] of Object.entries(choices)){if(!conflicts.has(key as ImageField)||!['draft','saved'].includes(value))fail()}
 for(const field of conflicts)if(!choices[field])throw Error('recovery-image-choice-required')
 const geometry={...saved!.geometry},changed:ImageField[]=[]
 let assetHash=saved!.assetHash
 for(const item of comparison){
  const chooseDraft=item.status==='draftOnly'||item.status==='conflict'&&choices[item.field]==='draft'
  if(!chooseDraft)continue
  const value=recoveryImageFieldValues(draft,saved!,item.field).draft
  if(item.field==='assetHash'){
   if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('recovery-image-plan-invalid')
   if(value!==assetHash){assetHash=value;changed.push(item.field)}
  }else{
   if(typeof value!=='number'||!Number.isFinite(value))throw Error('recovery-image-plan-invalid')
   if(!Object.is(geometry[item.field],value)){geometry[item.field]=value;changed.push(item.field)}
  }
 }
 if(!validGeometry(geometry))fail()
 let assetBytes:Uint8Array|undefined
 if(changed.includes('assetHash')){
  const data=assetHash?resources.get(assetHash):undefined
  if(!data||!data.length||data.length>8*1024*1024)throw Error('recovery-image-plan-invalid')
  assetBytes=Uint8Array.from(data);if(await imageFileHash(assetBytes)!==assetHash)throw Error('recovery-image-integrity')
 }
 return {nodeId:draft.base.nodeId,sourceIntentId:draft.intentId,revision:report.headRevision,rootHash:report.rootHash,base:structuredClone(saved!),geometry,...(assetBytes&&typeof assetHash==='string'?{assetHash,assetBytes}:{}),changed}
}
