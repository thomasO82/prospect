import ExcelJS, { type Cell, type Workbook, type Worksheet } from 'exceljs';
import type { AppConfig, ContactLookupResult, LookupResult, PendingRow, WorkbookContext } from '../../domain/types';

const DESCRIPTION_ROW_INDEX = 2;

const COLUMN_DESCRIPTIONS = {
  websiteUrl: 'Site officiel utilise comme base pour enrichir telephone, email et contact.',
  email: 'Emails trouves pour l entreprise, un par ligne quand plusieurs adresses sont detectees.',
  contactName: 'Nom du contact detecte sur le site officiel, une page equipe, des mentions legales ou une source fiable.',
  confidence: 'Score de confiance entre 0 et 1 pour l email retenu.',
  source: 'Origine du resultat retenu: Google Maps, site officiel, Bing, Hunter, PDF ou email probable.',
  sourceUrl: 'URL exacte ou source ayant permis de retenir le contact.',
  scrapingStatus: 'Statut technique du crawl: OK, EMAIL_NOT_FOUND, CAPTCHA_DETECTED, BING_BLOCKED, etc.',
  lastCheckedAt: 'Date ISO de la derniere verification effectuee par le robot.',
  status: 'Statut de recherche telephone principal pour la ligne.',
};

function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function normalizeComparableValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function readCellValue(cell?: Cell): string {
  if (!cell) {
    return '';
  }

  return cell.text.trim();
}

function cloneCellStyle(source: Cell, target: Cell): void {
  if (Object.keys(target.style).length > 0 || Object.keys(source.style).length === 0) {
    return;
  }

  target.style = JSON.parse(JSON.stringify(source.style)) as Cell['style'];
}

function setCellText(
  sheet: Worksheet,
  rowNumber: number,
  columnIndex: number,
  value: string,
  styleSourceColumnIndex?: number,
): void {
  const cell = sheet.getCell(rowNumber, columnIndex);

  if (styleSourceColumnIndex) {
    cloneCellStyle(sheet.getCell(rowNumber, styleSourceColumnIndex), cell);
  }

  cell.value = value;
}

function getCellText(sheet: Worksheet, rowNumber: number, columnIndex: number): string {
  return readCellValue(sheet.getCell(rowNumber, columnIndex));
}

function isMissingPhoneValue(value: string, missingValues: Set<string>): boolean {
  return value === '' || missingValues.has(normalizeComparableValue(value));
}

function formatEmailsForCell(contactResult: ContactLookupResult): string | undefined {
  const emails = contactResult.emailsFound.length > 0
    ? contactResult.emailsFound
    : contactResult.email
      ? [contactResult.email]
      : [];
  const uniqueEmails = Array.from(new Set(emails.map((email) => email.trim()).filter(Boolean)));

  if (uniqueEmails.length === 0) {
    return undefined;
  }

  return uniqueEmails.join('\n');
}

function buildHeaderMap(sheet: Worksheet, headerRowIndex: number): Map<string, number> {
  const headerMap = new Map<string, number>();
  const headerRow = sheet.getRow(headerRowIndex);
  const lastColumnIndex = Math.max(headerRow.cellCount, sheet.columnCount);

  for (let columnIndex = 1; columnIndex <= lastColumnIndex; columnIndex += 1) {
    const headerValue = getCellText(sheet, headerRowIndex, columnIndex);

    if (headerValue) {
      headerMap.set(normalizeHeader(headerValue), columnIndex);
    }
  }

  return headerMap;
}

function requireColumnIndex(
  headerMap: Map<string, number>,
  sheetName: string,
  headerLabel: string,
): number {
  const found = headerMap.get(normalizeHeader(headerLabel));

  if (found) {
    return found;
  }

  const availableHeaders = Array.from(headerMap.keys()).join(', ');

  throw new Error(
    `Colonne introuvable: "${headerLabel}". Colonnes detectees dans la feuille "${sheetName}": ${availableHeaders}`,
  );
}

