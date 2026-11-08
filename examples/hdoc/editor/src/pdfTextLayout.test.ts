import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pdfLayoutFont} from './pdfTextLayout.ts'
const layout=()=>({version:1,textHash:'hash',runs:[{chars:1,family:'Noto Sans SC',sizePt:14,bold:false,italic:false},{chars:1,family:'Noto Emoji',sizePt:14,bold:false,italic:false}]})
test('committed PDF mixed fonts use Unicode scalar partitions and readable families',()=>{
 assert.deepEqual(pdfLayoutFont(JSON.stringify(layout()),'hash','中😀'),{family:'Noto Sans SC',sizePt:14,bold:false,italic:false,families:['Noto Sans SC','Noto Emoji'],mixedFamily:true,mixedSize:false,mixedStyle:false})
})
test('stale unsupported and invalid metadata cannot masquerade as committed styles',()=>{
 for(const value of [{...layout(),textHash:'old'},{...layout(),version:2},{...layout(),runs:[{...layout().runs[0],chars:3}]},{...layout(),runs:[{...layout().runs[0],sizePt:Infinity}]},{...layout(),runs:[{...layout().runs[0],family:'bad\nfont'}]}])assert.equal(pdfLayoutFont(JSON.stringify(value),'hash','中😀'),undefined)
 assert.equal(pdfLayoutFont(null,'hash','legacy'),undefined)
})
