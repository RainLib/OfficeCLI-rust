/** Story requests use their own identity and status schema. No synthetic page
 * edits stand in for a source-backed header/footer creation transaction. */
import {WordActiveTopology,type WordActiveTopologyStatus} from './wordActiveTopology.ts'
import {wordStoryPendingHash,type WordPendingStory} from './wordCheckpointJournal.ts'

export type WordActiveStoryStatus=WordActiveTopologyStatus<'story'>
export type WordReviewedStory=WordPendingStory&{reviewHash:string}
export class WordActiveStory extends WordActiveTopology<WordReviewedStory,'story'>{constructor(){super('story',wordStoryPendingHash)}}
export {readActiveStoryPending} from './wordStoryRequest.ts'
