import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordStoryForPage,wordStoryForVariant,wordStoryForPreview,wordVariantForSectionPage,wordPaperGeometry,wordPaperFormat,wordBodyGroup,wordBodyGroupFromIndex,wordPresenceLocation,wordRegionIsActive,wordPreviewVariant,wordStoryIsShared,wordPeerOnPaper,wordSectionPageParityKnown} from './wordPaper.ts'

test('shared header awareness belongs to its actual section and physical page',()=>{
 const peer={clientId:1,id:'bob',name:'Bob',color:'#3478c0',selection:{page:140,nodeId:'header',kind:'text' as const},viewport:{version:1 as const,page:128,pageNumber:129,x:0,y:0,wordPage:2,revision:3}}
 assert.equal(wordPeerOnPaper(peer,128,2,3),true)
 assert.equal(wordPeerOnPaper(peer,0,2,3),false)
 assert.equal(wordPeerOnPaper(peer,128,1,3),false)
 assert.equal(wordPeerOnPaper(peer,128,2,4),false)
 assert.equal(wordPeerOnPaper({...peer,viewport:undefined},128,2,3),false)
 const legacy={...peer,viewport:{...peer.viewport,wordPage:undefined}}
 assert.equal(wordPeerOnPaper(legacy,128,2,3),false)
 assert.equal(wordPeerOnPaper({...legacy,selection:{...legacy.selection,page:128}},128,2,3),true)
})

test('commands target only the currently visible body or active header/footer story',()=>{
 assert.equal(wordRegionIsActive('body-a','body-a','header-a','footer-a',false),true)
 assert.equal(wordRegionIsActive('body-a','body-b','header-a','footer-b',false),false)
 assert.equal(wordRegionIsActive('body-a','body-a','header-a','footer-a',true),false)
 assert.equal(wordRegionIsActive('header-a','body-a','header-a','footer-a',true),true)
 assert.equal(wordRegionIsActive('footer-a','body-a','header-a','footer-b',true),false)
 assert.equal(wordRegionIsActive(undefined,'body-a',undefined,undefined,true),false)
})

