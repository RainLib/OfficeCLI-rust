import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'

const input=JSON.parse(await readFile(process.argv[2],'utf8')),secret=process.env.HCD_TOKEN_SECRET
if(!secret)throw Error('test secret missing')
const journal=new WordCheckpointJournal('/tmp/unused','http://localhost','region-test',0,'e'.repeat(32),secret,true)
assert.equal(journal.verifyLayoutReceipt(input.record,input.request,input.receipt,input.receipt.journalHash),true)
const changed=structuredClone(input.receipt);changed.signature='x'.repeat(43)
assert.equal(journal.verifyLayoutReceipt(input.record,input.request,changed,input.receipt.journalHash),false)
