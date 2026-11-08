/** Recheck the same runtime after the asynchronous device read. A newer read
 * can publish a task while an older empty read is still in flight. */
export async function semanticImageTaskBlocked(state:{loading:boolean;problem:boolean;running:number;choices:readonly unknown[];alive:boolean},current:()=>boolean,read:()=>Promise<boolean>){
 if(!state.alive||state.loading||state.problem||state.running>0)return true
 try{const found=await read();return found||!current()||!state.alive||state.loading||state.problem||state.running>0||state.choices.length>0}catch{return true}
}
