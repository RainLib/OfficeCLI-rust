import {useEffect,useState} from 'react'
import {recoveryImageFile} from './recoveryImageFile.ts'
import {recoveryImageAssets} from './recoveryImageAssets.ts'
import {recoveryImageFieldValues} from './recoveryImageFieldValues.ts'
import {downloadNodeFile} from './downloadNodeFile.ts'
import {compareRecoveryImagePeers} from './recoveryImagePeers.ts'
import type {RecoveryImageBaselineReport} from './recoveryImageBaselines.ts'
import type {RecoveryImageChoice} from './recoveryImagePlan.ts'
import {ImageCandidatePreview} from './ImagePanel.tsx'
import type {Session} from './api.ts'
import type {SharedImageDraft} from './collaborativeImages.ts'
import {useI18n,type MessageKey} from './i18n.tsx'

/** This compares private packet drafts with the current room's unsaved
 * drafts and separately reports a pinned saved-image baseline. */
export function RecoveryImageDraftReview({current,recovered,resources,session,baselines,onRecover,canRecover=false,busy=false}:{current:SharedImageDraft[];recovered:SharedImageDraft[];resources:Map<string,Uint8Array>;session?:Session;baselines:RecoveryImageBaselineReport|null;onRecover?:(intentId:string,choices:RecoveryImageChoice)=>void;canRecover?:boolean;busy?:boolean}){
 const {t}=useI18n(),[limit,setLimit]=useState(20),[choices,setChoices]=useState<Record<string,RecoveryImageChoice>>({})
 const fields:Record<string,MessageKey>={x:'x',y:'y',width:'width',height:'height',assetHash:'imageResourceField'}
 const list=(values:SharedImageDraft[],packet:boolean)=>values.length?<>{values.slice(0,limit).map(draft=>{
  const hash=draft.assetHash??draft.base.assetHash,assets=packet?recoveryImageAssets(draft,resources):[],baseline=packet?baselines?.items.find(item=>item.intentId===draft.intentId):undefined,peers=packet?compareRecoveryImagePeers(draft,current):[]
  const selection=choices[draft.intentId]??{},blocked=current.some(entry=>entry.base.nodeId===draft.base.nodeId),conflicts=baseline?.fields?.filter(item=>item.status==='conflict')??[]
  return <article key={draft.intentId}><strong title={draft.base.nodeId}>{t('recoveryImageObject',{id:draft.base.nodeId.slice(-8)})}</strong> <code title={draft.intentId}>{draft.intentId.slice(0,8)}</code><p>{t('recoveryImageBaseRevision',{revision:draft.revision})} · {t('recoveryImageChangedFields')}: {draft.touched.map(field=>t(fields[field])).join(' · ')||'—'}</p><p>{(['x','y','width','height'] as const).map(key=>`${t(key)}: ${String(draft.geometry[key])}`).join(' · ')} {draft.geometry.unit}</p>{packet&&<div>{peers.length?peers.map(peer=><p key={peer.intentId} role={peer.status==='conflict'||peer.status==='unverified'?'alert':undefined}><code title={peer.intentId}>{peer.intentId.slice(0,8)}</code> · {t(peer.status==='sameIntent'?'recoveryImagePeerSame':peer.status==='compatible'?'recoveryImagePeerCompatible':peer.status==='conflict'?'recoveryImagePeerConflict':'recoveryImagePeerUnverified',{fields:peer.conflicts.map(field=>t(fields[field])).join(' · ')})}</p>):<p>{t('recoveryImagePeerNone')}</p>}</div>}{baseline&&<div className="recovery-image-baseline"><p role={baseline.baseline==='verified'?'status':'alert'}>{t(baseline.baseline==='verified'?'recoveryImageBaselineVerified':baseline.baseline==='missing'?'recoveryImageBaselineMissing':'recoveryImageBaselineMismatch')}</p><p>{t(baseline.current==='unchanged'?'recoveryImageSavedUnchanged':baseline.current==='changed'?'recoveryImageSavedChanged':'recoveryImageSavedDeleted',{revision:baselines!.headRevision})}</p>{baseline.fields&&<><p>{t('recoveryImageFieldHint')}</p><ul>{baseline.fields.map(item=><li key={item.field}>{t(fields[item.field])}: {t(item.status==='draftOnly'?'recoveryImageFieldDraftOnly':item.status==='savedOnly'?'recoveryImageFieldSavedOnly':item.status==='sameResult'?'recoveryImageFieldSameResult':'recoveryImageFieldConflict')}{baseline.saved&&<RecoveryImageFieldValues draft={draft} saved={baseline.saved} field={item.field}/>}{item.status==='conflict'&&onRecover&&<fieldset disabled={busy}><legend>{t(fields[item.field])}</legend>{(['draft','saved'] as const).map(choice=><label key={choice}><input type="radio" name={`recovery-${draft.intentId}-${item.field}`} checked={selection[item.field]===choice} onChange={()=>setChoices(previous=>({...previous,[draft.intentId]:{...previous[draft.intentId],[item.field]:choice}}))}/>{t(choice==='draft'?'recoveryImageUseDraft':'recoveryImageUseSaved')}</label>)}</fieldset>}</li>)}</ul></>}{baseline.saved&&<><p>{(['x','y','width','height'] as const).map(key=>`${t(key)}: ${String(baseline.saved!.geometry[key])}`).join(' · ')} {baseline.saved.geometry.unit}</p>{baseline.saved.assetHash&&session&&<ImageCandidatePreview session={session} assetHash={baseline.saved.assetHash}/>}</>}</div>}{packet&&onRecover&&<div><p>{t('recoveryImageActionHint')}</p>{blocked&&<p role="status">{t('recoveryImageRoomBlocked')}</p>}<button type="button" disabled={busy||!canRecover||blocked||baseline?.baseline!=='verified'||baseline.current==='deleted'||!baseline.fields||conflicts.some(item=>!selection[item.field])} onClick={()=>onRecover(draft.intentId,selection)}>{t('recoveryImageRestoreDraft')}</button></div>}{packet?assets.map(asset=><div key={asset.hash}><p>{t(asset.kind==='original'?'recoveryImageArchivedOriginal':'recoveryImageArchivedReplacement')}</p><code title={asset.hash}>{asset.hash.slice(0,16)}…</code><RecoveryImagePreview bytes={asset.bytes}/><RecoveryImageDownload hash={asset.hash} bytes={asset.bytes} kind={asset.kind}/></div>):hash&&<><code title={hash}>{hash.slice(0,16)}…</code>{session&&<ImageCandidatePreview session={session} assetHash={hash}/>}</>}</article>
 })}{values.length>limit&&<button type="button" onClick={()=>setLimit(n=>n+20)}>{t('recoveryImageShowMore')}</button>}</>:<p>{t('recoveryImageNoDrafts')}</p>
 return <section className="recovery-image-review"><h4>{t('recoveryImageDraftsTitle')}</h4><p>{t('recoveryImageDraftsHint')}</p><div className="recovery-archive-compare"><section><h4>{t('recoveryImageCurrentDrafts',{count:current.length})}</h4>{list(current,false)}</section><section><h4>{t('recoveryImagePacketDrafts',{count:recovered.length})}</h4>{list(recovered,true)}</section></div></section>
}
function RecoveryImageFieldValues({draft,saved,field}:{draft:SharedImageDraft;saved:import('./imageDrafts.ts').PositionedImage;field:import('./imageDrafts.ts').ImageField}){
 const {t}=useI18n(),values=recoveryImageFieldValues(draft,saved,field)
 const format=(value:string|number|null)=>value===null?'—':field==='assetHash'&&typeof value==='string'?`${value.slice(0,12)}…`:String(value)
 return <div className="recovery-image-field-values">{(['base','draft','saved'] as const).map(key=><span key={key}>{t(key==='base'?'recoveryImageValueBase':key==='draft'?'recoveryImageValueDraft':'recoveryImageValueSaved')}: <code title={String(values[key]??'')}>{format(values[key])}</code></span>)}</div>
}
function RecoveryImagePreview({bytes}:{bytes:Uint8Array}){
 const {t}=useI18n(),[url,setUrl]=useState('')
 useEffect(()=>{const url=URL.createObjectURL(new Blob([Uint8Array.from(bytes)]));setUrl(url);return()=>URL.revokeObjectURL(url)},[bytes])
 return url?<img className="presentation-image-preview" src={url} alt={t('imagePreview')}/>:null
}

function RecoveryImageDownload({hash,bytes,kind}:{hash:string;bytes:Uint8Array;kind:'original'|'replacement'}){
 const {t}=useI18n(),[busy,setBusy]=useState(false),[error,setError]=useState(false)
 const download=async()=>{setBusy(true);setError(false);try{const file=await recoveryImageFile(hash,bytes);downloadNodeFile(file.name,file.blob)}catch{setError(true)}finally{setBusy(false)}}
 return <div><button type="button" disabled={busy} onClick={()=>void download()}>{t(kind==='original'?'recoveryImageDownloadOriginal':'recoveryImageDownloadReplacement')}</button>{error&&<p role="alert">{t('recoveryImageDownloadError')}</p>}</div>
}
