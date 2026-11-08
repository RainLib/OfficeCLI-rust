/** Serialize device file publication and user actions across same-origin
 * windows that share this device journal. Older browsers retain the existing
 * explicit rechecks when Web Locks is unavailable. */
export async function withDeviceFileLock<T>(journalName:string,work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
 signal?.throwIfAborted()
 const locks=typeof navigator==='undefined'?undefined:navigator.locks
 if(!locks)return work()
 if(signal)return locks.request(`${journalName}-file-boundary-v1`,{signal},()=>work())
 return locks.request(`${journalName}-file-boundary-v1`,()=>work())
}

export const withRegionalFileLock=withDeviceFileLock

/** Recheck device choices at action boundaries: notifications are advisory. */
export async function regionalFileBoundary(options:{nodeFiles:()=>Promise<boolean>;uploads:()=>Promise<boolean>;resourcesBusy:()=>boolean;uploadsBusy:()=>boolean;imagesBusy:()=>boolean}){
 const [nodeFiles,uploads]=await Promise.all([options.nodeFiles(),options.uploads()])
 if(nodeFiles||options.resourcesBusy())throw new Error('node-resource-pending')
 if(uploads||options.uploadsBusy())throw new Error('word-upload-pending')
 if(options.imagesBusy())throw new Error('word-browser-upload-pending')
}
