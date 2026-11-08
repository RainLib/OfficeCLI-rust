import {api,ApiError,type Session} from './api.ts'
import {sameGeometry,validGeometry,type PositionedImage} from './imageDrafts.ts'
import type {SharedImageDraft} from './collaborativeImages.ts'
type ImageField=SharedImageDraft['touched'][number]
export type RecoveryImageFieldComparison={field:ImageField;status:'draftOnly'|'savedOnly'|'sameResult'|'conflict'}
export type RecoveryImageBaseline={intentId:string;nodeId:string;revision:number;baseline:'verified'|'missing'|'mismatch';current:'unchanged'|'changed'|'deleted';saved:PositionedImage|null;fields:RecoveryImageFieldComparison[]|null}
export type RecoveryImageBaselineReport={headRevision:number;rootHash:string;items:RecoveryImageBaseline[]}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const same=(a:PositionedImage,b:PositionedImage)=>a.visualHash===b.visualHash&&(a.assetHash??null)===(b.assetHash??null)&&sameGeometry(a.geometry,b.geometry)
export function compareRecoveryImageFields(draft:SharedImageDraft,saved:PositionedImage):RecoveryImageFieldComparison[]|null{
 if(draft.base.geometry.unit!==saved.geometry.unit)return null
 const fields:ImageField[]=['x','y','width','height','assetHash']
 return fields.flatMap(field=>{
  const original=field==='assetHash'?draft.base.assetHash??null:draft.base.geometry[field]
  const latest=field==='assetHash'?saved.assetHash??null:saved.geometry[field]
  const desired=field==='assetHash'?draft.assetHash??original:draft.geometry[field]
  const local=draft.touched.includes(field)&&!Object.is(desired,original),remote=!Object.is(latest,original)
  if(!local&&!remote)return []
  return [{field,status:local&&remote?(Object.is(desired,latest)?'sameResult':'conflict'):local?'draftOnly':'savedOnly'}]
 })
}
function readHead(value:unknown){const head=value as {revision:number;rootHash:string};if(!head||!Number.isSafeInteger(head.revision)||head.revision<0||!hash(head.rootHash))throw Error('recoveryArchiveInvalid');return{revision:head.revision,rootHash:head.rootHash}}
function readImage(value:unknown,nodeId:string,revision:number){const result=value as {revision:number;image:PositionedImage|null};if(!result||result.revision!==revision||result.image===undefined)throw Error('recoveryArchiveInvalid');const image=result.image;if(image===null)return null
 if(image.nodeId!==nodeId||!hash(image.visualHash)||image.assetHash!=null&&!hash(image.assetHash)||!image.geometry||!['pt','emu'].includes(image.geometry.unit)||!validGeometry(image.geometry))throw Error('recoveryArchiveInvalid')
 return {nodeId:image.nodeId,visualHash:image.visualHash,...(image.assetHash?{assetHash:image.assetHash}:{}),geometry:{...image.geometry}} as PositionedImage
}
/** Pin the current head, compare historical baselines and fetch bounded batches.
 * Fail closed on a moving head or unauthorised/invalid responses. */
export async function compareRecoveryImageBaselines(session:Session,drafts:readonly SharedImageDraft[],signal:AbortSignal):Promise<RecoveryImageBaselineReport>{
 const head=readHead(await(await api(session,'',{signal})).json()),keys=new Map<string,{nodeId:string;revision:number;historical:boolean}>()
 for(const draft of drafts){keys.set(`${draft.base.nodeId}:${head.revision}`,{nodeId:draft.base.nodeId,revision:head.revision,historical:false});if(draft.revision<=head.revision){const key=`${draft.base.nodeId}:${draft.revision}`;if(!keys.has(key))keys.set(key,{nodeId:draft.base.nodeId,revision:draft.revision,historical:true})}}
 const result=new Map<string,PositionedImage|null>(),entries=[...keys.entries()]
 for(let offset=0;offset<entries.length;offset+=4){
  await Promise.all(entries.slice(offset,offset+4).map(async([key,item])=>{
   try{const response=await api(session,`/images/${encodeURIComponent(item.nodeId)}?revision=${item.revision}`,{signal});result.set(key,readImage(await response.json(),item.nodeId,item.revision))}
   catch(error){if(item.historical&&error instanceof ApiError&&error.status===404){result.set(key,null);return}throw error}
  }));signal.throwIfAborted()
 }
 const after=readHead(await(await api(session,'',{signal})).json());if(after.revision!==head.revision||after.rootHash!==head.rootHash)throw Error('recoveryArchiveChanged')
 const items=drafts.map(draft=>{const historic=draft.revision<=head.revision?result.get(`${draft.base.nodeId}:${draft.revision}`):null,saved=result.get(`${draft.base.nodeId}:${head.revision}`);if(saved===undefined)throw Error('recoveryArchiveInvalid');const verified=!!historic&&same(historic,draft.base);return{intentId:draft.intentId,nodeId:draft.base.nodeId,revision:draft.revision,baseline:!historic?'missing' as const:verified?'verified' as const:'mismatch' as const,current:!saved?'deleted' as const:same(saved,draft.base)?'unchanged' as const:'changed' as const,saved,fields:verified&&saved?compareRecoveryImageFields(draft,saved):null}})
 return{headRevision:head.revision,rootHash:head.rootHash,items}
}
