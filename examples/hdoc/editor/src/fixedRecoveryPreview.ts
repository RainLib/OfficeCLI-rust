import {api,ApiError,type Session} from './api.ts'
import {documentProblem,EditorDocumentError} from './documentProblems.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import {validGeometry,type PositionedImage} from './imageDrafts.ts'
import {validateBlankCreateAttempt} from './workbookBlankSave.ts'
import {validateWorkbookBlankInput} from './workbookBlankInput.ts'

export async function fixedRecoveryHead(session:Session,sourceHash:string,signal:AbortSignal,requireWrite=false){
 const [access,manifest]=await Promise.all([api(session,'/auth',{signal}).then(response=>response.json()),api(session,'',{signal}).then(response=>response.json())])
 if(!['read','write'].includes(access?.scope)||typeof access.userId!=='string'||!Number.isSafeInteger(manifest?.revision)||manifest.revision<0||manifest?.source?.sha256!==sourceHash)throw new EditorDocumentError(documentProblem('HCD-DOC-3001','recovery'))
 if(access.userId!==session.userId||requireWrite&&access.scope!=='write')throw new EditorDocumentError(documentProblem('HCD-DOC-1003','recovery'))
 return manifest.revision as number
}
export const fixedRecoveryPageSize=12
export const fixedRecoveryIds=(state:FixedDraftState)=>[...new Set([...state.texts.map(([id])=>id),...(state.attempt?.texts.map(([id])=>id)??[]),...(state.workbookBuffer?[state.workbookBuffer.base.nodeId]:[]),...(state.blankAttempt?.cells.map(cell=>cell.nodeId)??[]),...(state.blankInput?[state.blankInput.cell.nodeId]:[])])]
export const fixedRecoveryImageIds=(state:FixedDraftState)=>[...new Set([...state.images.map(([id])=>id),...(state.attempt?.images.map(([id])=>id)??[])])]
export const fixedRecoveryCount=(state:FixedDraftState)=>Math.max(fixedRecoveryIds(state).length,fixedRecoveryImageIds(state).length)
export async function fixedRecoveryPreview(session:Session,sourceHash:string,state:FixedDraftState,signal:AbortSignal,offset=0){
 if(state.blankAttempt)validateBlankCreateAttempt(state.blankAttempt,session,sourceHash)
 if(state.blankInput)validateWorkbookBlankInput(state.blankInput,session,sourceHash)
 const revision=await fixedRecoveryHead(session,sourceHash,signal)
 const all=fixedRecoveryIds(state),total=fixedRecoveryCount(state)
 if(!Number.isSafeInteger(offset)||offset<0||offset%fixedRecoveryPageSize!==0||offset>=Math.max(1,total))throw new Error('Invalid recovery page')
 const ids=all.slice(offset,offset+fixedRecoveryPageSize)
 const nodesPromise=Promise.all(ids.map(async id=>{
  try{const node=await(await api(session,`/text/${encodeURIComponent(id)}?revision=${revision}`,{signal})).json();if(node.nodeId!==id||typeof node.text!=='string'||node.revision!==revision||node.source!==undefined&&(!node.source||typeof node.source!=='object'||typeof node.source.editable!=='boolean'))throw new Error('Invalid recovery preview');return{id,text:node.text,deleted:false,editable:node.source?.editable??null}}
  catch(error){if(error instanceof ApiError&&error.status===404)return{id,text:'',deleted:true,editable:null};throw error}
 }))
 const imagesPromise=Promise.all(fixedRecoveryImageIds(state).slice(offset,offset+fixedRecoveryPageSize).map(async id=>{
  const result=await(await api(session,`/images/${encodeURIComponent(id)}?revision=${revision}`,{signal})).json() as {revision:number;image:PositionedImage|null}
  const image=result?.image
  if(result?.revision!==revision||image!==null&&(!image||image.nodeId!==id||typeof image.visualHash!=='string'||!/^[a-f0-9]{64}$/.test(image.visualHash)||!image.geometry||!['pt','emu'].includes(image.geometry.unit)||!validGeometry(image.geometry)||image.assetHash!=null&&!/^[a-f0-9]{64}$/.test(image.assetHash)))throw new Error('Invalid recovery image preview')
  return{id,image}
 }))
 const [nodes,images]=await Promise.all([nodesPromise,imagesPromise])
 return{revision,nodes,images,total,offset}
}