function ensureColumnIndex(
  headerMap: Map<string, number>,
  sheet: Worksheet,
  headerRowIndex: number,
  headerLabel: string,
  description: string,
): number {
  const normalized = normalizeHeader(headerLabel);
  const existing = headerMap.get(normalized);

  if (existing) {
    ensureColumnDescription(sheet, existing, description, headerRowIndex);
    return existing;
  }

  const headerRow = sheet.getRow(headerRowIndex);
  const newIndex = Math.max(headerRow.cellCount, sheet.columnCount) + 1;
  setCellText(sheet, headerRowIndex, newIndex, headerLabel, newIndex - 1);
  ensureColumnDescription(sheet, newIndex, description, headerRowIndex);
  headerMap.set(normalized, newIndex);

  return newIndex;
}

function ensureColumnDescription(
  sheet: Worksheet,
  columnIndex: number,
  description: string,
  headerRowIndex: number,
): void {
  if (headerRowIndex === DESCRIPTION_ROW_INDEX) {
    return;
  }

  const currentDescription = getCellText(sheet, DESCRIPTION_ROW_INDEX, columnIndex);

  if (currentDescription !== '') {
    return;
  }

  setCellText(sheet, DESCRIPTION_ROW_INDEX, columnIndex, description, columnIndex > 1 ? columnIndex - 1 : undefined);
  sheet.getCell(DESCRIPTION_ROW_INDEX, columnIndex).alignment = {
    ...sheet.getCell(DESCRIPTION_ROW_INDEX, columnIndex).alignment,
    wrapText: true,
    vertical: 'top',
  };
}

function ensureExcelColumns(
  headerMap: Map<string, number>,
  sheet: Worksheet,
  config: AppConfig,
): {
  emailColumnIndex: number;
  websiteUrlColumnIndex: number;
  contactNameColumnIndex: number;
  confidenceColumnIndex: number;
  sourceColumnIndex: number;
  sourceUrlColumnIndex: number;
  scrapingStatusColumnIndex: number;
  lastCheckedAtColumnIndex: number;
  statusColumnIndex: number;
} {
  const websiteUrlColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.websiteUrl,
    COLUMN_DESCRIPTIONS.websiteUrl,
  );
  const emailColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.email,
    COLUMN_DESCRIPTIONS.email,
  );
  const contactNameColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.contactName,
    COLUMN_DESCRIPTIONS.contactName,
  );
  const confidenceColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.confidence,
    COLUMN_DESCRIPTIONS.confidence,
  );
  const sourceColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.source,
    COLUMN_DESCRIPTIONS.source,
  );
  const sourceUrlColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.sourceUrl,
    COLUMN_DESCRIPTIONS.sourceUrl,
  );
  const scrapingStatusColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.scrapingStatus,
    COLUMN_DESCRIPTIONS.scrapingStatus,
  );
  const lastCheckedAtColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.lastCheckedAt,
    COLUMN_DESCRIPTIONS.lastCheckedAt,
  );
  const statusColumnIndex = ensureColumnIndex(
    headerMap,
    sheet,
    config.headerRowIndex,
    config.columns.status,
    COLUMN_DESCRIPTIONS.status,
  );

  return {
    websiteUrlColumnIndex,
    emailColumnIndex,
    contactNameColumnIndex,
    confidenceColumnIndex,
    sourceColumnIndex,
    sourceUrlColumnIndex,
    scrapingStatusColumnIndex,
    lastCheckedAtColumnIndex,
    statusColumnIndex,
  };
}

function shouldProcessRow(config: AppConfig, values: {
  currentPhone: string;
  currentWebsiteUrl: string;
  currentEmail: string;
  currentContactName: string;
  currentSourceUrl: string;
  currentScrapingStatus: string;
}, missingPhoneValues: Set<string>): boolean {
  if (config.contactLookup.forceUpdate) {
    return true;
  }

  const hasOkStatus = values.currentScrapingStatus === 'OK';
  const hasCoreContactData = values.currentWebsiteUrl !== '' && values.currentEmail !== '' && values.currentSourceUrl !== '';
  const needsPhone = isMissingPhoneValue(values.currentPhone, missingPhoneValues);

  if (hasOkStatus && hasCoreContactData && !needsPhone) {
    return false;
  }

  return config.processAllRows || needsPhone || values.currentWebsiteUrl === '' || values.currentEmail === '' || values.currentContactName === '';
}

