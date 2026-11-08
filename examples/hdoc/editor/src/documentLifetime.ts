import type {Doc} from 'yjs'
const references=new WeakMap<Doc,{count:number}>()
/** React effect replay retains the same owned document before this microtask.
 * Actual unmount still closes sockets/requests immediately and destroys the doc
 * after all editor/plugin cleanup has run. */
export function retainDocument(document:Doc){
 const entry=references.get(document)??{count:0};references.set(document,entry);entry.count++
 let retained=true
 return()=>{
  if(!retained)return;retained=false;entry.count--
  queueMicrotask(()=>{if(!entry.count&&references.get(document)===entry){references.delete(document);document.destroy()}})
 }
}
