/** Recheck immediately before closing, including work started during flush.
 * A failed flush may leave an old request or draft in device storage. */
export async function closeFixedIfSettled(blocked:()=>boolean,flush:()=>Promise<unknown>,close:()=>void):Promise<'closed'|'blocked'|'flush-failed'>{
 if(blocked())return 'blocked'
 try{await flush()}catch{return blocked()?'blocked':'flush-failed'}
 if(blocked())return 'blocked'
 close()
 return 'closed'
}