export class ExcelPhoneWorkbook {
  private readonly config: AppConfig;

  private workbook?: Workbook;

  private sheet?: Worksheet;

  private sheetName?: string;

  private companyColumnIndex = 0;

  private addressColumnIndex?: number;

  private phoneColumnIndex = 0;

  private websiteUrlColumnIndex = 0;

  private emailColumnIndex = 0;

  private contactNameColumnIndex = 0;

  private confidenceColumnIndex = 0;

  private sourceColumnIndex = 0;

  private sourceUrlColumnIndex = 0;

  private scrapingStatusColumnIndex = 0;

  private lastCheckedAtColumnIndex = 0;

  private statusColumnIndex = 0;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public async load(): Promise<WorkbookContext> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(this.config.inputPath);
    const sheetName = this.config.sheetName ?? workbook.worksheets[0]?.name;

    if (!sheetName) {
      throw new Error('Aucune feuille trouvee dans le classeur Excel.');
    }

    const sheet = workbook.getWorksheet(sheetName);

    if (!sheet) {
      throw new Error(`Feuille introuvable: ${sheetName}`);
    }

    const headerMap = buildHeaderMap(sheet, this.config.headerRowIndex);
    this.companyColumnIndex = requireColumnIndex(headerMap, sheetName, this.config.columns.company);
    this.phoneColumnIndex = requireColumnIndex(headerMap, sheetName, this.config.columns.phone);
    const ensuredColumns = ensureExcelColumns(headerMap, sheet, this.config);
    this.websiteUrlColumnIndex = ensuredColumns.websiteUrlColumnIndex;
    this.emailColumnIndex = ensuredColumns.emailColumnIndex;
    this.contactNameColumnIndex = ensuredColumns.contactNameColumnIndex;
    this.confidenceColumnIndex = ensuredColumns.confidenceColumnIndex;
    this.sourceColumnIndex = ensuredColumns.sourceColumnIndex;
    this.sourceUrlColumnIndex = ensuredColumns.sourceUrlColumnIndex;
    this.scrapingStatusColumnIndex = ensuredColumns.scrapingStatusColumnIndex;
    this.lastCheckedAtColumnIndex = ensuredColumns.lastCheckedAtColumnIndex;
    this.statusColumnIndex = ensuredColumns.statusColumnIndex;

    if (this.config.columns.address) {
      this.addressColumnIndex = headerMap.get(normalizeHeader(this.config.columns.address));
    }

    const pendingRows: PendingRow[] = [];
    let totalDataRows = 0;
    let rowsMissingPhone = 0;
    let rowsNeedingContact = 0;

    const firstRowToProcess = Math.max(this.config.headerRowIndex + 1, 3);

