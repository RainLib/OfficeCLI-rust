export interface SpecBlock {
  block: number;
  text: string;
}

export interface SpecSplice {
  block: number;
  start: number;
  end: number;
  expected: string;
  insert: string;
}

export interface CanvasElement {
  id: string;
  type: string;
  text?: string;
  specBlocks?: readonly SpecBlock[];
}

export interface CanvasEdit {
  id: string;
  text?: string;
  dx?: number;
  dy?: number;
  strokeColor?: string;
  backgroundColor?: string;
  specSplice?: SpecSplice;
}

export interface CellEdit {
  address: string;
  value: string;
}

export interface WorkbookCell {
  address: string;
  nodeId: string;
  nodeHash: string;
  text: string;
  valueType: string;
  formula?: string | null;
  textEditable?: boolean;
  numberEditable?: boolean;
}

export interface Worksheet {
  sheetId: string;
  sheetIndex: number;
  cells: readonly WorkbookCell[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
