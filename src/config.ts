import path from 'node:path';
import dotenv from 'dotenv';
import type { AppConfig } from './types';

dotenv.config();

interface CliArgs {
  input?: string;
  output?: string;
  sheet?: string;
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
  const delayMinMs = parseInteger(process.env.DELAY_MIN_MS, 2500);
  const delayMaxMs = parseInteger(process.env.DELAY_MAX_MS, 5000);

  return {
    inputPath,
    outputPath,
    sheetName: sheetName || undefined,
    headerRowIndex: parseInteger(process.env.HEADER_ROW_INDEX, 1),
    rowSkipRegex: new RegExp(process.env.ROW_SKIP_REGEX ?? '^\\s*[-–—]{2,}'),
    missingPhoneValues: parseMissingPhoneValues(process.env.MISSING_PHONE_VALUES),
    headless: parseBoolean(process.env.HEADLESS, false),
    delayMinMs,
    delayMaxMs: delayMaxMs < delayMinMs ? delayMinMs : delayMaxMs,
    navigationTimeoutMs: parseInteger(process.env.NAVIGATION_TIMEOUT_MS, 30000),
    searchSettleMs: parseInteger(process.env.SEARCH_SETTLE_MS, 4000),
    maxAmbiguousResults: parseInteger(process.env.MAX_AMBIGUOUS_RESULTS, 5),
    columns: {
      company: process.env.COLUMN_COMPANY ?? 'Entreprise',
      address: process.env.COLUMN_ADDRESS ?? 'Adresse',
      phone: process.env.COLUMN_PHONE ?? 'Téléphone',
      source:
        process.env.COLUMN_SOURCE ?? 'Source / vérification téléphone-contact',
      status: process.env.COLUMN_STATUS ?? 'statut',
    },
  };
}
