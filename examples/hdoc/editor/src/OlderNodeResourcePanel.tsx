import {useEffect,useRef,useState} from 'react'
import type {Session} from './api.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import type {WordNodeResourceDraft} from './wordNodeResources.ts'
import {listOlderNodeResources,readOlderNodeResource,type OlderFileChoice} from './olderNodeResources.ts'
import {recoveryAuthority} from './semanticRecoveryTransfer.ts'
import {useI18n} from './i18n.tsx'
import {downloadNodeFile} from './downloadNodeFile.ts'

export function OlderNodeResourcePanel({session,userId,canImport,importFiles}:{session:Session;userId:string;canImport:()=>boolean;importFiles:(files:readonly WordNodeResourceDraft<ResourceNodePayload>[])=>Promise<number>}){
 const {t}=useI18n(),latest=useRef({session,userId,canImport,importFiles});latest.current={session,userId,canImport,importFiles}
 const [choices,setChoices]=useState<OlderFileChoice[]>([]),[busy,setBusy]=useState(false),[problem,setProblem]=useState(false),[done,setDone]=useState<'imported'|'existing'|null>(null),[generation,setGeneration]=useState(0)
 const run=useRef<AbortController|null>(null)
 useEffect(()=>{let alive=true;setBusy(true);setProblem(false);void listOlderNodeResources(session,userId,location.href).then(items=>{if(alive)setChoices(items)},()=>{if(alive)setProblem(true)}).finally(()=>{if(alive)setBusy(false)});return()=>{alive=false;run.current?.abort();run.current=null}},[session.documentId,session.apiUrl,session.collabUrl,session.collaborationEpoch,session.collaborationProtocol,userId,generation])
 async function copy(choice:OlderFileChoice){
  if(run.current||!latest.current.canImport())return
  const controller=new AbortController();run.current=controller;setBusy(true);setProblem(false);setDone(null)
  try{const value=latest.current,draft=await readOlderNodeResource(value.session,value.userId,location.href,choice);controller.signal.throwIfAborted();await recoveryAuthority(value.session,controller.signal,true);if(!latest.current.canImport())throw Error('recoveryArchiveReadOnly');const count=await value.importFiles([draft]);controller.signal.throwIfAborted();setDone(count?'imported':'existing')}catch{if(!controller.signal.aborted)setProblem(true)}finally{if(run.current===controller){run.current=null;setBusy(false)}}
 }
 async function download(choice:OlderFileChoice){
  if(run.current)return;const controller=new AbortController();run.current=controller;setBusy(true);setProblem(false)
  try{const value=latest.current,draft=await readOlderNodeResource(value.session,value.userId,location.href,choice);controller.signal.throwIfAborted();downloadNodeFile(draft.resource.name,new Blob([Uint8Array.from(draft.bytes)],{type:draft.resource.mediaType}))}catch{if(!controller.signal.aborted)setProblem(true)}finally{if(run.current===controller){run.current=null;setBusy(false)}}
 }
 return <section className="recovery-archive-panel" aria-label={t('olderFilesTitle')}><h3>{t('olderFilesTitle')}</h3><p>{t('olderFilesHint')}</p><button type="button" disabled={busy} onClick={()=>setGeneration(value=>value+1)}>{t('olderFilesRefresh')}</button>{!busy&&!problem&&!choices.length&&<p>{t('olderFilesEmpty')}</p>}{choices.map(choice=><div key={`${choice.epoch}:${choice.id}`}><span>{t('olderFilesItem',{epoch:choice.epoch,name:choice.name,target:choice.target})}</span> <button type="button" disabled={busy} onClick={()=>void download(choice)}>{t('wordNodeResourceDownload')}</button> <button type="button" disabled={busy||!canImport()} onClick={()=>void copy(choice)}>{t('olderFilesCopy')}</button></div>)}{problem&&<p role="alert">{t('olderFilesProblem')}</p>}{done&&<p role="status">{t(done==='imported'?'olderFilesDone':'olderFilesAlready')}</p>}</section>
}
