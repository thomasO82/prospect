import type { AppConfig, ContactLookupResult, LookupResult, PendingRow } from '../domain/types';
import type { ContactLookupService, PhoneLookupService, ProgressReporter, WorkbookGateway } from '../domain/ports';
import { sleep, sleepRandom } from '../shared/utils/text';

export class RobotApplication {
  private googleBlocked = false;

  private processedSinceSave = 0;

  private readonly googleMapsCache = new Map<string, LookupResult>();

  public constructor(
    private readonly config: AppConfig,
    private readonly workbook: WorkbookGateway,
    private readonly phoneFinder: PhoneLookupService,
    private readonly contactCrawler: ContactLookupService,
    private readonly progressFactory: (total: number) => ProgressReporter,
  ) {}

  public async run(): Promise<void> {
    const { pendingRows, totalDataRows, sheetName, rowsMissingPhone, rowsNeedingContact } = await this.workbook.load();
    const progress = this.progressFactory(pendingRows.length);
    progress.install();
    const log = console.log.bind(console);

    try {
      this.logStartupSummary(log, {
        sheetName,
        totalDataRows,
        rowsMissingPhone,
        rowsNeedingContact,
        pendingRowCount: pendingRows.length,
      });

      if (pendingRows.length === 0) {
        await this.workbook.save();
        log('Aucune ligne a enrichir. Une copie du fichier a tout de meme ete sauvegardee.');
        log(`Fichier sauvegarde: ${this.config.outputPath}`);
        return;
      }

      progress.update(0);
      await this.phoneFinder.init();
      await this.contactCrawler.init();
      await this.processRows(pendingRows, progress, log);
      await this.workbook.save();
      progress.update(pendingRows.length);
      progress.clear();
      log('Traitement termine.');
      log(`Fichier sauvegarde: ${this.config.outputPath}`);
    } finally {
      await this.shutdown(log);
      progress.restore();
    }
  }

  private logStartupSummary(
    log: (message: string) => void,
    summary: {
      sheetName: string;
      totalDataRows: number;
      rowsMissingPhone: number;
      rowsNeedingContact: number;
      pendingRowCount: number;
    },
  ): void {
    log(`Feuille utilisee: ${summary.sheetName}`);
    log(`Lignes de donnees detectees: ${summary.totalDataRows}`);
    log(`Lignes avec telephone vide: ${summary.rowsMissingPhone}`);
    log(`Lignes avec email/nomContact a completer: ${summary.rowsNeedingContact}`);
    log(`Traitement de toutes les lignes: ${this.config.processAllRows ? 'oui' : 'non'}`);

    if (this.config.maxRowsToProcess) {
      log(`Mode test: limite a ${this.config.maxRowsToProcess} lignes a traiter`);
    }

    log(`Lignes a traiter: ${summary.pendingRowCount}`);
    log(`Fichier de sortie: ${this.config.outputPath}`);
  }

  private async processRows(
    pendingRows: PendingRow[],
    progress: ProgressReporter,
    log: (message: string) => void,
  ): Promise<void> {
    for (let index = 0; index < pendingRows.length; index += 1) {
      const row = pendingRows[index];
      progress.update(index);
      log(`[${index + 1}/${pendingRows.length}] ligne ${row.rowNumber} -> ${row.company}${row.address ? ` | ${row.address}` : ''}`);

      let websiteUrl = row.currentWebsiteUrl || undefined;
      websiteUrl = await this.processPhoneAndWebsite(row, websiteUrl, log);
      await this.processContact(row, websiteUrl, log);
      await this.saveProgressIfNeeded(index, pendingRows.length, progress, log);
    }
  }

  private async processPhoneAndWebsite(
    row: PendingRow,
    currentWebsiteUrl: string | undefined,
    log: (message: string) => void,
  ): Promise<string | undefined> {
    const shouldUseGoogle = row.shouldUseGoogle && !this.googleBlocked;
    let websiteUrl = currentWebsiteUrl;

    log(`   raison: ${row.shouldUseGoogle ? 'telephone/site manquant' : 'donnees deja disponibles, Google evite'}`);
    log(`   Google Maps: ${shouldUseGoogle ? 'utilise' : this.googleBlocked ? 'bloque, ignore' : 'ignore'}`);

    if (shouldUseGoogle) {
      const lookupResult = await this.lookupPhoneWithCache(row, log);

      if (lookupResult.googleBlocked) {
        this.googleBlocked = true;
        log('   Google Maps: blocage detecte, arret des recherches Google pour la suite');
        this.workbook.applyContactResult(row, this.buildBlockedContactResult('CAPTCHA_DETECTED', lookupResult.errorMessage));
        await this.workbook.saveProgress();
      } else {
        this.workbook.applyLookupResult(row, lookupResult);
        websiteUrl = lookupResult.websiteUrl ?? websiteUrl;
        const suffix = lookupResult.phone ? ` | ${lookupResult.phone}` : '';
        log(`   telephone: ${row.needsPhone ? lookupResult.status : 'deja renseigne'}${suffix}`);
      }
    } else if (row.shouldUseGoogle && this.googleBlocked) {
      this.workbook.applyContactResult(row, this.buildBlockedContactResult('GOOGLE_SKIPPED'));
    }

    const websiteLabel = websiteUrl ? websiteUrl : 'aucun site disponible';
    log(`   site officiel: ${websiteLabel}`);

    if (websiteUrl) {
      log(`   domaine: ${new URL(websiteUrl).hostname.replace(/^www\./, '')}`);
    }

    return websiteUrl;
  }

