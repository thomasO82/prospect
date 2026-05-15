import path from 'node:path';
import dotenv from 'dotenv';
import type { AppConfig } from '../domain/types';

dotenv.config();

interface CliArgs {
  input?: string;
  output?: string;
  sheet?: string;
  limit?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const cli: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextToken = argv[index + 1];

    if (!nextToken) {
      continue;
    }

    if (token === '--input') {
      cli.input = nextToken;
    }

    if (token === '--output') {
      cli.output = nextToken;
    }

    if (token === '--sheet') {
      cli.sheet = nextToken;
    }

    if (token === '--limit') {
      const parsedLimit = Number.parseInt(nextToken, 10);

      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        cli.limit = parsedLimit;
      }
    }
  }

  return cli;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isNaN(parsed) ? fallback : parsed;
}

function clampTimeout(value: number, max: number): number {
  return value > max ? max : value;
}

function normalizeComparableValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function parseMissingPhoneValues(value: string | undefined): Set<string> {
  const entries = value?.split('|').map((entry) => entry.trim()).filter(Boolean) ?? [
    'Non trouvé publiquement',
  ];

  return new Set(entries.map(normalizeComparableValue));
}

function buildDefaultOutputPath(inputPath: string): string {
  const parsed = path.parse(inputPath);

  return path.join(parsed.dir, `${parsed.name}_enrichi${parsed.ext || '.xlsx'}`);
}

export function loadConfig(argv: string[]): AppConfig {
  const maxPageTimeoutMs = 5000;
  const cli = parseArgs(argv);
  const inputPath = cli.input ?? process.env.INPUT_XLSX;

  if (!inputPath) {
    throw new Error(
      'Aucun fichier Excel en entree. Passez --input "/chemin/fichier.xlsx" ou renseignez INPUT_XLSX dans .env.',
    );
  }

  const outputPath = cli.output ?? process.env.OUTPUT_XLSX ?? buildDefaultOutputPath(inputPath);

  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error('Le fichier de sortie doit etre different du fichier source.');
  }

  const sheetName = cli.sheet ?? process.env.SHEET_NAME ?? undefined;
  const delayMinMs = parseInteger(process.env.DELAY_MIN_MS, 1000);
  const delayMaxMs = parseInteger(process.env.DELAY_MAX_MS, 2500);
  const maxRowsToProcess = cli.limit ?? parseInteger(process.env.MAX_ROWS_TO_PROCESS, 0);
  const navigationTimeoutMs = clampTimeout(parseInteger(process.env.NAVIGATION_TIMEOUT_MS, 30000), maxPageTimeoutMs);
  const contactTimeoutMs = clampTimeout(parseInteger(process.env.CONTACT_TIMEOUT_MS, 4000), maxPageTimeoutMs);

  return {
    inputPath,
    outputPath,
    sheetName: sheetName || undefined,
    maxRowsToProcess: maxRowsToProcess > 0 ? maxRowsToProcess : undefined,
    processAllRows: parseBoolean(process.env.PROCESS_ALL_ROWS, true),
    headerRowIndex: parseInteger(process.env.HEADER_ROW_INDEX, 1),
    rowSkipRegex: new RegExp(process.env.ROW_SKIP_REGEX ?? '^\\s*[-–—]{2,}'),
    missingPhoneValues: parseMissingPhoneValues(process.env.MISSING_PHONE_VALUES),
    headless: parseBoolean(process.env.HEADLESS, false),
    delayMinMs,
    delayMaxMs: delayMaxMs < delayMinMs ? delayMinMs : delayMaxMs,
    navigationTimeoutMs,
    searchSettleMs: parseInteger(process.env.SEARCH_SETTLE_MS, 4000),
    browserCloseDelayMs: parseInteger(process.env.BROWSER_CLOSE_DELAY_MS, 0),
    maxAmbiguousResults: parseInteger(process.env.MAX_AMBIGUOUS_RESULTS, 5),
    contactLookup: {
      forceUpdate: parseBoolean(process.env.FORCE_UPDATE, false),
      useBingSearch: parseBoolean(process.env.USE_BING_SEARCH, false),
      useHunter: parseBoolean(process.env.USE_HUNTER, false),
      hunterApiKey: process.env.HUNTER_API_KEY || undefined,
      hunterMaxEmails: parseInteger(process.env.HUNTER_MAX_EMAILS, 10),
      hunterTimeoutMs: parseInteger(process.env.HUNTER_TIMEOUT_MS, 15000),
      batchSize: parseInteger(process.env.BATCH_SIZE, 50),
      pauseBetweenBatchesMs: parseInteger(process.env.PAUSE_BETWEEN_BATCHES_MS, 0),
      saveEveryRows: parseInteger(process.env.SAVE_EVERY_ROWS, 5),
      maxPagesPerCompany: parseInteger(process.env.MAX_PAGES_PER_COMPANY, 4),
      maxBingResults: parseInteger(process.env.MAX_BING_RESULTS, 2),
      maxPdfPerCompany: parseInteger(process.env.MAX_PDF_PER_COMPANY, 0),
      searchDelayMs: parseInteger(process.env.SEARCH_DELAY_MS, 0),
      timeoutMs: contactTimeoutMs,
      useAI: parseBoolean(process.env.USE_AI, false),
      slowMode: parseBoolean(process.env.SLOW_MODE, false),
    },
    columns: {
      company: process.env.COLUMN_COMPANY ?? 'Entreprise',
      address: process.env.COLUMN_ADDRESS ?? 'Adresse',
      phone: process.env.COLUMN_PHONE ?? 'Téléphone',
      websiteUrl: process.env.COLUMN_WEBSITE_URL ?? 'websiteUrl',
      email: process.env.COLUMN_EMAIL ?? 'email',
      contactName: process.env.COLUMN_CONTACT_NAME ?? 'nomContact',
      confidence: process.env.COLUMN_CONFIDENCE ?? 'confidence',
      source:
        process.env.COLUMN_SOURCE ?? 'Source / vérification téléphone-contact',
      sourceUrl: process.env.COLUMN_SOURCE_URL ?? 'sourceUrl',
      scrapingStatus: process.env.COLUMN_SCRAPING_STATUS ?? 'scrapingStatus',
      lastCheckedAt: process.env.COLUMN_LAST_CHECKED_AT ?? 'lastCheckedAt',
      status: process.env.COLUMN_STATUS ?? 'statut',
    },
  };
}
