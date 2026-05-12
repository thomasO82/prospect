export type LookupStatus = 'trouvé' | 'introuvable' | 'erreur' | 'ambigu';

export interface ColumnMapping {
  company: string;
  address?: string;
  phone: string;
  source: string;
  status: string;
}

export interface AppConfig {
  inputPath: string;
  outputPath: string;
  sheetName?: string;
  headerRowIndex: number;
  rowSkipRegex: RegExp;
  missingPhoneValues: Set<string>;
  headless: boolean;
  delayMinMs: number;
  delayMaxMs: number;
  navigationTimeoutMs: number;
  searchSettleMs: number;
  maxAmbiguousResults: number;
  columns: ColumnMapping;
}

export interface LookupCandidate {
  name: string;
  url: string;
}

export interface LookupResult {
  status: LookupStatus;
  phone?: string;
  source: string;
  candidates?: LookupCandidate[];
  errorMessage?: string;
}

export interface PendingRow {
  rowNumber: number;
  company: string;
  address?: string;
  currentPhone: string;
}

export interface WorkbookContext {
  sheetName: string;
  pendingRows: PendingRow[];
  totalDataRows: number;
}
