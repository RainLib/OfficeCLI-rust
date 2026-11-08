import {useEffect,useMemo,useState} from 'react'
import type {Session} from './api.ts'
import type {FixedPeer} from './FixedPresence.tsx'
import {fixedActivityKey,readFixedActivity} from './fixedActivity.ts'
export function useFixedActivity(session:Session,peers:readonly FixedPeer[],revision:number|null,enabled:boolean){
 const cache=useMemo(()=>new Map<string,string>(),[session.documentId,session.apiUrl,session.token])
 const [snapshot,setSnapshot]=useState<{scope:Map<string,string>;values:Record<string,string>}>({scope:cache,values:{}})
 const ids=JSON.stringify([...new Set(peers.filter(peer=>peer.selection?.kind==='text'&&(peer.viewport?.revision===undefined||peer.viewport.revision===revision)).map(peer=>peer.selection!.nodeId).filter(id=>/^n_[a-f0-9]{32}$/.test(id)))].slice(0,64).sort())
 useEffect(()=>{
  const controller=new AbortController()
  if(!enabled||revision===null){setSnapshot({scope:cache,values:{}});return}
  const targets=JSON.parse(ids) as string[],ready:Record<string,string>={}
  for(const id of targets){const key=fixedActivityKey(revision,id);if(cache.has(key))ready[key]=cache.get(key)!}setSnapshot({scope:cache,values:ready})
  const pending=targets.filter(id=>!cache.has(fixedActivityKey(revision,id)))
  const run=async()=>{for(let at=0;at<pending.length&&!controller.signal.aborted;at+=2)await Promise.all(pending.slice(at,at+2).map(async id=>{
   try{const text=await readFixedActivity(session,revision,id,controller.signal);if(controller.signal.aborted)return;const key=fixedActivityKey(revision,id);cache.set(key,text);if(cache.size>32)cache.delete(cache.keys().next().value!);setSnapshot(previous=>({scope:cache,values:{...(previous.scope===cache?previous.values:{}),[key]:text}}))}catch{/* Presence lookup failure cannot interrupt document editing. */}
  }))};void run();return()=>controller.abort()
 },[enabled,revision,ids,session.documentId,session.apiUrl,session.token,cache])
 return enabled&&snapshot.scope===cache?snapshot.values:{}
}