test('preview choice reports the actual story variant when first/even settings are disabled',()=>{
 const base={sections:[{differentFirstPage:false}],evenAndOddHeaders:false} as Parameters<typeof wordPreviewVariant>[0]
 assert.equal(wordPreviewVariant(base,0,'first'),'default')
 assert.equal(wordPreviewVariant(base,0,'even'),'default')
 assert.equal(wordPreviewVariant({...base,evenAndOddHeaders:true},0,'even'),'even')
 const first={...base,sections:[{...base.sections[0],differentFirstPage:true}]}
 assert.equal(wordPreviewVariant(first,0,'first'),'first')
 assert.equal(wordPreviewVariant(first,0,'default'),'default')
})
import type {WordLayout} from './wordRegions.ts'
const layout:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:true,stories:['a','b','c','d'].map((id,index)=>({id,kind:index===3?'footer':'header',sourcePart:`word/${id}.xml`})),sections:[{id:'one',differentFirstPage:true,page:{widthTwips:12240,heightTwips:15840,marginsTwips:{top:1440,left:1440,right:1440,bottom:1440,header:720,footer:720}},headers:{default:'a',first:'b',even:'c'},footers:{default:'d'}},{id:'two',differentFirstPage:false,page:{widthTwips:15840,heightTwips:12240,numberStart:4},headers:{},footers:{}}]}
test('shared stories are detected for both original and inherited bindings, including alternate variants',()=>{
 assert.equal(wordStoryIsShared(layout,layout.stories[0]),true)
 const single=structuredClone(layout);single.sections[1].headers.default='b'
 assert.equal(wordStoryIsShared(single,single.stories[0]),false)
 single.sections[0].headers.even='a'
 assert.equal(wordStoryIsShared(single,single.stories[0]),true)
 assert.equal(wordStoryIsShared(single,undefined),false)
})
test('paper stories resolve first/even/default independently with source inheritance',()=>{
 assert.equal(wordStoryForPage(layout,0,'header',true,2)?.id,'b')
 assert.equal(wordStoryForPage(layout,0,'header',false,2)?.id,'c')
 assert.equal(wordStoryForPage(layout,1,'header',true,4)?.id,'c')
 assert.equal(wordStoryForPage(layout,1,'header',false,5)?.id,'a')
 assert.equal(wordStoryForPage(layout,0,'footer',true,1),undefined)
 assert.equal(wordStoryForPage(layout,1,'footer',false,5)?.id,'d')
 const changed=structuredClone(layout);changed.evenAndOddHeaders=false
 assert.equal(wordStoryForPage(changed,1,'header',false,4)?.id,'a')
 assert.equal(wordStoryForPage(layout,99,'header',false,1),undefined)
})
test('continuous section page parity is never guessed when the previous page count is unknown',()=>{
 const value=structuredClone(layout);delete value.sections[1].page.numberStart
 assert.equal(wordVariantForSectionPage(value,0,1),'even')
 assert.equal(wordVariantForSectionPage(value,1,0),'unknown')
 assert.equal(wordVariantForSectionPage(value,1,1),'unknown')
 assert.equal(wordStoryForVariant(value,1,'header','unknown'),undefined)
 value.sections[1].differentFirstPage=true
 assert.equal(wordVariantForSectionPage(value,1,0),'first')
 assert.equal(wordVariantForSectionPage(value,1,1),'unknown')
 value.sections[1].page.numberStart=4
 assert.equal(wordVariantForSectionPage(value,1,1),'default')
 value.evenAndOddHeaders=false;delete value.sections[1].page.numberStart
 assert.equal(wordVariantForSectionPage(value,1,1),'default')
})
test('unknown parity allows only regions whose odd and even bindings resolve identically',()=>{
 const value=structuredClone(layout);delete value.sections[1].page.numberStart
 assert.deepEqual(wordStoryForPreview(value,1,'header','unknown'),{story:undefined,ambiguous:true})
 assert.deepEqual(wordStoryForPreview(value,1,'footer','unknown'),{story:undefined,ambiguous:true})
 value.sections[1].headers.even='a'
 assert.deepEqual(wordStoryForPreview(value,1,'header','unknown'),{story:value.stories[0],ambiguous:false})
 assert.equal(wordStoryForPreview(value,1,'footer','unknown').ambiguous,true)
 value.sections[0].footers={}
 assert.deepEqual(wordStoryForPreview(value,1,'footer','unknown'),{story:undefined,ambiguous:false})
 assert.equal(wordStoryForPreview(value,99,'header','unknown').ambiguous,true)
})
test('independent screen pagination never silently blanks ambiguous inherited margins',()=>{
 const value=structuredClone(layout);delete value.sections[1].page.numberStart
 assert.equal(wordSectionPageParityKnown(value,0),true)
 assert.equal(wordSectionPageParityKnown(value,1),false)
 value.sections[1].differentFirstPage=true
 assert.equal(wordSectionPageParityKnown(value,1),false)
 value.sections[1].headers.even='a';value.sections[1].footers.even='d'
 assert.equal(wordSectionPageParityKnown(value,1),true)
 value.sections[1].headers.even='c';value.sections[1].page.numberStart=4
 assert.equal(wordSectionPageParityKnown(value,1),true)
 assert.equal(wordSectionPageParityKnown(value,99),false)
})
test('paper dimensions use the section orientation and margins without converting native chunks to pages',()=>{
 assert.deepEqual(wordPaperGeometry(layout,0),{width:816,height:1056,left:96,right:96,top:96,bottom:96,header:48,footer:48,bodyWidth:624,bodyHeight:864})
 assert.equal(wordPaperGeometry(layout,1).width,1056);assert.equal(wordPaperGeometry(layout,1).height,816)
})

test('paper labels distinguish Letter and landscape A4 using actual dimensions',()=>{
 assert.equal(wordPaperFormat(816,1056),'Letter')
 assert.equal(wordPaperFormat(16838/15,11906/15),'A4')
 assert.equal(wordPaperFormat(700,900),undefined)
})

test('history and follow map a shared story back to the preferred body instead of selecting the first section',async()=>{
 const first={firstSequence:0,region:'body',sequences:[0]},second={firstSequence:3,region:'body',sequences:[3]},header={firstSequence:5,region:'header',sequences:[5]}
 const load=async(group:{firstSequence:number})=>({wordRegion:group.firstSequence===5?{kind:'header',id:'a',sourcePart:'word/a.xml'}:{kind:'body',id:group.firstSequence===0?'one':'two',sourcePart:'word/document.xml'}}) as import('./fixedPages.ts').RenderedPage
 assert.equal((await wordBodyGroup(header,2,layout,[first,second,header],load,3)).firstSequence,3)
 assert.equal((await wordBodyGroup(header,2,layout,[first,second,header],load)).firstSequence,0)
 const aborted=new AbortController();aborted.abort();await assert.rejects(wordBodyGroup(header,2,layout,[first],load,undefined,aborted.signal),/Aborted/)
 const missing=structuredClone(layout);missing.stories=[];missing.sections.forEach(section=>{section.headers={}});await assert.rejects(wordBodyGroup(header,2,missing,[first],load),/fixedLocationUnavailable/)
})

