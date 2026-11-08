export const fixedViewportField='hcdFixedViewport'
export type FixedViewport={version:1;page:number;pageNumber:number;x:number;y:number;following?:number;revision?:number;wordPage?:number;wordSection?:number}
/** Ephemeral awareness only. Never apply a peer's selection or document data. */
export function readFixedViewport(input:unknown):FixedViewport|null{
 if(!input||typeof input!=='object')return null
 const value=input as FixedViewport
 if(value.version!==1||!Number.isSafeInteger(value.page)||value.page<0||!Number.isSafeInteger(value.pageNumber)||value.pageNumber<1)return null
 if(![value.x,value.y].every(position=>typeof position==='number'&&Number.isFinite(position)&&position>=0&&position<=1))return null
 if(value.revision!==undefined&&(!Number.isSafeInteger(value.revision)||value.revision<0))return null
 if(value.wordPage!==undefined&&(!Number.isSafeInteger(value.wordPage)||value.wordPage<1||value.wordPage>1_000_000))return null
 if(value.wordSection!==undefined&&(!Number.isSafeInteger(value.wordSection)||value.wordSection<1||value.wordSection>4096))return null
 if(value.following!==undefined&&(!Number.isSafeInteger(value.following)||value.following<0))return null
 return{...(value.wordPage===undefined?{}:{wordPage:value.wordPage}),...(value.wordSection===undefined?{}:{wordSection:value.wordSection}),version:1,page:value.page,pageNumber:value.pageNumber,x:value.x,y:value.y,...(value.following===undefined?{}:{following:value.following}),...(value.revision===undefined?{}:{revision:value.revision})}
}
export function fixedFollowCycle(peers:ReadonlyArray<{clientId:number;viewport?:FixedViewport}>,local:number,target:number){
 const states=new Map(peers.map(peer=>[peer.clientId,peer.viewport])),seen=new Set([local]);let client:number|undefined=target
 while(client!==undefined){if(seen.has(client))return true;seen.add(client);client=states.get(client)?.following}
 return false
}
