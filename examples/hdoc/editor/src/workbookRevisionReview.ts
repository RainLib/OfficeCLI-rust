import {api,type Session} from './api.ts'
import {boundedAsyncPool} from './boundedAsyncPool.ts'
import {assetHashes,fixedChunkText,fixedChunkInfos,fixedReviewTextLimit,fixedRevisionRows} from './fixedRevisionReview.ts'
import type {RevisionSelection} from './revisionSelection.ts'

/** Workbook history review over the native grid routes.
 *
 * The descriptor plumbing lives in fixedRevisionReview because `hcd_core`'s
 * `ChunkDescriptor` (crates/hcd-core/src/types.rs) is shared by both profiles:
 * xlsx chunk ids are stable `sheet-window` hashes (crates/hcd-formats/src/xlsx.rs,
 * crates/hcd-core/src/grid_create.rs), so the same chunkId-first pairing with a
 * sequence fallback applies, and `/chunks/{sequence}?revision=` returns a
 * LoadedChunk whose `html` field the review reads while ignoring the extra
 * descriptor/map fields. The asset signature is shared with the fixed review:
 * grid drawing layers embed the same `asset://sha256/{hash}` URIs the fixed
 * pages emit (crates/hcd-formats/src/xlsx.rs), so `assetHashes` is the one
 * signature source for both entries. */

async function readChunkHtml(session:Session,revision:number,sequence:number,signal:AbortSignal):Promise<string>{
	return (await (await api(session,`/chunks/${sequence}?revision=${revision}`,{signal})).json() as {html:string}).html
}

/** Build the review selection comparing `target` against the head revision
 * `comparedWith`: descriptor rows for the whole document, then bounded body
 * text only for the changed rows. */
export async function loadWorkbookRevisionSelection(session:Session,target:number,comparedWith:number,meta:{author?:string;createdAt?:number},signal:AbortSignal):Promise<RevisionSelection>{
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