test('story location uses the updated index after asynchronous loading and preserves the preferred section',async()=>{
 const first={firstSequence:0,region:'body',sequences:[0]},second={firstSequence:130,region:'body',sequences:[130]},header={firstSequence:140,region:'header',sequences:[140]}
 let groups=[first],finished=false;const seen:number[]=[]
 const load=async(group:{firstSequence:number})=>{seen.push(group.firstSequence);if(group===header){groups=[first,second];finished=true}return {wordRegion:group===header?{kind:'header',id:'a',sourcePart:'word/a.xml'}:{kind:'body',id:group===first?'one':'two',sourcePart:'word/document.xml'}} as import('./fixedPages.ts').RenderedPage}
 const actual=await wordBodyGroupFromIndex(header,2,layout,()=>groups,()=>finished,async()=>{throw Error('unexpected load')},load,130)
 assert.equal(actual.firstSequence,130);assert.deepEqual(seen,[140,130])
})
test('story location loads further index pages only until a matching body is found',async()=>{
 const second={firstSequence:130,region:'body',sequences:[130]},header={firstSequence:5,region:'header',sequences:[5]}
 const single=structuredClone(layout);single.sections[0].headers.default=undefined
 let groups=[header],requests=0
 const load=async(group:{firstSequence:number})=>({wordRegion:group===header?{kind:'header',id:'a',sourcePart:'word/a.xml'}:{kind:'body',id:'two',sourcePart:'word/document.xml'}}) as import('./fixedPages.ts').RenderedPage
 // The later section references this story explicitly.
 single.sections[1].headers.default='a'
 const found=await wordBodyGroupFromIndex(header,2,single,()=>groups,()=>false,async()=>{requests++;groups=[header,second]},load)
 assert.equal(found.firstSequence,130);assert.equal(requests,1)
 const canceled=new AbortController();canceled.abort()
 await assert.rejects(wordBodyGroupFromIndex(header,2,single,()=>[header],()=>false,async()=>{requests++},load,undefined,canceled.signal),/Aborted/)
 assert.equal(requests,1)
})

test('story location skips verified unrelated body groups but verifies the selected region',async()=>{
 const header={firstSequence:150,region:'header',sequences:[150]},groups=Array.from({length:140},(_,i)=>({firstSequence:i,region:'body',sequences:[i],wordRegionId:i===139?'two':`unrelated-${i}`,wordRegionsVerified:true})),seen:number[]=[]
 const target=structuredClone(layout);target.sections[0].headers.default=undefined;target.sections[1].headers.default='a'
 const load=async(group:{firstSequence:number})=>{seen.push(group.firstSequence);return {wordRegion:group===header?{kind:'header',id:'a',sourcePart:'word/a.xml'}:{kind:'body',id:'two',sourcePart:'word/document.xml'}} as import('./fixedPages.ts').RenderedPage}
 const result=await wordBodyGroupFromIndex(header,2,target,()=>groups,()=>true,async()=>{},load)
 assert.equal(result.firstSequence,139);assert.deepEqual(seen,[150,139])
 await assert.rejects(wordBodyGroupFromIndex(header,2,target,()=>groups,()=>true,async()=>{},async group=>group===header?load(group):({wordRegion:{kind:'body',id:'forged'}} as any)),/word-region-index-mismatch/)
 await assert.rejects(wordBodyGroupFromIndex(header,2,target,()=>groups,()=>true,async()=>{},async group=>group===header?load(group):({wordRegion:{kind:'body',id:'two',sourcePart:'word/header.xml'}} as any)),/word-region-index-mismatch/)
})

test('legacy story location refuses a body identity carried by a different source part',async()=>{
 const header={firstSequence:2,region:'header',sequences:[2]},body={firstSequence:0,region:'body',sequences:[0]},target=structuredClone(layout)
 target.sections[0].headers.default=undefined;target.sections[1].headers.default='a'
 const load=async(group:{firstSequence:number})=>({wordRegion:group===header?{kind:'header',id:'a',sourcePart:'word/a.xml'}:{kind:'body',id:'two',sourcePart:'word/header.xml'}}) as import('./fixedPages.ts').RenderedPage
 await assert.rejects(wordBodyGroupFromIndex(header,2,target,()=>[body],()=>true,async()=>{},load),/fixedLocationUnavailable/)
})

