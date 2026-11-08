import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import type {Session} from './api.ts'
import type {WordDeviceDraft} from './wordDeviceDraft.ts'
import {WordDeviceDownload} from './wordDeviceDownload.ts'
import {useI18n} from './i18n.tsx'

export function WordDeviceDownloadButton({cache,session}:{cache:WordDeviceDraft;session:Session}){
 const [operation,setOperation]=useState<WordDeviceDownload|null>(null),{t}=useI18n(),bound=useRef({cache,session});bound.current={cache,session}
 useEffect(()=>{const current=new WordDeviceDownload(cache,session,undefined,()=>bound.current.cache===cache&&bound.current.session===session);setOperation(current);return()=>current.dispose()},[cache,session])
 return operation?.cache===cache&&operation.session===session?<WordDeviceDownloadStatus operation={operation}/>:<button type="button" disabled>{t('downloadDraft')}</button>
}
export function WordDeviceDownloadStatus({operation}:{operation:WordDeviceDownload}){
 const {t}=useI18n(),state=useSyncExternalStore(operation.subscribe,operation.snapshot,operation.snapshot)
 const code=state.error==='limit'?'HCD-BACKUP-1003':state.error==='changed'?'HCD-BACKUP-1002':'HCD-BACKUP-1001'
 return <span className="word-device-download"><button type="button" aria-busy={state.phase==='preparing'} disabled={state.phase==='preparing'} onClick={()=>void operation.run()}>{t(state.phase==='preparing'?'wordDeviceBackupPreparing':'downloadDraft')}</button>{state.phase==='requested'&&<span role="status">{t('wordDeviceBackupRequested')}<button type="button" aria-label={t('wordDeviceBackupDismiss')} onClick={operation.dismiss}>×</button></span>}{state.phase==='failed'&&<span role="alert"><code>{code}</code> {t(state.error==='limit'?'wordDeviceBackupLimit':state.error==='changed'?'wordDeviceBackupChanged':'wordDeviceBackupFailed')}<button type="button" aria-label={t('wordDeviceBackupDismiss')} onClick={operation.dismiss}>×</button></span>}</span>
}
