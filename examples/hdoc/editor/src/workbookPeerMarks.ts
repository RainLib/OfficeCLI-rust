import type {FWorkbook} from '@univerjs/preset-sheets-core'
import type {FixedPeer} from './FixedPresence.tsx'
import {createElement} from 'react'

/** Univer owns the geometry, including scroll/zoom/frozen panes. Marks are
 * temporary selection overlays and never alter worksheet styles or values. */
export function markWorkbookPeers(book:FWorkbook,peers:readonly FixedPeer[],localId:string){
 const marks:Array<{dispose:()=>void}>=[]
 try{
  const sheet=book.getActiveSheet(),sheetId=sheet.getSheetId(),rows=sheet.getMaxRows(),columns=sheet.getMaxColumns()
  const groups=new Map<string,{selection:NonNullable<NonNullable<FixedPeer['workbook']>['selection']>;peers:FixedPeer[]}>()
  for(const peer of peers.slice(0,50)){
   const location=peer.workbook,selection=location?.selection
   if(peer.id===localId||!selection||location.sheetId!==sheetId||selection.row+selection.height>rows||selection.column+selection.width>columns)continue
   const key=[selection.row,selection.column,selection.height,selection.width].join(':'),group=groups.get(key)
   if(group)group.peers.push(peer);else groups.set(key,{selection,peers:[peer]})
  }
  for(const {selection,peers:members} of groups.values()){
   const range=sheet.getRange(selection.row,selection.column,selection.height,selection.width)
   try{marks.push(range.highlight({stroke:members[0].color,strokeWidth:2,fill:'rgba(0,0,0,0)',widgets:{},widgetSize:0}))}catch{/* Render may not yet have a sheet skeleton. */}
   try{
    const label=()=>createElement('span',{className:'hcd-workbook-peer-tag','aria-hidden':true,style:{display:'inline-flex',gap:2,pointerEvents:'none',whiteSpace:'nowrap'}},...members.slice(0,3).map(peer=>createElement('span',{key:peer.clientId,style:{background:peer.color,color:'#fff',borderRadius:3,padding:'1px 4px',font:'11px/16px system-ui',maxWidth:100,overflow:'hidden',textOverflow:'ellipsis'}},peer.name)),...(members.length>3?[createElement('span',{key:'more',style:{background:'#55657e',color:'#fff',borderRadius:3,padding:'1px 4px',font:'11px/16px system-ui'}},`+${members.length-3}`)]:[]))
    const popup=range.attachRangePopup({componentKey:label,direction:'top-left',hideOnInvisible:true,showOnSelectionMoving:true,mask:false})
    if(popup)marks.push(popup)
   }catch{/* A missing popup service does not affect the selection border. */}
  }
 }catch{/* A disposed or unready workbook has no visible marks. */}
 return()=>{for(const mark of marks)try{mark.dispose()}catch{/* The workbook may already be disposed. */}}
}
