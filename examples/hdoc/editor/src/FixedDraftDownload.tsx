import {useState} from 'react'
import {useI18n} from './i18n.tsx'

export function FixedDraftDownload({download,disabled=false}:{download:()=>void|boolean;disabled?:boolean}){
 const {t}=useI18n(),[notice,setNotice]=useState(false)
 return <span><button type="button" disabled={disabled} onClick={()=>{setNotice(download()!==false)}}>{t('downloadDraft')}</button>{notice&&<span role="status"> {t('fixedBackupHint')}</span>}</span>
}
