import assert from 'node:assert/strict'
import {readFile,writeFile,mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import type {CanonicalRecoveryVerifier} from '../src/semanticRecoveryArchive.ts'
const run=promisify(execFile)
export function nativeRecoveryVerifier(config:{root:string;binary:string}):CanonicalRecoveryVerifier{return async(bytes,scope)=>{
 const temp=await mkdtemp(join(config.root,'canonical-verification-')),archive=join(temp,'canonical.hcdz'),bundle=join(temp,'canonical.hcd');await writeFile(archive,bytes)
 const cli=async(...args:string[])=>JSON.parse((await run(config.binary,['hdoc',...args,'--json'],{maxBuffer:16*1024*1024})).stdout).data
 await cli('unpack',archive,'--output',bundle);const manifest=JSON.parse(await readFile(join(bundle,'manifest.json'),'utf8')),revision=await cli('get-revision',bundle,String(scope.revision));assert.equal(manifest.documentId,scope.documentId);assert.equal(manifest.revision,scope.revision);assert.equal(revision.rootHash,scope.rootHash);assert.equal((await cli('validate',bundle)).valid,true)
}}