test('regional presence retains the containing section for inherited stories and rejects foreign locations',()=>{
 assert.deepEqual(wordPresenceLocation(layout,'a','two','default'),{section:1,stories:true,variant:'default'})
 assert.deepEqual(wordPresenceLocation(layout,'d','one','default'),{section:0,stories:true,variant:'default'})
 assert.deepEqual(wordPresenceLocation(layout,'two','one','first'),{section:1,stories:false,variant:undefined})
 assert.equal(wordPresenceLocation(layout,'foreign','two','default'),null)
 assert.deepEqual(wordPresenceLocation(layout,'a','foreign','forged'),{section:0,stories:true,variant:'default'})
})

test('story loading is bounded and a stale section stops requesting more pages',async()=>{
 const {loadWordPageStories}=await import('./wordPaper.ts')
 const groups=Array.from({length:12},(_,i)=>({firstSequence:i,region:i===11?'body':i%2?'footer':'header',sequences:[i]})),controller=new AbortController();let active=0,peak=0,started=0,ready!:()=>void,release!:()=>void
 const initial=new Promise<void>(resolve=>ready=resolve),hold=new Promise<void>(resolve=>release=resolve)
 const load=async(group:typeof groups[number],revision:number)=>{assert.equal(revision,7);started++;active++;peak=Math.max(peak,active);if(started===4)ready();await hold;active--;return {revision,group} as any}
 const pending=loadWordPageStories(groups,7,load,controller.signal);await initial;assert.equal(started,4);controller.abort(new Error('section changed'));release();await assert.rejects(pending,/section changed/);assert.equal(started,4);assert.equal(peak,4);assert.equal(active,0)
 const loaded=await loadWordPageStories(groups,7,async group=>({revision:7,group} as any),new AbortController().signal);assert.deepEqual(loaded.map(item=>item.group.firstSequence),Array.from({length:11},(_,i)=>i))
})

test('pagination measures only enabled first and even stories, including inherited ones',async()=>{
 const {wordMeasuredStoryIds}=await import('./wordPaper.ts')
 const sample=structuredClone(layout)
 assert.deepEqual([...wordMeasuredStoryIds(sample,0)].sort(),['a','b','c','d'].sort())
 sample.sections[0].differentFirstPage=false;sample.evenAndOddHeaders=false
 assert.deepEqual([...wordMeasuredStoryIds(sample,0)].sort(),['a','d'])
 assert.deepEqual([...wordMeasuredStoryIds(sample,1)].sort(),['a','d'])
 sample.evenAndOddHeaders=true
 assert.deepEqual([...wordMeasuredStoryIds(sample,1)].sort(),['a','c','d'].sort())
 sample.sections[1].differentFirstPage=true
 assert.deepEqual([...wordMeasuredStoryIds(sample,1)].sort(),['a','b','c','d'].sort())
 assert.equal(wordMeasuredStoryIds(sample,9).size,0)
})

test('region-indexed story loading selects effective variants and falls back for old indexes',async()=>{
 const {wordStoryGroupsForSection}=await import('./wordPaper.ts')
 const groups=['a','b','c','d','other'].map((id,index)=>({firstSequence:index,region:index===3?'footer':'header',sequences:[index],wordRegionId:id,wordRegionsVerified:true}))
 const sample=structuredClone(layout);sample.sections[0].differentFirstPage=false;sample.evenAndOddHeaders=false
 assert.deepEqual(wordStoryGroupsForSection(groups,sample,0).map(group=>group.wordRegionId),['a','d'])
 assert.deepEqual(wordStoryGroupsForSection(groups,sample,1,4).map(group=>group.wordRegionId),['a','d','other'])
 sample.evenAndOddHeaders=true;sample.sections[0].differentFirstPage=true
 assert.deepEqual(wordStoryGroupsForSection(groups,sample,0).map(group=>group.wordRegionId),['a','b','c','d'])
 const legacy=groups.map(({wordRegionId:_id,wordRegionsVerified:_verified,...group})=>group)
 assert.deepEqual(wordStoryGroupsForSection(legacy,sample,0),legacy)
 assert.deepEqual(wordStoryGroupsForSection([...groups.slice(0,4),legacy[4]],sample,0),[...groups.slice(0,4),legacy[4]])
})

test('verified story identity must match the loaded page before it can be displayed',async()=>{
 const {loadWordPageStories}=await import('./wordPaper.ts')
 const group={firstSequence:0,region:'header',sequences:[0],wordRegionId:'expected',wordRegionsVerified:true}
 await assert.rejects(loadWordPageStories([group],1,async()=>({wordRegion:{id:'other'}} as any),new AbortController().signal),/word-region-index-mismatch/)
})
