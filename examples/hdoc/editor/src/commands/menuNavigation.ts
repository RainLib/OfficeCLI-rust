export function initialEnabledIndex(items:readonly {enabled:boolean}[]){return items.findIndex(item=>item.enabled)}
export function moveEnabledIndex(items:readonly {enabled:boolean}[],index:number,direction:1|-1){
 if(!items.length)return -1
 if(index<0){if(direction===1)return initialEnabledIndex(items);for(let next=items.length-1;next>=0;next--)if(items[next].enabled)return next;return -1}
 for(let offset=1;offset<=items.length;offset++){const next=(index+direction*offset+items.length)%items.length;if(items[next].enabled)return next}
 return -1
}
