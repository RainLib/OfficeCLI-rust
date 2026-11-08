/** Wait for a mounted regional editor to receive its collaborative projection.
 * The model remains the authority on whether the target still exists; the
 * editor can lag behind it while its region is mounting or synchronizing. */
export function waitForWordNode(options:{
 exists:()=>boolean
 locate:()=>boolean
 subscribe:(listener:()=>void)=>()=>void
 missing:()=>void
}){
 let stopped=false,checking=false
 let unsubscribe=()=>{}
 const stop=()=>{if(!stopped){stopped=true;unsubscribe()}}
 const check=()=>{
  if(stopped||checking)return
  checking=true
  try{
   if(!options.exists()){stop();options.missing();return}
   if(options.locate())stop()
  }finally{checking=false}
 }
 unsubscribe=options.subscribe(check)
 // A subscription is normally synchronous, but handle a synchronous callback
 // too so it cannot leave a listener behind after completion.
 if(stopped)unsubscribe();else check()
 return stop
}
