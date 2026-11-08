import {awaitRecoveryPreparation} from './boundedResponse.ts'

/** A delayed device read or lock callback must not start recovery after the
 * editor has closed or its bounded recovery session has expired. */
export async function withWorkbookStartupRecovery<T>(options:{signal:AbortSignal;start:()=>Promise<void>;ready:()=>boolean;hasLocks:boolean;locked:(work:(hasPending:boolean)=>Promise<T>)=>Promise<T>;defer:()=>Promise<T>;recover:()=>Promise<T>;dispose:()=>void}):Promise<T>{
 const {signal}=options
 try{
  await awaitRecoveryPreparation(options.start,signal);signal.throwIfAborted()
  if(!options.ready())throw new Error('blank batch unavailable')
  if(!options.hasLocks)return await awaitRecoveryPreparation(options.defer,signal)
  return await awaitRecoveryPreparation(()=>options.locked(async hasPending=>{signal.throwIfAborted();return hasPending?options.defer():options.recover()}),signal)
 }finally{options.dispose()}
}
