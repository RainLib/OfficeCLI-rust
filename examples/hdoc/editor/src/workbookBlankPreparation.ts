import type {Session} from './api.ts'
import {inspectWorkbookBlanks,type BlankObservation,type BlankTarget} from './workbookBlankInspection.ts'

type Inspection=typeof inspectWorkbookBlanks
type Prepared={revision:number;rootHash:string;sourceHash:string;cell:BlankObservation}
const same=(a:BlankTarget,b:BlankTarget)=>a.sheetId===b.sheetId&&a.row===b.row&&a.column===b.column

/** A selection is only an observation, never permission to create. Late
 * responses cannot authorize a new selection, revision or editor session. */
export class WorkbookBlankPreparation{
 private generation=0
 private abort:AbortController|null=null
 private value:Prepared|null=null
 private disposed=false
 constructor(private session:Session,private sourceHash:string,private inspect:Inspection=inspectWorkbookBlanks){}
 clear(){this.generation++;this.abort?.abort();this.abort=null;this.value=null}
 dispose(){this.disposed=true;this.clear()}
 prepared(target:BlankTarget,revision:number,rootHash:string):BlankObservation|null{
  const value=this.value
  if(this.disposed||!value||value.revision!==revision||value.rootHash!==rootHash||value.sourceHash!==this.sourceHash||!same(value.cell,target))return null
  return structuredClone(value.cell)
 }
 async prepare(target:BlankTarget,revision:number,rootHash:string,stillAllowed:()=>boolean):Promise<boolean>{
  if(this.disposed)return false
  if(this.prepared(target,revision,rootHash)&&stillAllowed())return true
  this.clear();const generation=this.generation,abort=new AbortController();this.abort=abort
  const immutable=structuredClone(target)
  try{
   if(!stillAllowed())return false
   const result=await this.inspect(this.session,revision,this.sourceHash,[immutable],abort.signal)
   if(this.disposed||abort.signal.aborted||generation!==this.generation||!stillAllowed()||result.revision!==revision||result.rootHash!==rootHash||result.cells.length!==1||!same(result.cells[0],immutable))return false
   this.value={revision,rootHash,sourceHash:this.sourceHash,cell:structuredClone(result.cells[0])}
   return true
  }catch(error){
   if(this.disposed||abort.signal.aborted||generation!==this.generation)return false
   throw error
  }finally{if(this.abort===abort)this.abort=null}
 }
}
