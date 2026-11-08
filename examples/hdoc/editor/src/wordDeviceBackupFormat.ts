// Bound the JSON file accepted by both the exporter and the inspection UI.
export const wordDeviceBackupReadLimit=384*1024*1024

// Count in bounded chunks so checking a large file does not allocate another full copy.
export function utf8Length(value:string){
 const encoder=new TextEncoder();let size=0
 for(let start=0;start<value.length;){
  let end=Math.min(start+1024*1024,value.length)
  if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff)end--
  size+=encoder.encode(value.slice(start,end)).length;start=end
 }
 return size
}
