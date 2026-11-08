/** Only browser-generated object URLs are used; callers verify bytes first. */
export function downloadNodeFile(name:string,blob:Blob){
 const url=URL.createObjectURL(blob),link=document.createElement('a')
 link.href=url;link.download=name;document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60_000)
}
