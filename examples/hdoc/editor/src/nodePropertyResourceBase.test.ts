import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resourceOnlyPropertyBase} from './nodePropertyResourceBase.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import type {InlineContainerPayload} from './inlineContainerPayload.ts'
const node:ExtensionNodePayload={schemaVersion:'hcd.extension/2',instanceId:'x_'+'a'.repeat(32),type:'example.field',version:1,display:'inline',data:{title:'Peer name'},fallback:{text:'Peer name'}}
const resource={key:'attachment',hash:'b'.repeat(64),byteLength:3,name:'recovered.txt',mediaType:'text/plain'}
test('a recovered resource refreshes the property precondition while preserving the local form draft',()=>{
 const localForm={title:'Unsaved form value'},changed={...node,resources:[resource]}
 const rebased=resourceOnlyPropertyBase(node,changed)
 assert.equal(rebased,changed);assert.deepEqual(localForm,{title:'Unsaved form value'});assert.equal(node.resources,undefined)
 assert.equal(resourceOnlyPropertyBase(changed,{...changed,resources:[]})?.resources?.length,0)
 assert.equal(resourceOnlyPropertyBase(changed,structuredClone(changed)),null)
})
test('peer property/fallback changes, migration and a different target still require explicit review',()=>{
 for(const changed of [{...node,data:{title:'Other'}},{...node,fallback:{text:'Other'}},{...node,version:2},{...node,instanceId:'x_'+'c'.repeat(32)},{...node,type:'example.other'}])assert.equal(resourceOnlyPropertyBase(node,{...changed,resources:[resource]}),null)
})
test('the same attachment-only rule applies to opt-in editable inline containers',()=>{
 const inline:InlineContainerPayload={...node,schemaVersion:'hcd.extension/3',display:'inline',contentModel:'inline'}
 assert.deepEqual(resourceOnlyPropertyBase(inline,{...inline,resources:[resource]})?.resources,[resource])
 assert.equal(resourceOnlyPropertyBase(node as ExtensionNodePayload|InlineContainerPayload,{...inline,resources:[resource]}),null)
})
