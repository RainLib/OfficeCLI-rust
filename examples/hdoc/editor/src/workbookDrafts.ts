import type {HcdGridDraftPort} from '../../xlsx-univer-viewer/src/adapter.ts'
import {TextDraftStore} from './textDrafts.ts'

/** The adapter never owns pending workbook content. All cells, including
 * offscreen cells, use the same journaled store and save coordinator. */
export function workbookDraftPort(texts:TextDraftStore,writable:()=>boolean,batch:(work:()=>void)=>void=work=>work(),paintAllowed:()=>boolean=()=>true):HcdGridDraftPort{
 return {
  writable,
  text:link=>{
   // A recovered legacy draft may target a cell that is now protected. Do
   // not paint it as a string over the formula/locked cell in the grid; the
   // journal keeps it for explicit recovery and the server remains the guard.
   if(!link.editable)return undefined
   const draft=texts.get(link.nodeId)
   if(draft)return paintAllowed()?draft.text:undefined
   const confirmed=texts.currentRun(link,link.revision??0)
   return confirmed.text===link.text?undefined:confirmed.text
  },
  edit:(changes,revision)=>{
   if(!writable())throw new Error('readOnlyMode')
   if(!Number.isSafeInteger(revision)||revision<0||changes.length>4000||new Set(changes.map(({link})=>link.nodeId)).size!==changes.length)throw new Error('draftsNotReady')
   // Preflight the whole paste before mutating any cell's draft.
   for(const {link,text}of changes)if(!link.editable||!link.nodeId||!/^[a-f0-9]{64}$/.test(link.nodeHash)||typeof text!=='string'||text.length>1_000_000)throw new Error('draftsNotReady')
   let historyBytes=128
   for(const {link,text}of changes){const run=texts.currentRun(link,link.revision??revision),before={...run,text:texts.get(link.nodeId)?.text??run.text};historyBytes+=JSON.stringify({type:'text',before,after:{...run,text},revision,kind:'edit'}).length+1;if(historyBytes>4*1024*1024)throw new Error('workbookBatchTooLarge')}
   batch(()=>texts.batch(()=>{for(const {link,text}of changes)texts.edit(texts.currentRun(link,link.revision??revision),revision,text)}))
  },
 }
}
