/** Server-only attribution fingerprint for regional Word drafts. */
import {createHash} from 'node:crypto'
import {imageDraftContents,imageDraftMap} from './collaborativeImages.ts'
import {nodeEditFields} from './extensionEdits.ts'
import {referenceEditField} from './referenceEdits.ts'
import {deletionReviewField} from './deletionReview.ts'
import {inlineDeletionField} from './inlineDeletionReview.ts'
import type {WordRegionStore} from './wordRegionStore.ts'

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const ordered=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
export function wordDraftObservation(model:WordRegionStore){
 const digest=hash(model.contents()),document=model.document,base=document.getMap(imageDraftMap).size?hash(`${digest}:${hash(imageDraftContents(document))}`):digest
 const fields=[...Object.values(nodeEditFields),referenceEditField,deletionReviewField,inlineDeletionField].filter(field=>document.getMap(field).size)
 return fields.length?hash(`${base}:${ordered(fields.map(field=>[field,document.getMap(field).toJSON()]))}`):base
}
