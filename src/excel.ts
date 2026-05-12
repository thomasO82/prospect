import XLSX, { type CellObject, type WorkBook, type WorkSheet } from 'xlsx';
import type { AppConfig, LookupResult, PendingRow, WorkbookContext } from './types';

function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function normalizeComparableValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getSheetRange(sheet: WorkSheet): XLSX.Range {
  const ref = sheet['!ref'];

  if (!ref) {
    throw new Error('La feuille Excel ne contient pas de plage exploitable.');
  }

  return XLSX.utils.decode_range(ref);
}

function readCellValue(cell?: CellObject): string {
  if (!cell) {
    return '';
  }

  return String(cell.w ?? cell.v ?? '').trim();
}

function getCellAddress(rowNumber: number, columnIndex: number): string {
  return XLSX.utils.encode_cell({
    r: rowNumber - 1,
    c: columnIndex - 1,
  });
}

function getCellText(sheet: WorkSheet, rowNumber: number, columnIndex: number): string {
  return readCellValue(sheet[getCellAddress(rowNumber, columnIndex)]);
}

function setCellText(
  sheet: WorkSheet,
  rowNumber: number,
  columnIndex: number,
  value: string,
): void {
  const address = getCellAddress(rowNumber, columnIndex);
  sheet[address] = {
    t: 's',
    v: value,
  };

  const range = getSheetRange(sheet);
  range.e.r = Math.max(range.e.r, rowNumber - 1);
  range.e.c = Math.max(range.e.c, columnIndex - 1);
  sheet['!ref'] = XLSX.utils.encode_range(range);
}

function isMissingPhoneValue(value: string, missingValues: Set<string>): boolean {
  return value === '' || missingValues.has(normalizeComparableValue(value));
}

function buildHeaderMap(sheet: WorkSheet, headerRowIndex: number): Map<string, number> {
  const range = getSheetRange(sheet);
  const headerMap = new Map<string, number>();

  for (let columnIndex = range.s.c + 1; columnIndex <= range.e.c + 1; columnIndex += 1) {
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
  sheet: WorkSheet,
  headerRowIndex: number,
  headerLabel: string,
): number {
  const normalized = normalizeHeader(headerLabel);
  const existing = headerMap.get(normalized);

  if (existing) {
    return existing;
  }

  const range = getSheetRange(sheet);
  const newIndex = range.e.c + 2;
  setCellText(sheet, headerRowIndex, newIndex, headerLabel);
  headerMap.set(normalized, newIndex);

  return newIndex;
}

export class ExcelPhoneWorkbook {
  private readonly config: AppConfig;

  private workbook?: WorkBook;

  private sheet?: WorkSheet;

  private sheetName?: string;

  private companyColumnIndex = 0;

  private addressColumnIndex?: number;

  private phoneColumnIndex = 0;

  private sourceColumnIndex = 0;

  private statusColumnIndex = 0;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public async load(): Promise<WorkbookContext> {
    const workbook = XLSX.readFile(this.config.inputPath, {
      cellDates: true,
    });
    const sheetName = this.config.sheetName ?? workbook.SheetNames[0];

    if (!sheetName) {
      throw new Error('Aucune feuille trouvee dans le classeur Excel.');
    }

    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      throw new Error(`Feuille introuvable: ${sheetName}`);
    }

    const headerMap = buildHeaderMap(sheet, this.config.headerRowIndex);
    this.companyColumnIndex = requireColumnIndex(headerMap, sheetName, this.config.columns.company);
    this.phoneColumnIndex = requireColumnIndex(headerMap, sheetName, this.config.columns.phone);
    this.sourceColumnIndex = ensureColumnIndex(
      headerMap,
      sheet,
      this.config.headerRowIndex,
      this.config.columns.source,
    );
    this.statusColumnIndex = ensureColumnIndex(
      headerMap,
      sheet,
      this.config.headerRowIndex,
      this.config.columns.status,
    );

    if (this.config.columns.address) {
      this.addressColumnIndex = headerMap.get(normalizeHeader(this.config.columns.address));
    }

    const pendingRows: PendingRow[] = [];
    let totalDataRows = 0;
    const range = getSheetRange(sheet);

    for (let rowNumber = this.config.headerRowIndex + 1; rowNumber <= range.e.r + 1; rowNumber += 1) {
      const company = getCellText(sheet, rowNumber, this.companyColumnIndex);
      const currentPhone = getCellText(sheet, rowNumber, this.phoneColumnIndex);
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

      if (!isMissingPhoneValue(currentPhone, this.config.missingPhoneValues)) {
        continue;
      }

      pendingRows.push({
        rowNumber,
        company,
        address: address || undefined,
        currentPhone,
      });
    }

    this.workbook = workbook;
    this.sheet = sheet;
    this.sheetName = sheetName;

    return {
      sheetName,
      pendingRows,
      totalDataRows,
    };
  }

  public applyLookupResult(row: PendingRow, lookupResult: LookupResult): void {
    if (!this.sheet) {
      throw new Error('Le classeur n’est pas charge.');
    }

    const currentPhone = getCellText(this.sheet, row.rowNumber, this.phoneColumnIndex);

    if (isMissingPhoneValue(currentPhone, this.config.missingPhoneValues) && lookupResult.phone) {
      setCellText(this.sheet, row.rowNumber, this.phoneColumnIndex, lookupResult.phone);
    }

    setCellText(this.sheet, row.rowNumber, this.sourceColumnIndex, lookupResult.source);
    setCellText(this.sheet, row.rowNumber, this.statusColumnIndex, lookupResult.status);
  }

  public async save(): Promise<void> {
    if (!this.workbook) {
      throw new Error('Aucun classeur a sauvegarder.');
    }

    XLSX.writeFile(this.workbook, this.config.outputPath);
  }
}
