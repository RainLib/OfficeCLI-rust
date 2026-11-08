import {useRef,useState} from 'react'
import {useI18n} from './i18n.tsx'

/** Import never replaces current work; reopening a retained copy is explicit. */
export function FixedDraftImport({importBackup}:{importBackup:(file:File,reopen?:boolean)=>Promise<boolean>}){
 const {t}=useI18n(),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[existing,setExisting]=useState<File|null>(null),input=useRef<HTMLInputElement>(null)
 const run=(file:File,reopen=false)=>{setBusy(true);setStatus('');setExisting(null);void importBackup(file,reopen).then(created=>{setStatus(t(created?'fixedImportReady':'fixedImportExisting'));if(!created)setExisting(file)},()=>setStatus(t('fixedImportInvalid'))).finally(()=>setBusy(false))}
 return <span><button type="button" disabled={busy} onClick={()=>input.current?.click()}>{t('fixedImportBackup')}</button><input ref={input} type="file" accept=".hcd-draft,application/json" hidden onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)run(file)}}/>{status&&<span role="status"> {status}</span>}{existing&&<button type="button" disabled={busy} onClick={()=>run(existing,true)}>{t('fixedImportReviewAgain')}</button>}</span>
}
