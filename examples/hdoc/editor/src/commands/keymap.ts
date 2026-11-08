type Platform='mac'|'other'
export type KeyEvent=Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'shiftKey'|'altKey'|'isComposing'|'keyCode'>&{getModifierState?:(key:string)=>boolean;defaultPrevented?:boolean}
const modifiers=new Set(['mod','ctrl','meta','alt','shift'])
/** Inspector document text participates in editor undo; search/URL/property fields do not. */
export function commandKeyScope(target:EventTarget|null):'editor'|'input'{
 if(typeof Element==='undefined'||!(target instanceof Element))return 'editor'
 if(target.closest('[data-command-input="document"]'))return 'editor'
 return target.closest('input,textarea,select,[contenteditable="false"]')?'input':'editor'
}
const keyName=(key:string)=>({esc:'escape',space:' ',return:'enter',del:'delete',plus:'+'}[key.toLowerCase()]??key.toLowerCase())
export function shortcutKey(shortcut:string,platform:Platform){
 const parts=shortcut.split('+').map(part=>part.trim().toLowerCase())
 const key=parts.pop();if(!key||parts.some(part=>!modifiers.has(part))||new Set(parts).size!==parts.length)throw new Error(`Invalid shortcut: ${shortcut}`)
 const resolved=parts.map(part=>part==='mod'?(platform==='mac'?'meta':'ctrl'):part)
 if(new Set(resolved).size!==resolved.length)throw new Error(`Duplicate shortcut modifier: ${shortcut}`)
 return [...resolved.sort(),keyName(key)].join('|')
}
export function eventKey(event:KeyEvent){
 if(event.isComposing||event.keyCode===229||event.getModifierState?.('AltGraph')||['Dead','Unidentified','Process'].includes(event.key))return null
 return [...(event.ctrlKey?['ctrl']:[]),...(event.metaKey?['meta']:[]),...(event.altKey?['alt']:[]),...(event.shiftKey?['shift']:[])].sort().concat(keyName(event.key)).join('|')
}
export function displayShortcut(shortcut:string,platform:Platform){return shortcut.split('+').map(part=>({Mod:platform==='mac'?'⌘':'Ctrl',Ctrl:'Ctrl',Meta:'⌘',Alt:platform==='mac'?'⌥':'Alt',Shift:platform==='mac'?'⇧':'Shift'}[part]??part.toUpperCase())).join(platform==='mac'?'':' + ')}
