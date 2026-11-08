export const nodeEditWireVersion=7 as const
export const legacyProtocol='hcd-default/1' as const
export const structuralProtocol='hcd-semantic-blocks/3' as const
export const wordRegionalProtocol='hcd-word-regions/1' as const
export const wordLayoutProtocol='hcd-word-regions/2' as const
export const inlineProtocol='hcd-semantic-inline/1' as const
export type CollaborationProtocol=typeof legacyProtocol|typeof structuralProtocol|typeof wordRegionalProtocol|typeof wordLayoutProtocol|typeof inlineProtocol
export type CollaborationSession={collaborationEpoch:number;collaborationProtocol:CollaborationProtocol}
export type CollaborationRoom={documentId:string;epoch:number;fixed:boolean;protocol:CollaborationProtocol}
export function parseCollaborationRoom(name:string,options?:{wordLayoutV2?:boolean}):CollaborationRoom{
 const match=/^(fixed:)?([A-Za-z0-9_-]{1,128}):([0-9]+)(?::(typography2|structure3|wordregions1|wordregions2|inlinecontainers1):save(4|5|6))?$/.exec(name)
 if(!match||!match[1]&&!match[4]||match[1]&&match[4]||match[4]&&(match[4]==='wordregions2'?match[5]!=='6'||options?.wordLayoutV2!==true:match[4]==='wordregions1'?match[5]!=='5':match[5]!=='4'))throw new Error('invalid-collaboration-room')
 const epoch=Number(match[3])
 if(!Number.isSafeInteger(epoch)||String(epoch)!==match[3])throw new Error('invalid-collaboration-epoch')
 return{documentId:match[2],epoch,fixed:!!match[1],protocol:match[4]==='wordregions2'?wordLayoutProtocol:match[4]==='wordregions1'?wordRegionalProtocol:match[4]==='inlinecontainers1'?inlineProtocol:match[4]==='structure3'?structuralProtocol:legacyProtocol}
}
export function requireCollaborationSession(value:unknown,options?:{wordLayoutV2?:boolean}):CollaborationSession{
 const session=value as CollaborationSession
 if(!session||!Number.isSafeInteger(session.collaborationEpoch)||session.collaborationEpoch<0||![legacyProtocol,structuralProtocol,wordRegionalProtocol,inlineProtocol,...(options?.wordLayoutV2===true?[wordLayoutProtocol]:[])].includes(session.collaborationProtocol))throw new Error('unsupported-collaboration-session')
 return session
}
export function roomMatches(room:CollaborationRoom,session:CollaborationSession){return room.fixed||room.epoch===session.collaborationEpoch&&room.protocol===session.collaborationProtocol}

/** Explicit wire-model acknowledgement; older clients must not write atom drafts. */
export function nodeEditCollaborationUrl(value:string){const url=new URL(value);url.searchParams.set('hcdNodeEdits',String(nodeEditWireVersion));return url.toString()}
export function inlineCollaborationUrl(value:string){const url=new URL(nodeEditCollaborationUrl(value));url.searchParams.set('hcdInlineContainers','1');return url.toString()}
/** Reserved for explicit layout-aware clients; legacy clients never advertise
 * version 2 and remain unable to negotiate or join its rooms by default. */
export function wordLayoutCollaborationUrl(value:string){const url=new URL(nodeEditCollaborationUrl(value));url.searchParams.set('hcdWordRegions','2');url.searchParams.set('hcdWordLayout','1');return url.toString()}