    for (let rowNumber = firstRowToProcess; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const company = getCellText(sheet, rowNumber, this.companyColumnIndex);
      const currentPhone = getCellText(sheet, rowNumber, this.phoneColumnIndex);
      const currentWebsiteUrl = getCellText(sheet, rowNumber, this.websiteUrlColumnIndex);
      const currentEmail = getCellText(sheet, rowNumber, this.emailColumnIndex);
      const currentContactName = getCellText(sheet, rowNumber, this.contactNameColumnIndex);
      const currentConfidence = getCellText(sheet, rowNumber, this.confidenceColumnIndex);
      const currentSource = getCellText(sheet, rowNumber, this.sourceColumnIndex);
      const currentSourceUrl = getCellText(sheet, rowNumber, this.sourceUrlColumnIndex);
      const currentScrapingStatus = getCellText(sheet, rowNumber, this.scrapingStatusColumnIndex);
      const currentLastCheckedAt = getCellText(sheet, rowNumber, this.lastCheckedAtColumnIndex);
      const address = this.addressColumnIndex
        ? getCellText(sheet, rowNumber, this.addressColumnIndex)
        : undefined;

      if (!company) {
        continue;
      }

      if (this.config.rowSkipRegex.test(company)) {
        continue;
      }

      totalDataRows += 1;

      const needsPhone = isMissingPhoneValue(currentPhone, this.config.missingPhoneValues);
      const needsWebsiteUrl = this.config.contactLookup.forceUpdate || currentWebsiteUrl === '';
      const needsEmail = this.config.contactLookup.forceUpdate || currentEmail === '';
      const needsContactName = this.config.contactLookup.forceUpdate || currentContactName === '';
      const needsConfidence = this.config.contactLookup.forceUpdate || currentConfidence === '';
      const needsSource = this.config.contactLookup.forceUpdate || currentSource === '';
      const needsSourceUrl = this.config.contactLookup.forceUpdate || currentSourceUrl === '';
      const needsScrapingStatus = this.config.contactLookup.forceUpdate || currentScrapingStatus === '';
      const needsLastCheckedAt = this.config.contactLookup.forceUpdate || currentLastCheckedAt === '';

      if (needsPhone) {
        rowsMissingPhone += 1;
      }

      if (needsEmail || needsContactName || needsConfidence || needsSource || needsSourceUrl || needsScrapingStatus) {
        rowsNeedingContact += 1;
      }

      if (!shouldProcessRow(this.config, {
        currentPhone,
        currentWebsiteUrl,
        currentEmail,
        currentContactName,
        currentSourceUrl,
        currentScrapingStatus,
      }, this.config.missingPhoneValues)) {
        continue;
      }

      const shouldUseGoogle = needsPhone || needsWebsiteUrl;

      pendingRows.push({
        rowNumber,
        company,
        address: address || undefined,
        currentPhone,
        currentWebsiteUrl,
        currentEmail,
        currentContactName,
        currentConfidence,
        currentSource,
        currentSourceUrl,
        currentScrapingStatus,
        currentLastCheckedAt,
        needsPhone,
        needsWebsiteUrl,
        needsEmail,
        needsContactName,
        needsConfidence,
        needsSource,
        needsSourceUrl,
        needsScrapingStatus,
        needsLastCheckedAt,
        shouldUseGoogle,
        shouldProcessContact: this.config.processAllRows || needsEmail || needsContactName || needsConfidence || needsSource || needsSourceUrl || needsScrapingStatus,
      });

      if (this.config.maxRowsToProcess && pendingRows.length >= this.config.maxRowsToProcess) {
        break;
      }
    }

    this.workbook = workbook;
    this.sheet = sheet;
    this.sheetName = sheetName;

