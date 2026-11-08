import {useEffect,useMemo,useState} from 'react'
import type * as Y from 'yjs'
import {referenceEditIndex,referenceEditField} from './referenceEdits.ts'
export function useReferenceEdits(document:Y.Doc){
 const [version,setVersion]=useState(0)
 useEffect(()=>{const map=document.getMap(referenceEditField),update=()=>setVersion(value=>value+1);map.observe(update);update();return()=>map.unobserve(update)},[document])
 return useMemo(()=>referenceEditIndex(document),[document,version])
}
