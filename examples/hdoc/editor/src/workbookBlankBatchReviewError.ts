import {ApiError} from './api.ts'
import type {MessageKey} from './i18n.tsx'

/** Only server-classified target failures are called conflicts. A failed
 * network call or an unrecognized response says nothing about occupancy. */
export function batchReviewError(error:unknown):MessageKey{
 if(error instanceof Error&&error.message==='blank batch head changed')return 'workbookBatchReviewChanged'
 if(!(error instanceof ApiError))return 'workbookBatchReviewFailed'
 if(error.status===409&&error.code==='XLSX_CELL_ALREADY_MAPPED')return 'workbookBatchReviewOccupied'
 if(error.status===409&&error.code==='XLSX_GRID_HEAD_CHANGED')return 'workbookBatchReviewChanged'
 if(error.status===422&&(error.code==='XLSX_FORMULA_READ_ONLY'||error.code==='XLSX_MERGED_CELL_READ_ONLY'||error.code==='XLSX_VIRTUAL_MERGE_ANCHOR_UNSUPPORTED'||error.code==='XLSX_SHEET_PROTECTED'))return 'workbookBatchReviewProtected'
 if(error.status===422&&(error.code==='XLSX_SOURCE_CHANGED'||error.code==='XLSX_SOURCE_REQUIRED'))return 'workbookBatchReviewSource'
 return 'workbookBatchReviewFailed'
}
