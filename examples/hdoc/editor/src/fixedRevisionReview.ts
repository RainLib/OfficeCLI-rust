import {api,type Session} from './api.ts'
import {boundedAsyncPool} from './boundedAsyncPool.ts'
import type {RevisionChangeRow,RevisionSelection} from './revisionSelection.ts'

/** Client-side projection of `hcd_core::ChunkDescriptor` (crates/hcd-core/src/types.rs)
 * limited to the fields a page-level comparison needs. The index pages already
 * carry these hashes, so reviewing a revision costs descriptors plus bounded
 * chunk bodies instead of a whole-document projection. */
export type FixedChunkInfo={sequence:number;chunkId:string;region:string;continuation:boolean;htmlHash:string;mapHash:string;blockCount:number;textChars:number}
const indexPageSize=128
/** Changed rows beyond this count stay hash-level rows: the review surface
 * still shows their kind and position, only the token diff is omitted. */
export const fixedReviewTextLimit=200

type ManifestAtRevision={revision:number;chunkCount:number;indexPageCount:number}
type IndexPageAtRevision={revision:number;page:number;chunks:FixedChunkInfo[]}

function validChunk(chunk:FixedChunkInfo):boolean{
	return typeof chunk.chunkId==='string'&&chunk.chunkId.length>0&&typeof chunk.region==='string'
		&&typeof chunk.htmlHash==='string'&&chunk.htmlHash.length>0&&typeof chunk.mapHash==='string'&&chunk.mapHash.length>0
		&&Number.isSafeInteger(chunk.blockCount)&&chunk.blockCount>=0&&Number.isSafeInteger(chunk.textChars)&&chunk.textChars>=0
}

/** Immutable read of one revision's descriptor set via the native document and
 * index routes (same routes RevisionDocument already relies on). */
export async function fixedChunkInfos(session:Session,revision:number,signal:AbortSignal):Promise<FixedChunkInfo[]>{
	if(!Number.isSafeInteger(revision)||revision<0)throw new RangeError('invalid revision')
	const manifest=await (await api(session,`?revision=${revision}`,{signal})).json() as ManifestAtRevision
	if(!Number.isSafeInteger(manifest.revision)||manifest.revision!==revision||!Number.isSafeInteger(manifest.chunkCount)||manifest.chunkCount<0||!Number.isSafeInteger(manifest.indexPageCount)||manifest.indexPageCount!==Math.ceil(manifest.chunkCount/indexPageSize))throw new Error('fixed-index-mismatch')
	signal.throwIfAborted()
	const pages=await boundedAsyncPool(Array.from({length:manifest.indexPageCount},(_,page)=>async(taskSignal:AbortSignal)=>{
		const result=await (await api(session,`/index/${page}?revision=${revision}`,{signal:taskSignal})).json() as IndexPageAtRevision
		if(result.revision!==revision||result.page!==page||!Array.isArray(result.chunks)||result.chunks.length!==Math.min(indexPageSize,manifest.chunkCount-page*indexPageSize))throw new Error('fixed-index-mismatch')
		if(result.chunks.some((chunk,position)=>chunk.sequence!==page*indexPageSize+position||!validChunk(chunk)))throw new Error('fixed-index-mismatch')
		return result.chunks
	}),signal)
	return pages.flat()
}

/** Longest increasing subsequence over `next`, mirroring revisionDiff.ts's
 * `retained`: a pair outside the stable set has genuinely reordered. */
function stablePairs(pairs:Array<{old:number;next:number}>){
	const tails:number[]=[],previous:number[]=[]
	pairs.forEach((pair,index)=>{let low=0,high=tails.length;while(low<high){const middle=(low+high)>>1;if(pairs[tails[middle]].old<pair.old)low=middle+1;else high=middle}previous[index]=low?tails[low-1]:-1;tails[low]=index})
	const result=new Set<number>()
	for(let index=tails.at(-1)??-1;index>=0;index=previous[index])result.add(pairs[index].next)
	return result
}

/** Pair two descriptor sets and fold them into neutral review rows.
 *
 * Identity is taken from `chunkId` first: pptx/pdf chunk ids are content-hash
 * constants over the source part (crates/hcd-formats/src/pptx.rs, pdf.rs), so
 * they survive every edit of the same page or slide. Leftovers then pair by
 * equal `sequence`, which covers formats whose ids are index-derived and shift
 * when pages split or merge. `htmlHash` marks visible changes, `mapHash` alone
 * is a regenerated receipt (kind stays `same`, matching the semantic engine),
 * and identical visible size with a changed html is treated as formatting
 * until the text fetch can refine it. */
