import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {EmbeddedHcdEditorProps as RuntimeProps} from './embed.tsx'
import type {EmbeddedHcdEditorProps as PublicProps,EditorCommandService} from './public.js'
// Package consumer declaration must remain bidirectionally compatible with the component.
const compatible:<T extends RuntimeProps & PublicProps>(value:T)=>RuntimeProps&PublicProps=value=>value
const publicToRuntime=(value:PublicProps):RuntimeProps=>compatible(value)
const runtimeToPublic=(value:RuntimeProps):PublicProps=>compatible(value)
const ready:NonNullable<PublicProps['commandExtensions']>={commands:[{id:'business.insert',label:'Insert',surfaces:['ribbon','palette'],execute:({commands})=>commands.run('text.insert',{text:'literal'})}],onReady:(service:EditorCommandService)=>service.subscribe(()=>{})}
test('public embedding props and host command cleanup are type-compatible',()=>{
 const value={documentId:'doc',token:'fixture',apiUrl:'/v1/documents',collabUrl:'ws://localhost',commandExtensions:ready}
 assert.equal(publicToRuntime(runtimeToPublic(value)),value)
})
test('public inline registration props keep model3 separate from ordinary node definitions',()=>{
 const inline:NonNullable<PublicProps['inlineContainerExtensions']>={nodes:[{type:'example.field',version:1,display:'inline',contentModel:'inline',label:'Field',defaultData:{},validate:()=>true,fallback:()=> 'Field'}],onReady:service=>service.subscribe(()=>{})}
 const value:PublicProps={documentId:'doc',token:'fixture',apiUrl:'/v1/documents',collabUrl:'ws://localhost',inlineContainerExtensions:inline}
 assert.equal(publicToRuntime(runtimeToPublic(publicToRuntime(value))),value)
 const definition:import('./extensionTypes.ts').NodeExtensionDefinition={type:'example.old',version:1,display:'inline',label:'Old atom',defaultData:{},validate:()=>true,fallback:()=> 'Atom'}
 // @ts-expect-error An editable inline definition cannot be registered as an ordinary atom/block.
 definition.contentModel='inline'
})