  private async lookupPhoneWithCache(row: PendingRow, log: (message: string) => void): Promise<LookupResult> {
    const googleCacheKey = `${row.company.toLowerCase()}::${row.address?.toLowerCase() ?? ''}`;
    const cachedLookupResult = this.googleMapsCache.get(googleCacheKey);

    if (cachedLookupResult) {
      log('   Google Maps: resultat repris du cache');
      return cachedLookupResult;
    }

    const delay = await sleepRandom(this.config.delayMinMs, this.config.delayMaxMs);
    log(`   delai avant Google Maps: ${delay} ms`);

    const result = await this.phoneFinder.lookup(row);
    this.googleMapsCache.set(googleCacheKey, result);

    return result;
  }

  private async processContact(
    row: PendingRow,
    websiteUrl: string | undefined,
    log: (message: string) => void,
  ): Promise<void> {
    const hasExistingContact = row.currentEmail !== '' || row.currentContactName !== '';
    const shouldSearchContact = Boolean(websiteUrl && (this.config.contactLookup.forceUpdate || !hasExistingContact));

    if (shouldSearchContact && websiteUrl) {
      log('   contact: recherche rapide sur le site officiel');
      const contactResult = await this.contactCrawler.crawlCompanyWebsite(row, websiteUrl);
      this.workbook.applyContactResult(row, contactResult);
      this.logContactResult(contactResult, log);
      return;
    }

    if (websiteUrl && hasExistingContact && !this.config.contactLookup.forceUpdate) {
      log('   contact: ignore, un contact existe deja sur la ligne');
      return;
    }

    if (!websiteUrl) {
      const status = this.googleBlocked ? 'GOOGLE_SKIPPED' : 'WEBSITE_NOT_FOUND';
      this.workbook.applyContactResult(row, this.buildBlockedContactResult(status));
      log(`   scrapingStatus: ${status}`);
    }
  }

  private logContactResult(contactResult: ContactLookupResult, log: (message: string) => void): void {
    if (contactResult.visitedUrls.length > 0) {
      log(`   pages contact visitees: ${contactResult.visitedUrls.length}`);
    }

    if (contactResult.analyzedPdfUrls.length > 0) {
      log(`   PDFs analyses: ${contactResult.analyzedPdfUrls.length}`);
    }

    if (contactResult.emailsFound.length > 0) {
      log(`   emails trouves (${contactResult.emailsFound.length}):`);
      for (const email of contactResult.emailsFound) {
        log(`      - ${email}`);
      }
    } else {
      log('   emails trouves: aucun');
    }

    if (contactResult.contactNamesFound.length > 0) {
      log(`   noms detectes: ${contactResult.contactNamesFound.join(', ')}`);
    }

    if (contactResult.errorMessage) {
      log(`   contact: erreur | ${contactResult.errorMessage}`);
      return;
    }

    log(`   email retenu: ${contactResult.email ?? 'non trouve'}`);
    log(`   nomContact: ${contactResult.contactName ?? 'non trouve'}`);
    log(`   confidence: ${contactResult.confidence?.toFixed(2) ?? 'n/a'}`);
    log(`   source: ${contactResult.source ?? 'n/a'}`);
    log(`   sourceUrl: ${contactResult.sourceUrl ?? 'n/a'}`);
    log(`   scrapingStatus: ${contactResult.scrapingStatus}`);
  }

  private buildBlockedContactResult(
    scrapingStatus: ContactLookupResult['scrapingStatus'],
    errorMessage?: string,
  ): ContactLookupResult {
    return {
      scrapingStatus,
      lastCheckedAt: new Date().toISOString(),
      visitedUrls: [],
      analyzedPdfUrls: [],
      emailsFound: [],
      contactNamesFound: [],
      errorMessage,
    };
  }

  private async saveProgressIfNeeded(
    index: number,
    totalRows: number,
    progress: ProgressReporter,
    log: (message: string) => void,
  ): Promise<void> {
    this.processedSinceSave += 1;
    progress.update(index + 1);

    if (this.processedSinceSave >= this.config.contactLookup.saveEveryRows) {
      await this.workbook.saveProgress();
      this.processedSinceSave = 0;
      log(`   progression sauvegardee: ${this.config.outputPath}`);
    }

    if (
      this.config.contactLookup.pauseBetweenBatchesMs > 0
      && (index + 1) % this.config.contactLookup.batchSize === 0
      && index < totalRows - 1
    ) {
      log(`Pause entre lots: ${this.config.contactLookup.pauseBetweenBatchesMs} ms`);
      await sleep(this.config.contactLookup.pauseBetweenBatchesMs);
    }
  }

  private async shutdown(log: (message: string) => void): Promise<void> {
    if (this.config.browserCloseDelayMs > 0) {
      log(`Pause debug avant fermeture des navigateurs: ${this.config.browserCloseDelayMs} ms`);
      await sleep(this.config.browserCloseDelayMs);
    }

    await this.contactCrawler.close();
    await this.phoneFinder.close();
  }
}
