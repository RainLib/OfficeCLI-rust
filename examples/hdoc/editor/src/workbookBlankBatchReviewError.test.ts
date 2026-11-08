import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ApiError} from './api.ts'
import {batchReviewError} from './workbookBlankBatchReviewError.ts'

test('only validated server codes identify an occupied, changed or protected batch target',()=>{
 const issue=(code:string,status=409)=>new ApiError(status,JSON.stringify({error:code}))
 assert.equal(batchReviewError(issue('XLSX_CELL_ALREADY_MAPPED')),'workbookBatchReviewOccupied')
 assert.equal(batchReviewError(issue('XLSX_GRID_HEAD_CHANGED')),'workbookBatchReviewChanged')
 assert.equal(batchReviewError(issue('XLSX_SHEET_PROTECTED',422)),'workbookBatchReviewProtected')
 assert.equal(batchReviewError(issue('XLSX_SOURCE_REQUIRED',422)),'workbookBatchReviewSource')
 assert.equal(batchReviewError(issue('XLSX_CELL_ALREADY_MAPPED',503)),'workbookBatchReviewFailed')
 assert.equal(batchReviewError(new TypeError('network unavailable')),'workbookBatchReviewFailed')
 assert.equal(batchReviewError(new ApiError(503,'occupied')),'workbookBatchReviewFailed')
 assert.equal(batchReviewError(issue('UNKNOWN_STATUS')),'workbookBatchReviewFailed')
})
