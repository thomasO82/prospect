import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AppConfig, LookupCandidate, LookupResult, PendingRow } from './types';
import { compactWhitespace, extractPhoneFromText, formatAmbiguousCandidates, sleep } from './utils';

const CONSENT_BUTTON_LABELS = [
  'Tout accepter',
  'Accepter tout',
  'Accept all',
  'I agree',
  'J’accepte',
  "J'accepte",
];

const PHONE_SELECTORS = [
  'button[data-item-id^="phone:tel:"]',
  'a[href^="tel:"]',
  'button[aria-label*="Téléphone"]',
  'button[aria-label*="Phone"]',
  'div[data-item-id^="phone:tel:"]',
];

export class GoogleMapsPhoneFinder {
  private readonly config: AppConfig;

  private browser?: Browser;

  private context?: BrowserContext;

  private page?: Page;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
    });

    this.context = await this.browser.newContext({
      locale: 'fr-FR',
      viewport: { width: 1440, height: 960 },
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.navigationTimeoutMs);
  }

  public async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }

  public async lookup(row: PendingRow): Promise<LookupResult> {
    if (!this.page) {
      throw new Error('Le navigateur Playwright n’a pas ete initialise.');
    }

    const query = [row.company, row.address].filter(Boolean).join(', ');
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

    try {
      await this.page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
      });

      await this.handleConsentIfNeeded();
      await this.page.waitForTimeout(this.config.searchSettleMs);

      if (await this.isPlaceDetailsView()) {
        const directResult = await this.extractPhoneFromCurrentPlace(searchUrl);

        if (directResult) {
          return directResult;
        }

        return {
          status: 'introuvable',
          source: `Google Maps | fiche directe sans telephone detecte | ${this.page.url()} | recherche: ${searchUrl}`,
        };
      }

      const candidates = await this.collectCandidates();

      if (candidates.length === 0) {
        return {
          status: 'introuvable',
          source: `Google Maps | aucun resultat exploitable | ${searchUrl}`,
        };
      }

      if (candidates.length > 1) {
        return {
          status: 'ambigu',
          source: `Google Maps | plusieurs resultats | ${searchUrl} | ${formatAmbiguousCandidates(candidates)}`,
          candidates,
        };
      }

      const candidate = candidates[0];

      await this.page.goto(candidate.url, {
        waitUntil: 'domcontentloaded',
      });

      await this.page.waitForTimeout(this.config.searchSettleMs);
      const singleResult = await this.extractPhoneFromCurrentPlace(searchUrl, candidate);

      if (singleResult) {
        return singleResult;
      }

      return {
        status: 'introuvable',
        source: `Google Maps | fiche sans telephone detecte | ${this.page.url()}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        status: 'erreur',
        source: `Google Maps | erreur | ${searchUrl}`,
        errorMessage: message,
      };
    }
  }

  public async pauseBetweenRows(delayMs: number): Promise<void> {
    await sleep(delayMs);
  }

  private async handleConsentIfNeeded(): Promise<void> {
    if (!this.page) {
      return;
    }

    for (const label of CONSENT_BUTTON_LABELS) {
      const button = this.page.getByRole('button', { name: label }).first();

      if (await button.count()) {
        try {
          await button.click({ timeout: 2000 });
          await this.page.waitForLoadState('domcontentloaded');
          break;
        } catch {
          // Un simple essai suffit, on ne bloque pas tout le flux dessus.
        }
      }
    }
  }

  private async isPlaceDetailsView(): Promise<boolean> {
    if (!this.page) {
      return false;
    }

    if (this.page.url().includes('/maps/place/')) {
      return true;
    }

    for (const selector of PHONE_SELECTORS) {
      if (await this.page.locator(selector).count()) {
        return true;
      }
    }

    return false;
  }

  private async extractPhoneFromCurrentPlace(
    searchUrl: string,
    candidate?: LookupCandidate,
  ): Promise<LookupResult | undefined> {
    if (!this.page) {
      return undefined;
    }

    const phone = await this.extractPhoneFromPhoneSelectors();

    if (!phone) {
      return undefined;
    }

    const title = await this.extractPlaceTitle();

    return {
      status: 'trouvé',
      phone,
      source: `Google Maps | ${title || candidate?.name || 'fiche'} | ${this.page.url()} | recherche: ${searchUrl}`,
    };
  }

  private async extractPhoneFromPhoneSelectors(): Promise<string | undefined> {
    if (!this.page) {
      return undefined;
    }

    for (const selector of PHONE_SELECTORS) {
      const locator = this.page.locator(selector).first();

      if (!(await locator.count())) {
        continue;
      }

      const ariaLabel = (await locator.getAttribute('aria-label')) ?? '';
      const href = (await locator.getAttribute('href')) ?? '';
      const textContent = compactWhitespace((await locator.textContent()) ?? '');
      const candidate = extractPhoneFromText([ariaLabel, href.replace(/^tel:/, ''), textContent].join(' '));

      if (candidate) {
        return candidate;
      }
    }

    return undefined;
  }

  private async extractPlaceTitle(): Promise<string | undefined> {
    if (!this.page) {
      return undefined;
    }

    const title = this.page.locator('h1').first();

    if (!(await title.count())) {
      return undefined;
    }

    return compactWhitespace((await title.textContent()) ?? '');
  }

  private async collectCandidates(): Promise<LookupCandidate[]> {
    if (!this.page) {
      return [];
    }

    const rawCandidates = await this.page
      .locator('a[href*="/maps/place/"]')
      .evaluateAll((elements, maxResults) => {
        const seen = new Set<string>();
        const results: Array<{ name: string; url: string }> = [];

        for (const element of elements) {
          const href = element.getAttribute('href') ?? '';
          const label = element.getAttribute('aria-label') ?? element.textContent ?? '';
          const name = label.replace(/\s+/g, ' ').trim();

          if (!name || !href.includes('/maps/place/')) {
            continue;
          }

          const url = href.startsWith('http') ? href : new URL(href, location.origin).toString();
          const dedupeKey = `${name}::${url}`;

          if (seen.has(dedupeKey)) {
            continue;
          }

          seen.add(dedupeKey);
          results.push({ name, url });

          if (results.length >= Number(maxResults)) {
            break;
          }
        }

        return results;
      }, this.config.maxAmbiguousResults + 1);

    return rawCandidates;
  }
}
