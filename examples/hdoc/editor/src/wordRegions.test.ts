import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordRegionVersion,readWordLayout,wordRegionSections,wordVariantInherited,type WordLayout} from './wordRegions.ts'
import {api,type Session} from './api.ts'
import {readDocumentSession} from './documentSession.ts'
const identity=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const layout:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:true,stories:[{id:identity(1),kind:'header',sourcePart:'word/header1.xml'},{id:identity(2),kind:'header',sourcePart:'word/header2.xml'},{id:identity(3),kind:'footer',sourcePart:'word/footer1.xml'}],sections:[{id:identity(4),differentFirstPage:true,page:{widthTwips:12240,heightTwips:15840},headers:{default:identity(1),first:identity(2)},footers:{default:identity(3)}},{id:identity(5),differentFirstPage:false,page:{widthTwips:15840,heightTwips:12240},headers:{},footers:{}}]}
const session:Session={documentId:'doc',format:'docx',scope:'read',token:'private',apiUrl:'https://qa.invalid/v1/documents'}
const metadata=(value:WordLayout=layout)=>({revision:4,layout:value,layoutHash:'a'.repeat(64)})
test('Word layout declaration requires a supported version and the Word semantic profile',()=>{
 assert.equal(wordRegionVersion({source:{format:'html'},capabilities:{}}),undefined)
 for(const version of [1,2])assert.equal(wordRegionVersion({source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:version}}),version)
 for(const value of [0,3,'2',null])assert.throws(()=>wordRegionVersion({source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:value}}))
 for(const value of [1,2,null,'1'])assert.throws(()=>wordRegionVersion({source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:value}}))
 for(const value of [{source:{format:'pdf'},profile:'semantic-flow'},{source:{format:'docx'},profile:'fixed-layout'}])assert.throws(()=>wordRegionVersion({...value,capabilities:{flowLayout:2}}))
})
test('Word layout reader fences wrong revisions/models, duplicate IDs and story role mismatches',()=>{
 assert.deepEqual(readWordLayout(metadata(),4,2),layout)
 assert.throws(()=>readWordLayout(metadata(),3,2));assert.throws(()=>readWordLayout(metadata(),4,1))
 for(const change of [(l:WordLayout)=>l.stories.push({...l.stories[0]}),(l:WordLayout)=>l.sections[0].headers.default=identity(3),(l:WordLayout)=>l.sections[0].page.widthTwips=Infinity,(l:WordLayout)=>l.sections[0].headers.default=identity(99)]){const copy=structuredClone(layout);change(copy);assert.throws(()=>readWordLayout(metadata(copy),4,2))}
})
test('paper settings follow native bounds and reject malformed geometry before preview',()=>{
 const valid=structuredClone(layout);valid.sections[0].breakType='continuous';valid.sections[0].page={widthTwips:200_000,heightTwips:1,orientation:'landscape',marginsTwips:{top:-200_000,bottom:-1,left:0,right:200_000,header:0,footer:0,gutter:0},numberStart:0,numberFormat:'upperRoman'}
 assert.deepEqual(readWordLayout(metadata(valid),4,2),valid)
 const changes:Array<(value:WordLayout)=>void>=[
  value=>{value.sections[0].page.widthTwips=200_001},value=>{value.sections[0].breakType='invalid'},value=>{value.sections[0].page.orientation='sideways'},
  value=>{value.sections[0].page.marginsTwips={left:-1}},value=>{value.sections[0].page.marginsTwips={header:Infinity}},value=>{value.sections[0].page.marginsTwips={top:-200_001}},value=>{value.sections[0].page.marginsTwips={unexpected:0}},
  value=>{value.sections[0].page.numberStart=-1},value=>{value.sections[0].page.numberStart=2_147_483_648},value=>{value.sections[0].page.numberFormat='bad format'},value=>{value.sections[0].page.numberFormat=''}
 ]
 for(const change of changes){const value=structuredClone(layout);change(value);assert.throws(()=>readWordLayout(metadata(value),4,2))}
})
test('story source parts follow native path bounds and cannot be ambiguous',()=>{
 for(const part of ['', 'word/document.xml','word/../header.xml','word//header.xml','word/a\\b.xml','word/a?.xml','word/a#b.xml','word/a:b.xml','word/a\u0001.xml','other/header.xml','word/a.xml/','word/'+ 'a'.repeat(1020)+'.xml','word/'+ '字'.repeat(340)+'.xml']){
  const value=structuredClone(layout);value.stories[0].sourcePart=part;assert.throws(()=>readWordLayout(metadata(value),4,2),part)
 }
 const duplicate=structuredClone(layout);duplicate.stories[1].sourcePart=duplicate.stories[0].sourcePart;assert.throws(()=>readWordLayout(metadata(duplicate),4,2))
 const valid=structuredClone(layout);valid.stories[0].sourcePart='word/'+ 'a'.repeat(600)+'.xml';assert.deepEqual(readWordLayout(metadata(valid),4,2),valid)
})
test('shared/default/first bindings follow each variant independently across section inheritance',()=>{
 assert.deepEqual(wordRegionSections(layout,{kind:'header',id:identity(1),sourcePart:'word/header1.xml'}),[{section:1,variants:['default'],inherited:false},{section:2,variants:['default'],inherited:true}])
 assert.deepEqual(wordRegionSections(layout,{kind:'header',sourcePart:'word/header2.xml'}),[{section:1,variants:['first'],inherited:false},{section:2,variants:['first'],inherited:true}])
 assert.deepEqual(wordRegionSections(layout,{kind:'body',id:identity(5),sourcePart:'word/document.xml'}),[{section:2,variants:[],inherited:false}])
 assert.deepEqual(wordRegionSections(layout,{kind:'footer',sourcePart:'word/missing.xml'}),[])
 assert.deepEqual(wordRegionSections(layout,{kind:'header',id:identity(1),sourcePart:'word/header2.xml'}),[])
 assert.deepEqual(wordRegionSections(layout,{kind:'footer',id:identity(1),sourcePart:'word/header1.xml'}),[])
 assert.deepEqual(wordRegionSections(layout,{kind:'body',id:identity(5),sourcePart:'word/header1.xml'}),[])
 const changed=structuredClone(layout);changed.sections[1].headers.first=identity(1)
 assert.deepEqual(wordRegionSections(changed,{kind:'header',id:identity(1),sourcePart:'word/header1.xml'})[1],{section:2,variants:['default','first'],inherited:false})
 assert.equal(wordVariantInherited(changed,1,'header','default'),true)
 assert.equal(wordVariantInherited(changed,1,'header','first'),false)
 assert.equal(wordVariantInherited(changed,1,'footer','default'),true)
 assert.equal(wordVariantInherited(changed,0,'header','even'),false)
 assert.equal(wordVariantInherited(changed,1,'body','default'),false)
})
test('authenticated API acknowledges only the selected Word model and keeps ordinary sessions unchanged',async()=>{
 const fetch=globalThis.fetch,seen:Headers[]=[]
 try{globalThis.fetch=async(_url,init)=>{seen.push(new Headers(init?.headers));return Response.json({})}
  await api(session,'');await api({...session,flowLayoutVersion:2},'/text/n');await api({...session,flowLayoutVersion:1},'/edits')
  assert.equal(seen[0].get('X-HCD-Flow-Layout-Version'),null);assert.equal(seen[1].get('X-HCD-Flow-Layout-Version'),'2');assert.equal(seen[2].get('X-HCD-Flow-Layout-Version'),'1');assert.equal(seen[1].get('Authorization'),'Bearer private')
 }finally{globalThis.fetch=fetch}
})
test('standalone/embed bootstrap discovers Word regions from the authoritative manifest',async()=>{
 const fetch=globalThis.fetch
 try{globalThis.fetch=async(url)=>Response.json(String(url).endsWith('/auth')?{scope:'read',collaborationEpoch:0,userId:'reader'}:{source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2}})
  const opened=await readDocumentSession(session,new AbortController().signal);assert.equal(opened.flowLayoutVersion,2);assert.equal(opened.scope,'read')
 }finally{globalThis.fetch=fetch}
})

test('only explicit layout clients accept stable layout and story markers',()=>{
 const manifest={source:{format:'docx'},profile:'semantic-flow',capabilities:{flowLayout:2,wordLayoutEdits:1}}
 for(const marker of [1,3])assert.equal(wordRegionVersion({...manifest,capabilities:{flowLayout:2,wordLayoutEdits:marker}},{wordLayoutV2:true}),2)
 for(const marker of [2,4,null,'1'])assert.throws(()=>wordRegionVersion({...manifest,capabilities:{flowLayout:2,wordLayoutEdits:marker}},{wordLayoutV2:true}))
 assert.throws(()=>wordRegionVersion({...manifest,capabilities:{flowLayout:1,wordLayoutEdits:1}},{wordLayoutV2:true}));assert.throws(()=>wordRegionVersion(manifest))
})
