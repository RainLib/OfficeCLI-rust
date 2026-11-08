/** Coalesce document updates while the outline is visible. Closing the
 * outline cancels the pending read and detaches from the editor. */
export function watchSemanticOutline(source:{on:(event:'update',listener:()=>void)=>unknown;off:(event:'update',listener:()=>void)=>unknown},refresh:()=>void,schedule:(work:()=>void)=>number=requestAnimationFrame,cancel:(id:number)=>void=cancelAnimationFrame){
 let frame:number|undefined,closed=false
 const update=()=>{frame=undefined;if(!closed)refresh()}
 const request=()=>{if(!closed&&frame===undefined)frame=schedule(update)}
 source.on('update',request);request()
 return()=>{closed=true;source.off('update',request);if(frame!==undefined)cancel(frame)}
}