export function fixedRevisionRows(before:FixedChunkInfo[],after:FixedChunkInfo[]):RevisionChangeRow[]{
	const oldByChunk=new Map<string,number>()
	before.forEach((chunk,index)=>{if(!oldByChunk.has(chunk.chunkId))oldByChunk.set(chunk.chunkId,index)})
	const usedOld=new Set<number>(),pairs:Array<{old:number;next:number}>=[]
	after.forEach((chunk,next)=>{const old=oldByChunk.get(chunk.chunkId);if(old!==undefined&&!usedOld.has(old)){usedOld.add(old);pairs.push({old,next})}})
	const usedNext=new Set(pairs.map(pair=>pair.next))
	const oldBySequence=new Map<number,number>()
	before.forEach((chunk,index)=>{if(!usedOld.has(index)&&!oldBySequence.has(chunk.sequence))oldBySequence.set(chunk.sequence,index)})
	after.forEach((chunk,next)=>{if(usedNext.has(next))return;const old=oldBySequence.get(chunk.sequence);if(old!==undefined&&!usedOld.has(old)){usedOld.add(old);usedNext.add(next);pairs.push({old,next})}})
	const stable=stablePairs(pairs.slice().sort((a,b)=>a.next-b.next))
	const pairRows=new Map<number,RevisionChangeRow>()
	pairs.forEach(pair=>{
		const previous=before[pair.old],current=after[pair.next]
		const htmlChanged=previous.htmlHash!==current.htmlHash,mapChanged=previous.mapHash!==current.mapHash
		pairRows.set(pair.next,{kind:htmlChanged?'modified':'same',moved:!stable.has(pair.next),
			formatChanged:htmlChanged?previous.textChars===current.textChars&&previous.blockCount===current.blockCount:mapChanged,
			objectChanged:false,oldIndex:pair.old,newIndex:pair.next,beforeText:'',afterText:''})
	})
	const removedRows=before.map((chunk,index)=>index).filter(index=>!usedOld.has(index)).map(index=>({index,row:{kind:'removed' as const,moved:false,formatChanged:false,objectChanged:false,oldIndex:index,newIndex:undefined,beforeText:'',afterText:''}}))
	const addedByNext=new Map(after.map((chunk,index)=>index).filter(index=>!usedNext.has(index)).map(index=>[index,{kind:'added' as const,moved:false,formatChanged:false,objectChanged:false,oldIndex:undefined,newIndex:index,beforeText:'',afterText:''}] as const))
	const result:RevisionChangeRow[]=[]
	let deleted=0
	for(let next=0;next<after.length;next++){
		const pair=pairRows.get(next)
		if(pair?.oldIndex!==undefined)while(deleted<removedRows.length&&removedRows[deleted].index<pair.oldIndex)result.push(removedRows[deleted++].row)
		const added=addedByNext.get(next)
		if(pair)result.push(pair)
		else if(added)result.push(added)
	}
	while(deleted<removedRows.length)result.push(removedRows[deleted++].row)
	return result
}

const namedEntities=new Map([['amp','&'],['lt','<'],['gt','>'],['quot','"'],['apos',"'"],["nbsp","\u00a0"]])
function decodeEntity(raw:string):string{
	const inner=raw.slice(1,-1)
	if(inner.startsWith('#')){const code=(inner[1]==='x'||inner[1]==='X')?Number.parseInt(inner.slice(2),16):Number.parseInt(inner.slice(1),10);return Number.isSafeInteger(code)&&code>=0&&code<0x110000?String.fromCodePoint(code):raw}
	return namedEntities.get(inner.toLowerCase())??raw
}

/** Pure text extraction from a fixed-layout chunk body. Chunks are static
 * markup, so a tag-and-entity pass keeps this testable without a DOM and
 * matches what the renderer shows closely enough for token diffing. */
export function fixedChunkText(html:string):string{
	return html
		.replace(/<!--[\s\S]*?(?:-->|$)/g,' ')
		.replace(/<(style|script|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
		.replace(/<[^>]*>/g,' ')
		.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,decodeEntity)
		.replace(/\s+/g,' ')
		.trim()
}

// The chunk HTML both backends actually serves embeds assets as
// `src="asset://sha256/{hash}"` (hcd-formats xlsx.rs/pptx.rs/pdf.rs); the
// export lets the workbook review share the exact signature source.
export const assetHashes=(html:string):string=>[...new Set([...html.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g)].map(match=>match[1]))].sort().join(',')

async function readChunkHtml(session:Session,revision:number,sequence:number,signal:AbortSignal):Promise<string>{
	return (await (await api(session,`/chunks/${sequence}?revision=${revision}`,{signal})).json() as {html:string}).html
}

/** Build the full review selection for a fixed-layout history comparison:
 * descriptors at both revisions, page-level rows, then body text fetched only
 * for changed rows and only up to the bounded limit. */
export async function loadFixedRevisionSelection(session:Session,target:number,comparedWith:number,meta:{author?:string;createdAt?:number},signal:AbortSignal):Promise<RevisionSelection>{
	const [before,after]=await Promise.all([fixedChunkInfos(session,target,signal),fixedChunkInfos(session,comparedWith,signal)])
	const changes=fixedRevisionRows(before,after)
	const changed=changes.filter(row=>row.kind!=='same'||row.moved).slice(0,fixedReviewTextLimit)
	await boundedAsyncPool(changed.map(row=>async(taskSignal:AbortSignal)=>{
		const oldHtml=row.oldIndex===undefined?'':await readChunkHtml(session,target,before[row.oldIndex].sequence,taskSignal)
		const newHtml=row.newIndex===undefined?'':await readChunkHtml(session,comparedWith,after[row.newIndex].sequence,taskSignal)
		row.beforeText=fixedChunkText(oldHtml)
		row.afterText=fixedChunkText(newHtml)
		if(row.kind==='modified'&&row.oldIndex!==undefined&&row.newIndex!==undefined){
			const textChanged=row.beforeText!==row.afterText,assetChanged=assetHashes(oldHtml)!==assetHashes(newHtml)
			row.objectChanged=assetChanged
			row.formatChanged=!textChanged&&!assetChanged
		}
	}),signal)
	return {target,comparedWith,...meta,changes}
}
