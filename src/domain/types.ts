export type LookupStatus = 'trouve' | 'trouvÃ©' | 'trouvé' | 'introuvable' | 'erreur' | 'ambigu';
export type ScrapingStatus =
  | 'OK'
  | 'EMAIL_NOT_FOUND'
  | 'WEBSITE_NOT_FOUND'
  | 'DOMAIN_NOT_FOUND'
  | 'CAPTCHA_DETECTED'
  | 'GOOGLE_SKIPPED'
  | 'BING_BLOCKED'
  | 'PDF_ANALYZED'
  | 'ERROR';

export interface ColumnMapping {
  company: string;
  address?: string;
  phone: string;
  websiteUrl: string;
  email: string;
  contactName: string;
  confidence: string;
  source: string;
  sourceUrl: string;
  scrapingStatus: string;
  lastCheckedAt: string;
  status: string;
}

export interface ContactLookupConfig {
  forceUpdate: boolean;
  useBingSearch: boolean;
  useHunter: boolean;
  hunterApiKey?: string;
  hunterMaxEmails: number;
  hunterTimeoutMs: number;
  batchSize: number;
  pauseBetweenBatchesMs: number;
  saveEveryRows: number;
  maxPagesPerCompany: number;
  maxBingResults: number;
  maxPdfPerCompany: number;
  searchDelayMs: number;
  timeoutMs: number;
  useAI: boolean;
  slowMode: boolean;
}

export interface AppConfig {
  inputPath: string;
  outputPath: string;
  sheetName?: string;
  maxRowsToProcess?: number;
  processAllRows: boolean;
  headerRowIndex: number;
  rowSkipRegex: RegExp;
  missingPhoneValues: Set<string>;
  headless: boolean;
  delayMinMs: number;
  delayMaxMs: number;
  navigationTimeoutMs: number;
  searchSettleMs: number;
  browserCloseDelayMs: number;
  maxAmbiguousResults: number;
  contactLookup: ContactLookupConfig;
  columns: ColumnMapping;
}

export interface LookupCandidate {
  name: string;
  url: string;
}

export interface LookupResult {
  status: LookupStatus;
  phone?: string;
  websiteUrl?: string;
  googleBlocked?: boolean;
  source: string;
  candidates?: LookupCandidate[];
  errorMessage?: string;
}

export interface PendingRow {
  rowNumber: number;
  company: string;
  address?: string;
  currentPhone: string;
  currentWebsiteUrl: string;
  currentEmail: string;
  currentContactName: string;
  currentConfidence: string;
  currentSource: string;
  currentSourceUrl: string;
  currentScrapingStatus: string;
  currentLastCheckedAt: string;
  needsPhone: boolean;
  needsWebsiteUrl: boolean;
  needsEmail: boolean;
  needsContactName: boolean;
  needsConfidence: boolean;
  needsSource: boolean;
  needsSourceUrl: boolean;
  needsScrapingStatus: boolean;
  needsLastCheckedAt: boolean;
  shouldUseGoogle: boolean;
  shouldProcessContact: boolean;
}

export interface ContactLookupResult {
  email?: string;
  contactName?: string;
  confidence?: number;
  source?: string;
  sourceUrl?: string;
  reason?: string;
  scrapingStatus: ScrapingStatus;
  lastCheckedAt?: string;
  visitedUrls: string[];
  analyzedPdfUrls: string[];
  emailsFound: string[];
  contactNamesFound: string[];
  errorMessage?: string;
}

export interface WorkbookContext {
  sheetName: string;
  pendingRows: PendingRow[];
  totalDataRows: number;
  rowsMissingPhone: number;
  rowsNeedingContact: number;
}
