import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {wordLayoutRequestHash,matchesWordLayoutRecord} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {matchesWordLayoutTransition} from '../examples/hdoc/editor/src/wordLayoutTransition.ts'
import {dirname,join} from 'node:path'

const path=process.argv[2]
if(!path)throw Error('expected native evidence JSON')
const evidence=JSON.parse(await readFile(path,'utf8')),request=evidence.firstRequest,record=evidence.firstRecord
assert.equal(wordLayoutRequestHash(request),record.patchHash)
assert.equal(matchesWordLayoutRecord(record,request),true)
for(const mutate of [(r:any)=>{r.actor.displayName+='x'},(r:any)=>{r.edits.changes[0].value++},(r:any)=>{r.baseRevision--}]){
 const altered=structuredClone(request);mutate(altered);assert.equal(matchesWordLayoutRecord(record,altered),false)
}
assert.equal(wordLayoutRequestHash(evidence.finalRequest),evidence.finalRecord.patchHash)
assert.equal(matchesWordLayoutRecord(evidence.finalRecord,evidence.finalRequest),true)
const projection=async(revision:number)=>JSON.parse(await readFile(join(dirname(path),`projection-r${revision}.json`),'utf8'))
const [r4,r5,r6,r7]=await Promise.all([4,5,6,7].map(projection))
assert.equal(matchesWordLayoutTransition(r4.flowLayout,r5.flowLayout,evidence.firstRequest),true)
assert.equal(matchesWordLayoutTransition(r6.flowLayout,r7.flowLayout,evidence.finalRequest),true)
const unexpected=structuredClone(r7.flowLayout);unexpected.sections[0].page.heightTwips++
assert.equal(matchesWordLayoutTransition(r6.flowLayout,unexpected,evidence.finalRequest),false)
await writeFile(path+'.receipt.json',JSON.stringify({nativeDigest:record.patchHash,typescriptDigest:wordLayoutRequestHash(request),nativeRevision:record.revision,unicodeMultiFieldDigest:evidence.finalRecord.patchHash,unicodeMultiFieldRevision:evidence.finalRecord.revision,nativeLayoutTransitionsVerified:[5,7],unexpectedLayoutChangeRejected:true,documentId:record.documentId,changedRequestRejected:true,scope:'authenticated-and-owner-fenced receipt required separately'},null,2)+'\n')
