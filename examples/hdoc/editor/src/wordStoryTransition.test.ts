import assert from 'node:assert/strict'
import {test} from 'node:test'
import {matchesWordStoryUnlinkTransition,type WordStoryUnlinkIntent} from './wordLayoutTransition.ts'
import type {WordLayout} from './wordRegions.ts'

const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
const before:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:true,stories:[{id:id(3),kind:'header',sourcePart:'word/header1.xml'}],sections:[{id:id(1),differentFirstPage:true,page:{},headers:{first:id(3)},footers:{}},{id:id(2),differentFirstPage:true,page:{},headers:{},footers:{}}]}
const intent:WordStoryUnlinkIntent={sectionId:id(2),kind:'header',variant:'first',expectedInheritedStoryId:id(3)}
function after(){const value=structuredClone(before);value.stories.push({id:id(4),kind:'header',sourcePart:'word/header2.xml'});value.sections[1].headers.first=id(4);return value}

test('independent story receipt changes exactly one inherited variant',()=>{
 assert.equal(matchesWordStoryUnlinkTransition(before,after(),intent),true)
 assert.equal(matchesWordStoryUnlinkTransition(before,after(),{...intent,expectedInheritedStoryId:null}),false)
 for(const change of [
  (value:WordLayout)=>{value.sections[0].page.widthTwips=10000},
  (value:WordLayout)=>{value.sections[1].headers.default=id(4)},
  (value:WordLayout)=>{value.sections.reverse()},
  (value:WordLayout)=>{value.stories[0].sourcePart='word/changed.xml'},
  (value:WordLayout)=>{value.stories[1].id=id(3)},
  (value:WordLayout)=>{value.stories[1].sourcePart='word/header1.xml'},
  (value:WordLayout)=>{value.stories[1].kind='footer'},
  (value:WordLayout)=>{value.stories.push({id:id(5),kind:'footer',sourcePart:'word/footer.xml'})},
 ]){const candidate=after();change(candidate);assert.equal(matchesWordStoryUnlinkTransition(before,candidate,intent),false)}
 assert.equal(matchesWordStoryUnlinkTransition(before,before,intent),false)
})
test('blank first-section variants have no inherited source and existing bindings cannot be replaced',()=>{
 const blank=structuredClone(before),candidate=structuredClone(blank);candidate.stories.push({id:id(4),kind:'footer',sourcePart:'word/footer.xml'});candidate.sections[0].footers.even=id(4)
 assert.equal(matchesWordStoryUnlinkTransition(blank,candidate,{sectionId:id(1),kind:'footer',variant:'even',expectedInheritedStoryId:null}),true)
 const direct=structuredClone(before);direct.sections[1].headers.first=id(3)
 assert.equal(matchesWordStoryUnlinkTransition(direct,after(),intent),false)
})
