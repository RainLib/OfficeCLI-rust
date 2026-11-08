import {test} from 'node:test'
import assert from 'node:assert/strict'
import {hasProtectedSheetReadOnly,hasStoredBlankMappingLimit,type HcdManifest} from '../../xlsx-univer-viewer/src/hcd.ts'

test('only the recognized stored-blank limit produces the persistent workbook warning',()=>{
 const manifest={schemaVersion:'hcd/2',profile:'grid',warnings:[{code:'XLSX_STORED_BLANK_MAPPING_LIMIT'}]} as HcdManifest
 assert.equal(hasStoredBlankMappingLimit(manifest),true)
 assert.equal(hasStoredBlankMappingLimit({...manifest,warnings:[{code:'other'}]}),false)
 assert.equal(hasStoredBlankMappingLimit({...manifest,warnings:undefined}),false)
})

test('only imported worksheet protection emits the read-only warning',()=>{
 const manifest={schemaVersion:'hcd/2',profile:'grid',warnings:[{code:'XLSX_PROTECTED_SHEET_READ_ONLY'}]} as HcdManifest
 assert.equal(hasProtectedSheetReadOnly(manifest),true)
 assert.equal(hasProtectedSheetReadOnly({...manifest,warnings:[{code:'other'}]}),false)
 assert.equal(hasProtectedSheetReadOnly({...manifest,warnings:undefined}),false)
})
