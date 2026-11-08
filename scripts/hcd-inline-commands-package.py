#!/usr/bin/env python3
"""Verify the actual local packed SDK; no publish or user document writes."""
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path


def main():
    repo = Path(__file__).resolve().parents[1]
    editor = repo / 'examples/hdoc/editor'
    root = Path(tempfile.mkdtemp(prefix='hcd-inline-command-package-', dir=repo / 'target/hcd-preview-runtime'))
    assets = repo / 'docs/assets/hcd-inline-commands-2026-10-27'
    assets.mkdir(exist_ok=True)
    packed = json.loads(subprocess.check_output(['npm', 'pack', '--ignore-scripts', '--pack-destination', str(root), '--json'], cwd=editor, text=True))[0]
    modules = root / 'node_modules'
    modules.mkdir()
    for item in (editor / 'node_modules').iterdir():
        if item.name != '@officecli':
            (modules / item.name).symlink_to(item, target_is_directory=item.is_dir())
    (modules / '@officecli').mkdir()
    with tarfile.open(root / packed['filename']) as archive:
        archive.extractall(root / 'unpacked', filter='data')
    shutil.move(str(root / 'unpacked/package'), modules / '@officecli/hcd-reference-editor')
    consumer = root / 'consumer.mts'
    consumer.write_text('''import assert from 'node:assert/strict'
import {Editor,Node} from '@tiptap/core'
import {EditorState,TextSelection,NodeSelection,type Transaction} from '@tiptap/pm/state'
import {InlineContainerRegistry,SemanticInlineContainerNode,prepareInlineContainerTransaction,selectedInlineContainer,type InlineContainerExtensions,type InlineContainerService,type InlineContainerDefinition} from '@officecli/hcd-reference-editor/inline-containers'
import type {EmbeddedHcdEditorProps,NodeExtensionDefinition} from '@officecli/hcd-reference-editor/react'
const definition:InlineContainerDefinition={type:'example.package_field',version:1,display:'inline',contentModel:'inline',label:{'en-US':'Field','zh-CN':'字段'},defaultData:{title:'字段'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title),properties:[{key:'title',label:'名称',kind:'text',required:true}]}
// @ts-expect-error editable inline content cannot be registered as an ordinary atom
const legacy:NodeExtensionDefinition=definition
const configuration:InlineContainerExtensions={nodes:[definition],onReady:(service:InlineContainerService)=>service.subscribe(()=>{})}
const props:EmbeddedHcdEditorProps={documentId:'owned',token:'fixture',apiUrl:'/v1/documents',collabUrl:'ws://localhost',inlineContainerExtensions:configuration}
assert.equal(props.inlineContainerExtensions,configuration)
const registry=new InlineContainerRegistry(configuration.nodes),release=registry.connect()
const editor=new Editor({element:null,content:{type:'doc',content:[{type:'paragraph'}]},extensions:[Node.create({name:'doc',topNode:true,content:'paragraph+'}),Node.create({name:'paragraph',group:'block',content:'inline*'}),Node.create({name:'text',group:'inline'}),SemanticInlineContainerNode.configure({registry:()=>registry})]})
let state=EditorState.create({schema:editor.schema,doc:editor.schema.nodes.doc.createChecked(null,editor.schema.nodes.paragraph.createChecked())}),dispatches=0
const view={get state(){return state},composing:false,editable:true,dispatch(tr:Transaction){dispatches++;state=state.applyTransaction(tr).state},focus(){}}
Object.defineProperties(editor,{state:{get:()=>state},view:{get:()=>view},isDestroyed:{get:()=>false}})
const descriptor=registry.commands().find(command=>command.id==='node.inline.insert.example.package_field')!
assert.ok(descriptor);for(const surface of ['ribbon','context','slash','block','palette'])assert.ok(descriptor.surfaces?.includes(surface as never))
const insert=prepareInlineContainerTransaction(editor,registry,'node.insert',{model:'inline',type:definition.type})!
assert.ok(insert.commit());assert.ok(state.selection instanceof NodeSelection);assert.equal(dispatches,1)
const first=selectedInlineContainer(state)!;assert.equal(first.value.schemaVersion,'hcd.extension/3')
view.dispatch(state.tr.setSelection(TextSelection.create(state.doc,first.position+1)).insertText('真实正文😀'))
view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc,first.position)))
const selected=selectedInlineContainer(state)!,update=prepareInlineContainerTransaction(editor,registry,'node.update',{instanceId:selected.value.instanceId,expected:selected.value,data:{title:'更新字段'}})!
assert.ok(update.commit());assert.equal(selectedInlineContainer(state)!.node.textContent,'真实正文😀');assert.equal(selectedInlineContainer(state)!.value.data.title,'更新字段')
const pending=prepareInlineContainerTransaction(editor,registry,'node.update',{instanceId:selected.value.instanceId,expected:selectedInlineContainer(state)!.value,data:{title:'不得写入'}})!
release();assert.equal(pending.commit(),false);assert.equal(selectedInlineContainer(state)!.value.data.title,'更新字段')
console.log('PASS packed public registration types, command descriptors, real PM insert/update and disposed commit gate')
''')
    subprocess.run([str(editor / 'node_modules/.bin/tsc'), '--outDir', str(root / 'compiled'), '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', str(consumer)], cwd=root, check=True)
    completed = subprocess.run(['node', str(root / 'compiled/consumer.mjs')], cwd=root, capture_output=True, text=True)
    (root / 'consumer.log').write_text(completed.stdout + completed.stderr)
    if completed.returncode:
        raise RuntimeError(str(root) + '\n' + completed.stdout + completed.stderr)
    (assets / 'package-consumer.mts').write_text(consumer.read_text())
    (assets / 'package-evidence.json').write_text(json.dumps({
        'scope': 'Actual local npm pack, strict TypeScript and JavaScript consumer; no publication or browser/native save claim',
        'packageSha256': hashlib.sha256((root / packed['filename']).read_bytes()).hexdigest(),
        'registrationPropsAndServiceTypes': True, 'legacyTypeRejected': True,
        'sharedProseMirrorNodeSelection': True, 'commandInsertAndUpdate': True,
        'disposedStagedCommitRefused': True, 'runtime': str(root), 'output': completed.stdout.strip(),
    }, ensure_ascii=False, indent=2) + '\n')
    print(completed.stdout.strip())


if __name__ == '__main__':
    main()
