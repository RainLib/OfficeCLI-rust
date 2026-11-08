/** Exact active-link identity is independent of page and story creation. */
import {WordActiveTopology,type WordActiveTopologyStatus} from './wordActiveTopology.ts'
import {wordLinkPendingHash,type WordPendingLink} from './wordLinkProof.ts'
export type WordActiveLinkStatus=WordActiveTopologyStatus<'link'>
export type WordReviewedLink=WordPendingLink&{activeReviewHash:string}
export class WordActiveLink extends WordActiveTopology<WordReviewedLink,'link'>{constructor(){super('link',wordLinkPendingHash)}}
export {readActiveLinkPending} from './wordLinkRequest.ts'
