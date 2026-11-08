import type {FWorkbook} from '@univerjs/preset-sheets-core'

export type WorkbookViewport={sheetId:string;row:number;column:number;zoom:number;selection?:{row:number;column:number;height:number;width:number}}

/** Capture only view state; never include or replay cell values. */
export function captureWorkbookViewport(workbook:FWorkbook):WorkbookViewport|null{
 try{
  const sheet=workbook.getActiveSheet(),visible=sheet.getVisibleRange(),range=workbook.getActiveRange()
  if(!visible)return null
  const selection=range?{row:range.getRow(),column:range.getColumn(),height:range.getHeight(),width:range.getWidth()}:undefined
  return {sheetId:sheet.getSheetId(),row:visible.startRow,column:visible.startColumn,zoom:sheet.getZoom(),selection}
 }catch{return null}
}

export function restoreWorkbookViewport(workbook:FWorkbook,viewport:WorkbookViewport):boolean{
 const sheet=workbook.getSheetBySheetId(viewport.sheetId)
 if(!sheet)return false
 workbook.setActiveSheet(sheet)
 if(Number.isFinite(viewport.zoom)&&viewport.zoom>0)sheet.zoom(viewport.zoom)
 const selection=viewport.selection
 if(selection&&selection.row>=0&&selection.column>=0&&selection.height>0&&selection.width>0&&selection.row+selection.height<=sheet.getMaxRows()&&selection.column+selection.width<=sheet.getMaxColumns())sheet.setActiveRange(sheet.getRange(selection.row,selection.column,selection.height,selection.width))
 sheet.scrollToCell(Math.min(Math.max(0,viewport.row),sheet.getMaxRows()-1),Math.min(Math.max(0,viewport.column),sheet.getMaxColumns()-1))
 return true
}
