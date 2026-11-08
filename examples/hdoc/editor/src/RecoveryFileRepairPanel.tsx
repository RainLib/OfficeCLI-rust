import {useEffect,useRef} from 'react'
import {useI18n} from './i18n.tsx'
import {downloadNodeFile} from './downloadNodeFile.ts'
import type {RecoveryFileRepair} from './recoveryFileRepair.ts'

export function RecoveryFileRepairPanel({plan,busy,canRepair,onApply,onCancel}:{plan:RecoveryFileRepair;busy:boolean;canRepair:boolean;onApply:()=>void;onCancel:()=>void}){
 const {t}=useI18n(),cancel=useRef<HTMLButtonElement>(null)
 useEffect(()=>{cancel.current?.focus({preventScroll:true})},[plan])
 return <section aria-label={t('recoveryFileRepairTitle')} className="recovery-file-repair"><h4>{t('recoveryFileRepairTitle')}</h4><p>{t('recoveryFileRepairHint')}</p><ul>{plan.items.map(item=><li key={item.original.id}><strong>{item.original.resource.name}</strong><p>{t('recoveryFileRepairHashes',{expected:item.replacement.resource.hash.slice(0,12),actual:item.actualHash.slice(0,12)})}</p><button type="button" disabled={busy} onClick={()=>downloadNodeFile(`${item.original.resource.name}.corrupt-copy`,new Blob([Uint8Array.from(item.original.bytes)],{type:'application/octet-stream'}))}>{t('recoveryFileRepairDownload')}</button></li>)}</ul><button type="button" disabled={busy||!canRepair} onClick={onApply}>{t('recoveryFileRepairApply')}</button> <button ref={cancel} type="button" disabled={busy} onClick={onCancel}>{t('cancel')}</button></section>
}
