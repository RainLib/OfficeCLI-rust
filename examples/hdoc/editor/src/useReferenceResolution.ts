import {useEffect,useRef,useState} from 'react'
import {api,type Session} from './api.ts'
import {readReferenceResolutions,referenceTargetKey,type ReferenceResolution,type ReferenceTarget} from './referenceIndex.ts'
/** Per-view results are scoped to identity and exact target set. Closing,
 * hiding or losing authority aborts requests and discards current directory data. */
export function useReferenceResolution(session:Session,targets:ReferenceTarget[],enabled=true){
 const unique=[...new Map(targets.map(target=>[referenceTargetKey(target),target])).values()],key=JSON.stringify(unique),scope=JSON.stringify([session.documentId,session.token,session.apiUrl,key]),[attempt,setAttempt]=useState(0),[visible,setVisible]=useState(()=>!document.hidden)
 const [result,setResult]=useState<{scope:string;status:'loading'|'ready'|'unavailable';items:ReferenceResolution[]}|null>(null)
 const latest=useRef({session,unique});latest.current={session,unique}
 useEffect(()=>{if(!enabled)return;const refresh=()=>{setVisible(!document.hidden);if(!document.hidden)setAttempt(n=>n+1)};document.addEventListener('visibilitychange',refresh);window.addEventListener('focus',refresh);const timer=setInterval(()=>{if(!document.hidden)setAttempt(n=>n+1)},30000);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('focus',refresh)}},[enabled])
 useEffect(()=>{
  if(!enabled||!visible){setResult(null);return}
  const {session,unique}=latest.current,controller=new AbortController();let alive=true,timedOut=false
  if(!unique.length){setResult({scope,status:'ready',items:[]});return}
  if(unique.length>100){setResult({scope,status:'unavailable',items:[]});return}
  setResult({scope,status:'loading',items:[]})
  const timeout=setTimeout(()=>{timedOut=true;controller.abort()},15000)
  void api(session,'/references/resolve',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({targets:unique}),signal:controller.signal}).then(response=>response.json()).then(value=>{const items=readReferenceResolutions(value,unique);if(alive&&!controller.signal.aborted)setResult({scope,status:'ready',items})}).catch(()=>{if(alive&&(!controller.signal.aborted||timedOut))setResult({scope,status:'unavailable',items:[]})}).finally(()=>clearTimeout(timeout))
  return()=>{alive=false;clearTimeout(timeout);controller.abort()}
 },[scope,enabled,visible,attempt])
 const current=enabled&&visible&&result?.scope===scope?result:null
 return{status:current?.status??'loading',items:new Map((current?.items??[]).map(item=>[referenceTargetKey(item.target),item])),refresh:()=>setAttempt(n=>n+1)}
}