    return {
      sheetName,
      pendingRows,
      totalDataRows,
      rowsMissingPhone,
      rowsNeedingContact,
    };
  }

  public applyLookupResult(row: PendingRow, lookupResult: LookupResult): void {
    if (!this.sheet) {
      throw new Error('Le classeur n’est pas charge.');
    }

    const currentPhone = getCellText(this.sheet, row.rowNumber, this.phoneColumnIndex);
    const currentSource = getCellText(this.sheet, row.rowNumber, this.sourceColumnIndex);

    if (isMissingPhoneValue(currentPhone, this.config.missingPhoneValues) && lookupResult.phone) {
      setCellText(this.sheet, row.rowNumber, this.phoneColumnIndex, lookupResult.phone);
    }

    const currentWebsiteUrl = getCellText(this.sheet, row.rowNumber, this.websiteUrlColumnIndex);

    if ((this.config.contactLookup.forceUpdate || currentWebsiteUrl === '') && lookupResult.websiteUrl) {
      setCellText(this.sheet, row.rowNumber, this.websiteUrlColumnIndex, lookupResult.websiteUrl, this.phoneColumnIndex);
    }

    if (
      currentSource === '' &&
      !row.needsEmail &&
      !row.needsContactName &&
      !row.needsConfidence &&
      !row.needsSource &&
      !row.needsSourceUrl &&
      !row.needsScrapingStatus
    ) {
      setCellText(this.sheet, row.rowNumber, this.sourceColumnIndex, lookupResult.source, this.phoneColumnIndex);
    }

    setCellText(this.sheet, row.rowNumber, this.statusColumnIndex, lookupResult.status, this.sourceColumnIndex);
  }

  public applyContactResult(row: PendingRow, contactResult: ContactLookupResult): void {
    if (!this.sheet) {
      throw new Error('Le classeur n’est pas charge.');
    }

    const forceUpdate = this.config.contactLookup.forceUpdate;
    const currentEmail = getCellText(this.sheet, row.rowNumber, this.emailColumnIndex);
    const currentContactName = getCellText(this.sheet, row.rowNumber, this.contactNameColumnIndex);
    const currentConfidence = getCellText(this.sheet, row.rowNumber, this.confidenceColumnIndex);
    const currentSource = getCellText(this.sheet, row.rowNumber, this.sourceColumnIndex);
    const currentSourceUrl = getCellText(this.sheet, row.rowNumber, this.sourceUrlColumnIndex);
    const currentScrapingStatus = getCellText(this.sheet, row.rowNumber, this.scrapingStatusColumnIndex);
    const currentLastCheckedAt = getCellText(this.sheet, row.rowNumber, this.lastCheckedAtColumnIndex);

    const emailCellValue = formatEmailsForCell(contactResult);

    if ((forceUpdate || currentEmail === '') && emailCellValue) {
      setCellText(this.sheet, row.rowNumber, this.emailColumnIndex, emailCellValue, this.phoneColumnIndex);
      this.sheet.getCell(row.rowNumber, this.emailColumnIndex).alignment = {
        ...this.sheet.getCell(row.rowNumber, this.emailColumnIndex).alignment,
        wrapText: true,
      };
    }

    if ((forceUpdate || currentContactName === '') && contactResult.contactName) {
      setCellText(
        this.sheet,
        row.rowNumber,
        this.contactNameColumnIndex,
        contactResult.contactName,
        this.emailColumnIndex,
      );
    }

    if ((forceUpdate || currentConfidence === '') && contactResult.confidence !== undefined) {
      setCellText(
        this.sheet,
        row.rowNumber,
        this.confidenceColumnIndex,
        contactResult.confidence.toFixed(2),
        this.contactNameColumnIndex,
      );
    }

    if ((forceUpdate || currentSource === '') && contactResult.source) {
      setCellText(this.sheet, row.rowNumber, this.sourceColumnIndex, contactResult.source, this.confidenceColumnIndex);
    }

    if ((forceUpdate || currentSourceUrl === '') && contactResult.sourceUrl) {
      setCellText(this.sheet, row.rowNumber, this.sourceUrlColumnIndex, contactResult.sourceUrl, this.sourceColumnIndex);
    }

    if (forceUpdate || currentScrapingStatus === '') {
      setCellText(
        this.sheet,
        row.rowNumber,
        this.scrapingStatusColumnIndex,
        contactResult.scrapingStatus,
        this.sourceUrlColumnIndex,
      );
    }

    if (forceUpdate || currentLastCheckedAt === '') {
      setCellText(
        this.sheet,
        row.rowNumber,
        this.lastCheckedAtColumnIndex,
        contactResult.lastCheckedAt ?? new Date().toISOString(),
        this.scrapingStatusColumnIndex,
      );
    }
  }

  public updateExcelRow(row: PendingRow, contactResult: ContactLookupResult): void {
    this.applyContactResult(row, contactResult);
  }

  public async saveProgress(): Promise<void> {
    await this.save();
  }

  public async save(): Promise<void> {
    if (!this.workbook) {
      throw new Error('Aucun classeur a sauvegarder.');
    }

    await this.workbook.xlsx.writeFile(this.config.outputPath);
  }
}
