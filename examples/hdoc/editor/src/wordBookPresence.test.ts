import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readWordPaperLocation,readWordBookProgress,wordSectionViewportProgress} from './wordBookPresence.ts'
test('paper hints are finite, version-independent positions and discard unrelated payload',()=>{
 const value={sectionId:'n_'+'a'.repeat(32),variant:'default' as const,paperIndex:2,paperProgress:.3}
 assert.deepEqual(readWordPaperLocation({...value,token:'not forwarded'}),value)
 for(const patch of [{sectionId:'foreign'},{variant:'odd'},{paperIndex:512},{paperIndex:-1},{paperIndex:1.2},{paperProgress:NaN},{paperProgress:Infinity},{paperProgress:-.1},{paperProgress:1.1}])assert.equal(readWordPaperLocation({...value,...patch}),null)
 assert.deepEqual(readWordPaperLocation({...value,paperProgress:undefined}),{sectionId:value.sectionId,variant:'default',paperIndex:2})
 for(const invalid of [undefined,null,'',1,[]])assert.equal(readWordPaperLocation(invalid),null)
})
test('whole-book progress is separate from the section-local v1 position used by old clients',()=>{
 assert.equal(wordSectionViewportProgress(-300,1800,100,1000),.5)
 assert.equal(wordSectionViewportProgress(200,800,100,1000),0)
 assert.equal(wordSectionViewportProgress(-2000,1800,100,1000),1)
 assert.equal(wordSectionViewportProgress(NaN,100,0,100),0)
 assert.equal(readWordBookProgress({version:1,book:1,progress:.25,bookProgress:.75}),.75)
 assert.equal(readWordBookProgress({version:1,book:1,progress:.25}),undefined)
 for(const bookProgress of [NaN,Infinity,-1,2,'0.4'])assert.equal(readWordBookProgress({book:1,bookProgress}),undefined)
 assert.equal(readWordBookProgress({book:2,bookProgress:.5}),undefined)
})
