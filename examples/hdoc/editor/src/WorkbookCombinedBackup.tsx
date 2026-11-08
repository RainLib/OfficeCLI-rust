import {useRef,useState} from 'react'
import type {Session} from './api.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {WorkbookBlankBatchClient} from './workbookBlankBatchClient.ts'
import {downloadNodeFile} from './downloadNodeFile.ts'
import {hasFixedWorkbookDraft,parseWorkbookCombinedBackup,stageWorkbookCombinedBackup,workbookCombinedBackupLimit} from './workbookCombinedBackup.ts'
import {useI18n} from './i18n.tsx'

/** Import stages separate review copies; it never submits them to the document. */
export function WorkbookCombinedBackup({session,source,batch,fixed,importFixed}:{session:Session;source:string;batch:WorkbookBlankBatchClient;fixed:()=>FixedDraftState;importFixed:(file:File,reopen?:boolean)=>Promise<boolean>}){
 const {t}=useI18n(),input=useRef<HTMLInputElement>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[existing,setExisting]=useState<File|null>(null)
 const download=async()=>{setBusy(true);setStatus('');try{const raw=await batch.combinedBackup(fixed);downloadNodeFile(`${session.documentId}.hcd-workbook-backup`,new Blob([raw],{type:'application/json'}));setStatus(t('workbookCombinedExported'))}catch(cause){setStatus(t(cause instanceof Error&&cause.message==='workbook-backup-input-active'?'workbookBackupFinishInput':'workbookCombinedExportFailed'))}finally{setBusy(false)}}
 const read=async(file:File,reopen=false)=>{setBusy(true);setStatus('');setExisting(null);let started=false,previous=false;try{
  if(!file.size||file.size>workbookCombinedBackupLimit)throw Error('invalid workbook backup')
  const bundle=parseWorkbookCombinedBackup(await file.text(),session,source,window.location.href)
  await stageWorkbookCombinedBackup(bundle,async raw=>{previous=!await importFixed(new File([raw],'fixed.hcd-draft',{type:'application/json'}),reopen)},raw=>batch.importBackup(new File([raw],'batch.hcd-batch-draft',{type:'application/json'})),()=>{started=true})
  setStatus(t(previous?(bundle.batches.length?'workbookCombinedExisting':'workbookCombinedFixedExisting'):hasFixedWorkbookDraft(bundle.fixed)?(bundle.batches.length?'workbookCombinedImported':'workbookCombinedFixedImported'):'workbookCombinedBatchImported'));if(previous)setExisting(file)
 }catch{setStatus(t(started?'workbookCombinedPartial':'workbookCombinedInvalid'))}finally{setBusy(false)}}
 return <span><button type="button" disabled={busy} onClick={()=>void download()}>{t('workbookCombinedDownload')}</button> <button type="button" disabled={busy} onClick={()=>input.current?.click()}>{t('workbookCombinedImport')}</button><input ref={input} hidden type="file" accept=".hcd-workbook-backup,application/json" onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void read(file)}}/>{status&&<span role="status"> {status}</span>}{existing&&<button type="button" disabled={busy} onClick={()=>void read(existing,true)}>{t('fixedImportReviewAgain')}</button>}</span>
}
