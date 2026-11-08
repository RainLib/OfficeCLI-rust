import {useState} from 'react'
import {useI18n} from './i18n.tsx'
import type {FixedImageTasks} from './fixedImageTasks.ts'

export function FixedImageTasksView({tasks,reopen}:{tasks:FixedImageTasks|null;reopen:()=>void}){
 const {t}=useI18n(),[error,setError]=useState('')
 const act=(fn:()=>Promise<void>)=>{setError('');void fn().catch(cause=>setError(cause instanceof Error&&['fixed-image-choice-target-changed','fixed-image-choice-draft-conflict'].includes(cause.message)?t('wordUploadBaseChanged'):t('wordUploadUnknown')))}
 if(!tasks)return <div className="local-draft-warning" role="status">{t('wordUploadLoading')}</div>
 if(!tasks.pending&&!error)return null
 return <section className="local-draft-warning fixed-image-tasks" aria-label={t('wordUploadTasks')}>
  <strong>{t('wordUploadTasks')}</strong>{tasks.loading&&<span>{t('wordUploadLoading')}</span>}{tasks.problem&&<><span role="alert">{t('localDraftUnavailable')}</span><button onClick={reopen}>{t('localDraftRetry')}</button></>}
  {!tasks.canCoordinate&&tasks.choices.length>0&&<span role="alert">{t('fixedImageLocksUnavailable')}</span>}
  {tasks.choices.map(choice=><div key={choice.id}><span title={choice.base.nodeId}>{choice.name} · {choice.base.label||`${t('images')} #${choice.base.nodeId.slice(-6)}`} · {t('wordUploadInterrupted')}</span> <button disabled={tasks.working||!tasks.canCoordinate} onClick={()=>act(()=>tasks.resume(choice.id))}>{t('wordUploadResume')}</button> <button disabled={tasks.working} onClick={()=>act(()=>tasks.download(choice.id))}>{t('wordNodeResourceDownload')}</button> <button disabled={tasks.working||!tasks.canCoordinate} onClick={()=>act(()=>tasks.cancel(choice.id))}>{t('wordUploadCancel')}</button></div>)}
  {error&&<span role="alert">{error}</span>}
 </section>
}
