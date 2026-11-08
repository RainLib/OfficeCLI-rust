import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {wordPageIntent} from '../examples/hdoc/editor/src/wordPageIntent.ts'
import {wordMarginIntent} from '../examples/hdoc/editor/src/wordMarginIntent.ts'
import {wordPaperIntent} from '../examples/hdoc/editor/src/wordPaperIntent.ts'
const projection=JSON.parse(await readFile(process.argv[2],'utf8')),paper={widthTwips:11906,heightTwips:16838,orientation:'portrait' as const},base={layout:projection.flowLayout,layoutHash:projection.flowLayoutHash,revision:projection.revision,paper}
const section=wordPaperIntent({...base,target:{kind:'section',sectionId:projection.flowLayout.sections[0].id}}),document=wordPaperIntent({...base,target:{kind:'document'}})
const marginSection=wordMarginIntent({...base,target:{kind:'section',sectionId:projection.flowLayout.sections[0].id},margins:{top:875,left:1250,header:null}}),marginDocument=wordMarginIntent({...base,target:{kind:'document'},margins:{top:875,left:1250,header:null}})
const pageSection=wordPageIntent({...base,target:{kind:'section',sectionId:projection.flowLayout.sections[0].id},margins:{top:875,left:1250,header:null}}),pageDocument=wordPageIntent({...base,target:{kind:'document'},margins:{top:875,left:1250,header:null}})
assert.ok(section.intent&&document.intent&&marginSection.intent&&marginDocument.intent&&pageSection.intent&&pageDocument.intent);console.log(JSON.stringify({section,document,marginSection,marginDocument,pageSection,pageDocument}))
