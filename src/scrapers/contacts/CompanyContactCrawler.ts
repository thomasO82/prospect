import { PDFParse } from 'pdf-parse';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AppConfig, ContactLookupResult, PendingRow, ScrapingStatus } from '../../domain/types';
import { compactWhitespace, sleep } from '../../shared/utils/text';

const CONTACT_PATHS = [
  '/',
  '/contact',
  '/nous-contacter',
  '/mentions-legales',
  '/contacts',
  '/contactez-nous',
  '/a-propos',
  '/apropos',
  '/qui-sommes-nous',
  '/qui-sommes-nous.html',
  '/equipe',
  '/notre-equipe',
  '/mentions-legales.html',
  '/mentions-legales.php',
  '/legal',
  '/legal-notice',
  '/cgv',
  '/conditions-generales-de-vente',
];

const IGNORED_EMAIL_PREFIXES = [
  'noreply',
  'no-reply',
  'donotreply',
  'rgpd',
  'dpo',
  'privacy',
  'webmaster',
  'support',
  'notification',
];

const PRIORITY_EMAIL_PREFIXES = ['contact', 'accueil', 'commercial', 'hello', 'direction', 'info'];
const GENERIC_EMAIL_PREFIXES = [
  ...PRIORITY_EMAIL_PREFIXES,
  'bonjour',
  'office',
  'secretariat',
  'service-client',
  'serviceclient',
  'clients',
  'commande',
  'orders',
  'jobs',
  'career',
  'careers',
  'rh',
  'hr',
  'recrutement',
  'recruitment',
  'press',
  'presse',
  'marketing',
  'sales',
  'partenariat',
  'partnerships',
];
const HIGH_VALUE_SOURCE_TYPES = ['pdf', 'mentions_legales', 'contact_page', 'structured_data', 'mailto'];
const CONTACT_NAME_KEYWORDS = [
  'gerant',
  'gerante',
  'dirigeant',
  'dirigeante',
  'fondateur',
  'fondatrice',
  'president',
  'presidente',
  'directeur',
  'directrice',
  'ceo',
  'responsable',
  'charge',
  'chargee',
  'manager',
  'owner',
  'proprietaire',
  'co-fondateur',
  'co-fondatrice',
  'cofounder',
  'head of',
  'contact',
  'interlocuteur',
];
const BAD_NAME_FRAGMENTS = [
  'mentions legales',
  'politique de confidentialite',
  'conditions generales',
  'plan du site',
  'nous contacter',
  'contactez nous',
  'copyright',
  'tous droits reserves',
];
const PUBLIC_DIRECTORY_HOSTS = [
  'pappers.fr',
  'annuaire-entreprises.data.gouv.fr',
  'societe.com',
  'pagesjaunes.fr',
  'kompass.com',
  'manageo.fr',
];
const SOCIAL_PUBLIC_HOSTS = [
  'linkedin.com',
];
const CAPTCHA_PATTERNS = [
  'captcha',
  'nos systemes ont detecte',
  'nos systèmes ont détecté',
  'trafic exceptionnel',
  'trafic inhabituel',
  'verify you are human',
  'je ne suis pas un robot',
  'unusual traffic',
  'recaptcha',
  'hcaptcha',
  'our systems have detected unusual traffic',
  'there was a problem',
];
const CAPTCHA_COOLDOWN_MS = 5 * 60 * 1000;
const PERSON_SCHEMA_MARKERS = ['"@type":"Person"', '"@type": "Person"', "'@type':'Person'", "'@type': 'Person'"];

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface BingSearchPageEvidence {
  url: string;
  text: string;
}

interface EmailEvidence {
  email: string;
  source: string;
  sourceUrl: string;
  context: string;
  sourceType: string;
}

interface ContactNameEvidence {
  name: string;
  source: string;
  sourceUrl: string;
  context: string;
  sourceType: string;
}

interface PageEvidence {
  url: string;
  sourceType: string;
  text: string;
}

interface HunterEmail {
  value?: string;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  confidence?: number | null;
  sources?: Array<{
    uri?: string;
    domain?: string;
  }>;
}

interface HunterDomainSearchResponse {
  data?: {
    domain?: string;
    emails?: HunterEmail[];
  };
  errors?: Array<{
    details?: string;
    code?: number;
  }>;
}

export function extractEmails(text: string): string[] {
  const normalizedText = normalizeEmailText(text);
  const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const matches = normalizedText.match(emailPattern) ?? [];
  const unique = new Set(matches.map((email) => email.toLowerCase().replace(/[).,;:]+$/, '')));

  return Array.from(unique).filter((email) => Number.isFinite(scoreEmail(email)));
}

function normalizeEmailText(text: string): string {
  return text
    .replace(/mailto:/gi, ' ')
    .replace(/\s*\[at\]\s*/gi, '@')
    .replace(/\s*\(at\)\s*/gi, '@')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+arobase\s+/gi, '@')
    .replace(/\s*\[arobase\]\s*/gi, '@')
    .replace(/\s*\(arobase\)\s*/gi, '@')
    .replace(/\s+chez\s+/gi, '@')
    .replace(/\s*\[dot\]\s*/gi, '.')
    .replace(/\s*\(dot\)\s*/gi, '.')
    .replace(/\s+point\s+/gi, '.')
    .replace(/\s*\[point\]\s*/gi, '.')
    .replace(/\s*\(point\)\s*/gi, '.')
    .replace(/([a-z0-9._%+-])\s*@\s*([a-z0-9.-])/gi, '$1@$2')
    .replace(/([a-z0-9-])\s*\.\s*([a-z]{2,})(\b|\/)/gi, '$1.$2$3');
}

export const extractEmailsFromText = extractEmails;
export const extractEmailsFromHtml = extractEmails;
export const normalizeObfuscatedEmails = normalizeEmailText;

export function extractMailtoLinks(html: string): string[] {
  const matches = html.match(/mailto:([^"'\s>]+)/gi) ?? [];

  return extractEmails(matches.join('\n'));
}

export function filterAndScoreEmails(emails: string[], websiteHost?: string): Array<{ email: string; score: number }> {
  return emails
    .map((email) => ({ email, score: scoreEmail(email, websiteHost) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.email.localeCompare(right.email));
}

export function scoreEmail(email: string, websiteHost?: string, sourceType?: string): number {
  const [localPart, domain = ''] = email.toLowerCase().split('@');

  if (!localPart || IGNORED_EMAIL_PREFIXES.some((prefix) => localPart.startsWith(prefix))) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0.35;

  if (websiteHost && domain && websiteHost.includes(domain.replace(/^www\./, ''))) {
    score += 0.2;
  }

  if (PRIORITY_EMAIL_PREFIXES.includes(localPart)) {
    score += 0.18;
  }

  if (/^[a-z]+[.-][a-z]+$/.test(localPart)) {
    score += 0.12;
  }

  if (sourceType && HIGH_VALUE_SOURCE_TYPES.includes(sourceType)) {
    score += 0.2;
  }

  if (sourceType === 'guessed_email') {
    score -= 0.08;
  }

  if (localPart.includes('example') || domain.includes('example')) {
    score -= 0.5;
  }

  return Math.max(0, Math.min(0.99, score));
}

function isGenericEmail(email: string): boolean {
  const localPart = email.toLowerCase().split('@')[0] ?? '';

  return GENERIC_EMAIL_PREFIXES.includes(localPart)
    || IGNORED_EMAIL_PREFIXES.some((prefix) => localPart.startsWith(prefix))
    || /^(contact|info|hello|bonjour|accueil|commercial|sales|support|admin)[._-]?\d*$/.test(localPart);
}

function capitalizeNameToken(value: string): string {
  if (!value) {
    return value;
  }

  return `${value[0].toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function nameFromNominativeEmail(email: string): string | undefined {
  if (isGenericEmail(email)) {
    return undefined;
  }

  const localPart = email.split('@')[0] ?? '';
  const tokens = localPart
    .split(/[._-]+/)
    .filter((token) => /^[a-zA-ZÀ-ÖØ-öø-ÿ]{2,}$/.test(token));

  if (tokens.length < 2 || tokens.some((token) => GENERIC_EMAIL_PREFIXES.includes(token.toLowerCase()))) {
    return undefined;
  }

  return tokens.slice(0, 2).map(capitalizeNameToken).join(' ');
}

export function findBestEmail(evidences: EmailEvidence[], websiteHost?: string): EmailEvidence | undefined {
  return evidences
    .map((evidence) => ({
      evidence,
      score: scoreEmail(evidence.email, websiteHost, evidence.sourceType),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score || left.evidence.email.localeCompare(right.evidence.email))[0]
    ?.evidence;
}

function isSameOrSubdomain(host: string, expectedHost: string): boolean {
  return host === expectedHost || host.endsWith(`.${expectedHost}`);
}

function isOfficialCompanyUrl(url: string, websiteHost?: string): boolean {
  if (!websiteHost) {
    return false;
  }

  const host = getHost(url);

  if (!host) {
    return false;
  }

  return isSameOrSubdomain(host, websiteHost);
}

function isOfficialCompanyEmail(email: string, websiteHost?: string): boolean {
  if (!websiteHost) {
    return false;
  }

  const domain = (email.split('@')[1] ?? '').replace(/^www\./, '').toLowerCase();

  if (!domain) {
    return false;
  }

  return isSameOrSubdomain(domain, websiteHost);
}

function isHunterSourceType(sourceType: string): boolean {
  return sourceType === 'hunter_domain_search';
}

function isStrictFinalSourceType(sourceType: string): boolean {
  return ['contact_page', 'mentions_legales', 'team_or_about_page', 'website_page', 'pdf', 'mailto', 'structured_data', 'hunter_domain_search'].includes(sourceType);
}

function normalizeNameToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function getNameTokens(name: string): string[] {
  return normalizeNameToken(name)
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 2);
}

function getEmailLocalPartTokens(email: string): string[] {
  return (email.split('@')[0] ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length >= 1);
}

function doesNameMatchEmail(name: string, email: string): boolean {
  const nameTokens = getNameTokens(name);
  const emailTokens = getEmailLocalPartTokens(email);

  if (nameTokens.length === 0 || emailTokens.length === 0) {
    return false;
  }

  const matchingTokens = nameTokens.filter((token) => emailTokens.includes(token));

  if (matchingTokens.length >= 2) {
    return true;
  }

  if (nameTokens.length >= 2) {
    const [firstName, lastName] = nameTokens;
    const firstInitial = firstName[0];

    return emailTokens.includes(firstName)
      || emailTokens.includes(lastName)
      || emailTokens.includes(`${firstInitial}${lastName}`)
      || emailTokens.includes(`${firstInitial}.${lastName}`)
      || emailTokens.includes(`${firstName}.${lastName}`);
  }

  return matchingTokens.length === 1;
}

function scoreContactName(
  evidence: ContactNameEvidence,
  websiteHost?: string,
  bestEmail?: EmailEvidence,
): number {
  let score = 0.35;
  const sourceHost = getHost(evidence.sourceUrl);

  if (HIGH_VALUE_SOURCE_TYPES.includes(evidence.sourceType)) {
    score += 0.2;
  }

  if (evidence.sourceType === 'team_or_about_page') {
    score += 0.16;
  }

  if (websiteHost && sourceHost && (sourceHost.includes(websiteHost) || websiteHost.includes(sourceHost))) {
    score += 0.18;
  }

  if (bestEmail && doesNameMatchEmail(evidence.name, bestEmail.email)) {
    score += 0.3;
  }

  if (bestEmail && evidence.sourceUrl === bestEmail.sourceUrl) {
    score += 0.16;
  }

  if (evidence.context.toLowerCase().includes('mailto:')) {
    score += 0.08;
  }

  return Math.max(0, Math.min(0.99, score));
}

function findBestContactName(
  evidences: ContactNameEvidence[],
  websiteHost?: string,
  bestEmail?: EmailEvidence,
): ContactNameEvidence | undefined {
  return evidences
    .map((evidence) => ({
      evidence,
      score: scoreContactName(evidence, websiteHost, bestEmail),
    }))
    .filter((entry) => entry.score >= 0.45)
    .sort((left, right) => right.score - left.score || left.evidence.name.localeCompare(right.evidence.name))[0]
    ?.evidence;
}

function findStrictCompanyEmail(evidences: EmailEvidence[], websiteHost?: string): EmailEvidence | undefined {
  return evidences
    .map((evidence) => ({
      evidence,
      score: scoreEmail(evidence.email, websiteHost, evidence.sourceType),
    }))
    .filter(({ evidence, score }) => Number.isFinite(score)
      && isOfficialCompanyEmail(evidence.email, websiteHost)
      && (isOfficialCompanyUrl(evidence.sourceUrl, websiteHost) || isHunterSourceType(evidence.sourceType))
      && isStrictFinalSourceType(evidence.sourceType))
    .sort((left, right) => right.score - left.score || left.evidence.email.localeCompare(right.evidence.email))[0]
    ?.evidence;
}

function findBestGuessedCompanyEmail(evidences: EmailEvidence[], websiteHost?: string): EmailEvidence | undefined {
  if (!websiteHost) {
    return undefined;
  }

  return evidences
    .map((evidence) => ({
      evidence,
      score: scoreEmail(evidence.email, websiteHost, evidence.sourceType),
    }))
    .filter(({ evidence, score }) => score >= 0.5
      && evidence.sourceType === 'guessed_email'
      && isOfficialCompanyEmail(evidence.email, websiteHost)
      && isOfficialCompanyUrl(evidence.sourceUrl, websiteHost))
    .sort((left, right) => right.score - left.score || left.evidence.email.localeCompare(right.evidence.email))[0]
    ?.evidence;
}

function findStrictCompanyContactName(
  evidences: ContactNameEvidence[],
  websiteHost?: string,
  emailEvidence?: EmailEvidence,
): ContactNameEvidence | undefined {
  if (!emailEvidence || !websiteHost) {
    return undefined;
  }

  return evidences
    .map((evidence) => ({
      evidence,
      score: scoreContactName(evidence, websiteHost, emailEvidence),
    }))
    .filter(({ evidence, score }) => score >= 0.7
      && (isOfficialCompanyUrl(evidence.sourceUrl, websiteHost) || isHunterSourceType(evidence.sourceType))
      && isStrictFinalSourceType(evidence.sourceType)
      && doesNameMatchEmail(evidence.name, emailEvidence.email)
      && (
        isHunterSourceType(evidence.sourceType)
        || isSameOrSubdomain(getHost(evidence.sourceUrl), getHost(emailEvidence.sourceUrl))
      ))
    .sort((left, right) => right.score - left.score || left.evidence.name.localeCompare(right.evidence.name))[0]
    ?.evidence;
}

function findBestOfficialContactName(
  evidences: ContactNameEvidence[],
  websiteHost?: string,
  bestEmail?: EmailEvidence,
): ContactNameEvidence | undefined {
  if (!websiteHost) {
    return undefined;
  }

  return evidences
    .map((evidence) => ({
      evidence,
      score: scoreContactName(evidence, websiteHost, bestEmail),
    }))
    .filter(({ evidence, score }) => score >= 0.62
      && isOfficialCompanyUrl(evidence.sourceUrl, websiteHost)
      && isStrictFinalSourceType(evidence.sourceType))
    .sort((left, right) => right.score - left.score || left.evidence.name.localeCompare(right.evidence.name))[0]
    ?.evidence;
}

function normalizeEmailToken(value: string): string {
  return normalizeNameToken(value).replace(/[^a-z]/g, '');
}

function splitNameForEmail(name: string): { firstName: string; lastName: string } | undefined {
  const tokens = name
    .split(/\s+/)
    .map(normalizeEmailToken)
    .filter((token) => token.length >= 2);

  if (tokens.length < 2) {
    return undefined;
  }

  return {
    firstName: tokens[0],
    lastName: tokens[tokens.length - 1],
  };
}

function detectEmailPattern(email: string): 'first.last' | 'first' | 'f.last' | 'firstlast' | undefined {
  if (isGenericEmail(email)) {
    return undefined;
  }

  const localPart = email.toLowerCase().split('@')[0] ?? '';

  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(localPart)) {
    return 'first.last';
  }

  if (/^[a-z]{2,}-[a-z]{2,}$/.test(localPart)) {
    return 'first.last';
  }

  if (/^[a-z]\.[a-z]{2,}$/.test(localPart)) {
    return 'f.last';
  }

  if (/^[a-z]{2,}$/.test(localPart)) {
    return 'first';
  }

  return undefined;
}

function buildEmailLocalPart(
  nameParts: { firstName: string; lastName: string },
  pattern: 'first.last' | 'first' | 'f.last' | 'firstlast',
): string {
  if (pattern === 'first') {
    return nameParts.firstName;
  }

  if (pattern === 'f.last') {
    return `${nameParts.firstName[0]}.${nameParts.lastName}`;
  }

  if (pattern === 'firstlast') {
    return `${nameParts.firstName}${nameParts.lastName}`;
  }

  return `${nameParts.firstName}.${nameParts.lastName}`;
}

function buildGuessedEmailEvidences(
  contactNameEvidences: ContactNameEvidence[],
  emailEvidences: EmailEvidence[],
  websiteUrl?: string,
): EmailEvidence[] {
  const websiteHost = getDomainFromWebsiteUrl(websiteUrl);

  if (!websiteHost) {
    return [];
  }

  const existingEmails = new Set(emailEvidences.map((evidence) => evidence.email));
  const officialEmails = emailEvidences
    .map((evidence) => evidence.email)
    .filter((email) => isOfficialCompanyEmail(email, websiteHost));
  const detectedPattern = officialEmails
    .map(detectEmailPattern)
    .find((pattern): pattern is 'first.last' | 'first' | 'f.last' | 'firstlast' => Boolean(pattern));
  const patterns: Array<'first.last' | 'first' | 'f.last' | 'firstlast'> = detectedPattern
    ? [detectedPattern, 'first.last', 'f.last']
    : ['first.last', 'first', 'f.last'];
  const guessed: EmailEvidence[] = [];
  const officialNames = contactNameEvidences
    .filter((evidence) => isOfficialCompanyUrl(evidence.sourceUrl, websiteHost))
    .filter((evidence, index, list) => list.findIndex((candidate) => candidate.name === evidence.name) === index)
    .slice(0, 3);

  for (const nameEvidence of officialNames) {
    const nameParts = splitNameForEmail(nameEvidence.name);

    if (!nameParts) {
      continue;
    }

    for (const pattern of patterns) {
      const email = `${buildEmailLocalPart(nameParts, pattern)}@${websiteHost}`;

      if (existingEmails.has(email)) {
        continue;
      }

      existingEmails.add(email);
      guessed.push({
        email,
        source: 'email_probable',
        sourceUrl: nameEvidence.sourceUrl,
        context: `Email probable deduit du nom "${nameEvidence.name}" et du domaine officiel ${websiteHost}. Verification conseillee avant envoi.`,
        sourceType: 'guessed_email',
      });
    }
  }

  return guessed;
}

export function extractContactNames(text: string): string[] {
  const compactText = compactWhitespace(text);
  const names = new Set<string>();

  for (const keyword of CONTACT_NAME_KEYWORDS) {
    const pattern = new RegExp(
      `(?:${keyword})\\s*(?:[:\\-–—]|est|de la societe|de l'entreprise|du cabinet)?\\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ' -]{2,80})`,
      'gi',
    );
    let match = pattern.exec(compactText);

    while (match) {
      const cleaned = cleanContactName(match[1]);

      if (cleaned) {
        names.add(cleaned);
      }

      match = pattern.exec(compactText);
    }
  }

  return Array.from(names);
}

export function extractContactName(text: string): string | undefined {
  return extractContactNames(text)[0];
}

export async function analyzePdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const parsed = await parser.getText();

  return parsed.text;
}

export async function detectCaptcha(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => '');
  const url = page.url().toLowerCase();
  const bodyText = await page.locator('body').textContent({ timeout: 3000 }).catch(() => '');
  const iframeCount = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').count().catch(() => 0);
  const haystack = `${title}\n${url}\n${bodyText ?? ''}`.toLowerCase();

  return iframeCount > 0 || url.includes('/sorry/') || url.includes('/captcha') || CAPTCHA_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function cleanContactName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = compactWhitespace(value)
    .replace(/\s+(email|telephone|téléphone|contact|mentions|legal|légal).*$/i, '')
    .trim();

  if (cleaned.length < 5 || cleaned.length > 80 || /\d|@|http/i.test(cleaned)) {
    return undefined;
  }

  const normalized = normalizeNameToken(cleaned);

  if (BAD_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
    return undefined;
  }

  return cleaned;
}

function getEmailContext(text: string, email: string): string {
  const index = text.toLowerCase().indexOf(email.toLowerCase());

  if (index === -1) {
    return '';
  }

  return compactWhitespace(text.slice(Math.max(0, index - 120), index + email.length + 120));
}

function getNameContext(text: string, name: string): string {
  const index = text.indexOf(name);

  if (index === -1) {
    return '';
  }

  return compactWhitespace(text.slice(Math.max(0, index - 120), index + name.length + 120));
}

function sourceTypeFromUrl(url: string): string {
  const lowerUrl = url.toLowerCase();
  const host = getHost(url);

  if (lowerUrl.endsWith('.pdf')) {
    return 'pdf';
  }

  if (PUBLIC_DIRECTORY_HOSTS.some((directoryHost) => host.includes(directoryHost))) {
    return 'public_directory';
  }

  if (SOCIAL_PUBLIC_HOSTS.some((socialHost) => host.includes(socialHost))) {
    return 'social_public';
  }

  if (lowerUrl.includes('mentions') || lowerUrl.includes('legal')) {
    return 'mentions_legales';
  }

  if (lowerUrl.includes('contact')) {
    return 'contact_page';
  }

  if (lowerUrl.includes('equipe') || lowerUrl.includes('qui-sommes-nous') || lowerUrl.includes('a-propos')) {
    return 'team_or_about_page';
  }

  return 'website_page';
}

function buildStrategicPageUrls(websiteUrl: string, maxPages: number): string[] {
  const base = new URL(websiteUrl);
  const urls = CONTACT_PATHS.map((path) => new URL(path, base.origin).toString());

  return Array.from(new Set(urls)).slice(0, maxPages);
}

export function buildStrategicUrls(websiteUrl: string, maxPages: number): string[] {
  return buildStrategicPageUrls(websiteUrl, maxPages);
}

function buildSearchQueries(row: PendingRow, websiteUrl?: string): string[] {
  const quotedCompany = `"${row.company}"`;
  const addressPart = row.address ? `"${row.address}"` : '';
  const queries = [
    `${quotedCompany} email`,
    `${quotedCompany} contact`,
    `${quotedCompany} "@"`,
    `${quotedCompany} "mentions legales"`,
    `${quotedCompany} dirigeant`,
    `${quotedCompany} gerant`,
    `${quotedCompany} pappers`,
    `${quotedCompany} "annuaire entreprises"`,
  ];

  if (addressPart) {
    queries.push(`${quotedCompany} ${addressPart} contact`);
    queries.push(`${quotedCompany} ${addressPart} "@"`);
  }

  if (websiteUrl) {
    const domain = new URL(websiteUrl).hostname.replace(/^www\./, '');
    queries.push(`site:${domain} "@"`);
    queries.push(`site:${domain} contact`);
    queries.push(`site:${domain} mentions legales`);
    queries.push(`site:${domain} "mailto:"`);
    queries.push(`site:${domain} filetype:pdf`);
    queries.push(`site:${domain} filetype:pdf "@"`);
  }

  return queries;
}

function getDomainFromWebsiteUrl(websiteUrl: string | undefined): string | undefined {
  if (!websiteUrl) {
    return undefined;
  }

  const host = getHost(websiteUrl);

  return host || undefined;
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function decodeBingRedirectTarget(rawValue: string): string | undefined {
  if (!rawValue) {
    return undefined;
  }

  const directValue = decodeURIComponent(rawValue);

  if (directValue.startsWith('http://') || directValue.startsWith('https://')) {
    return directValue;
  }

  if (!directValue.startsWith('a1')) {
    return undefined;
  }

  try {
    const encoded = directValue.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const padding = encoded.length % 4 === 0 ? '' : '='.repeat(4 - (encoded.length % 4));
    const decoded = Buffer.from(`${encoded}${padding}`, 'base64').toString('utf8');

    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeResultUrl(rawUrl: string): string | undefined {
  if (!rawUrl) {
    return undefined;
  }

  try {
    const parsed = new URL(rawUrl, 'https://www.google.com');

    if (parsed.pathname === '/url' && parsed.searchParams.get('q')) {
      return parsed.searchParams.get('q') ?? undefined;
    }

    if (parsed.hostname.endsWith('bing.com') && parsed.pathname.startsWith('/ck/a')) {
      const redirectTarget = decodeBingRedirectTarget(parsed.searchParams.get('u') ?? '');

      if (redirectTarget) {
        return redirectTarget;
      }

      return undefined;
    }

    if (parsed.protocol.startsWith('http')) {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractStructuredPersonNames(text: string): string[] {
  if (!PERSON_SCHEMA_MARKERS.some((marker) => text.includes(marker))) {
    return [];
  }

  const names = new Set<string>();
  const namePattern = /["']name["']\s*:\s*["']([^"']{5,80})["']/gi;
  let match = namePattern.exec(text);

  while (match) {
    const cleaned = cleanContactName(match[1]);

    if (cleaned && cleaned.split(/\s+/).length >= 2) {
      names.add(cleaned);
    }

    match = namePattern.exec(text);
  }

  return Array.from(names);
}

function collectEvidenceFromText(source: PageEvidence): {
  emailEvidences: EmailEvidence[];
  contactNameEvidences: ContactNameEvidence[];
} {
  const emails = extractEmails(source.text).map((email) => ({
    email,
    source: source.sourceType,
    sourceUrl: source.url,
    context: getEmailContext(source.text, email),
    sourceType: source.sourceType,
  }));
  const names = extractContactNames(source.text).map((name) => ({
    name,
    source: source.sourceType,
    sourceUrl: source.url,
    context: getNameContext(source.text, name),
    sourceType: source.sourceType,
  }));
  const emailNames = emails
    .map((evidence) => ({
      name: nameFromNominativeEmail(evidence.email),
      sourceUrl: evidence.sourceUrl,
      context: evidence.context,
    }))
    .filter((entry): entry is { name: string; sourceUrl: string; context: string } => Boolean(entry.name))
    .map((entry) => ({
      name: entry.name,
      source: source.sourceType,
      sourceUrl: entry.sourceUrl,
      context: entry.context,
      sourceType: source.sourceType,
    }));
  const structuredNames = extractStructuredPersonNames(source.text).map((name) => ({
    name,
    source: 'structured_data',
    sourceUrl: source.url,
    context: getNameContext(source.text, name),
    sourceType: 'structured_data',
  }));

  return {
    emailEvidences: emails,
    contactNameEvidences: [...names, ...emailNames, ...structuredNames],
  };
}

function getHunterSourceUrl(email: HunterEmail, domain: string): string {
  const sourceUrl = email.sources?.find((source) => source.uri?.startsWith('http'))?.uri;

  return sourceUrl ?? `https://hunter.io/search/${domain}`;
}

function collectEvidenceFromHunterEmails(
  emails: HunterEmail[],
  domain: string,
): {
  emailEvidences: EmailEvidence[];
  contactNameEvidences: ContactNameEvidence[];
} {
  const emailEvidences: EmailEvidence[] = [];
  const contactNameEvidences: ContactNameEvidence[] = [];

  for (const hunterEmail of emails) {
    const email = hunterEmail.value?.toLowerCase();

    if (!email || !Number.isFinite(scoreEmail(email, domain, 'hunter_domain_search'))) {
      continue;
    }

    const sourceUrl = getHunterSourceUrl(hunterEmail, domain);
    const fullName = compactWhitespace(`${hunterEmail.first_name ?? ''} ${hunterEmail.last_name ?? ''}`);
    const context = compactWhitespace([
      fullName,
      hunterEmail.position ?? '',
      hunterEmail.confidence !== null && hunterEmail.confidence !== undefined
        ? `Hunter confidence ${hunterEmail.confidence}`
        : '',
    ].join(' '));

    emailEvidences.push({
      email,
      source: 'hunter_domain_search',
      sourceUrl,
      context,
      sourceType: 'hunter_domain_search',
    });

    if (fullName) {
      contactNameEvidences.push({
        name: fullName,
        source: 'hunter_domain_search',
        sourceUrl,
        context,
        sourceType: 'hunter_domain_search',
      });
    }
  }

  return {
    emailEvidences,
    contactNameEvidences,
  };
}

export function parseBingResults(results: SearchResult[]): SearchResult[] {
  return results.filter((result) => result.url.startsWith('http'));
}

async function extractPageEvidenceText(page: Page): Promise<string> {
  const html = await page.content();
  const visibleText = await page.locator('body').textContent().catch(() => '');
  const mailtoValues = await page
    .locator('a[href^="mailto:"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? '').join('\n'))
    .catch(() => '');
  const structuredData = await page
    .locator('script[type="application/ld+json"], script[type="application/json"]')
    .evaluateAll((scripts) => scripts.map((script) => script.textContent ?? '').join('\n'))
    .catch(() => '');

  return `${html}\n${visibleText ?? ''}\n${mailtoValues}\n${structuredData}`;
}

function classifyResults(
  emailEvidences: EmailEvidence[],
  contactNameEvidences: ContactNameEvidence[],
  websiteUrl: string | undefined,
  visitedUrls: string[],
  analyzedPdfUrls: string[],
  fallbackStatus: ScrapingStatus,
): ContactLookupResult {
  const websiteHost = websiteUrl ? new URL(websiteUrl).hostname.replace(/^www\./, '') : undefined;
  const guessedEmailEvidences = buildGuessedEmailEvidences(contactNameEvidences, emailEvidences, websiteUrl);
  const allEmailEvidences = [...emailEvidences, ...guessedEmailEvidences];
  const bestEmail = findStrictCompanyEmail(allEmailEvidences, websiteHost)
    ?? findBestGuessedCompanyEmail(allEmailEvidences, websiteHost);
  const strictName = findStrictCompanyContactName(contactNameEvidences, websiteHost, bestEmail);
  const bestName = strictName ?? findBestOfficialContactName(contactNameEvidences, websiteHost, bestEmail);
  const hasStrongPair = Boolean(bestEmail && bestName && (
    strictName
    || bestEmail.sourceType === 'guessed_email'
    || isGenericEmail(bestEmail.email)
  ));
  const bestEmailConfidence = bestEmail
    ? scoreEmail(bestEmail.email, websiteHost, bestEmail.sourceType)
    : undefined;
  const usableEmails = Array.from(new Set(
    allEmailEvidences
      .map((evidence) => evidence.email)
      .filter((email) => isOfficialCompanyEmail(email, websiteHost) && Number.isFinite(scoreEmail(email, websiteHost))),
  ));
  const scrapingStatus: ScrapingStatus = bestEmail
    ? analyzedPdfUrls.length > 0 && bestEmail.sourceType === 'pdf'
      ? 'PDF_ANALYZED'
      : 'OK'
    : fallbackStatus;

  return {
    email: bestEmail?.email,
    contactName: hasStrongPair ? bestName?.name : undefined,
    confidence: bestEmailConfidence,
    source: hasStrongPair && bestName && bestEmail && (doesNameMatchEmail(bestName.name, bestEmail.email) || bestEmail.sourceType === 'guessed_email')
      ? `${bestEmail.source} + ${bestName.source}`
      : bestEmail?.source,
    sourceUrl: bestEmail?.sourceUrl ?? (hasStrongPair ? bestName?.sourceUrl : undefined),
    reason: hasStrongPair && bestEmail?.sourceType === 'guessed_email' && bestName
      ? `Email probable deduit du nom de contact trouve sur le site officiel et du domaine de l'entreprise. A verifier avant envoi.`
      : hasStrongPair && bestEmail && bestName && doesNameMatchEmail(bestName.name, bestEmail.email)
      ? `Email et nom de contact trouves sur le domaine officiel de l'entreprise avec correspondance forte.`
      : hasStrongPair && bestEmail && bestName
        ? `Email officiel et nom de contact trouves sur le domaine de l'entreprise, mais sans preuve que cet email appartient directement a ce contact.`
      : bestEmail
        ? `Email officiel trouve sur le domaine de l'entreprise. Nom de contact non retenu faute de correlation suffisante.`
        : undefined,
    scrapingStatus,
    lastCheckedAt: new Date().toISOString(),
    visitedUrls,
    analyzedPdfUrls,
    emailsFound: usableEmails,
    contactNamesFound: Array.from(new Set(
      contactNameEvidences
        .filter((evidence) => isOfficialCompanyUrl(evidence.sourceUrl, websiteHost))
        .map((evidence) => evidence.name),
    )),
  };
}

export class CompanyContactCrawler {
  public readonly config: AppConfig;

  private browser?: Browser;

  private context?: BrowserContext;

  private searchBlockedUntil = 0;

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

    await this.context.route('**/*', async (route) => {
      const resourceType = route.request().resourceType();

      if (['font', 'image', 'media'].includes(resourceType)) {
        await route.abort();
        return;
      }

      await route.continue();
    });
  }

  public async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }

  public async bingSearch(query: string): Promise<{
    results: SearchResult[];
    captchaDetected: boolean;
    pageEvidence?: BingSearchPageEvidence;
  }> {
    if (!this.context) {
      throw new Error('Le navigateur de crawl contact n est pas initialise.');
    }

    if (Date.now() < this.searchBlockedUntil) {
      return { results: [], captchaDetected: true };
    }

    const page = await this.context.newPage();
    page.setDefaultTimeout(this.config.contactLookup.timeoutMs);

    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${this.config.contactLookup.maxBingResults}`;
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.contactLookup.timeoutMs,
      });

      if (await detectCaptcha(page)) {
        this.searchBlockedUntil = Date.now() + CAPTCHA_COOLDOWN_MS;
        return { results: [], captchaDetected: true };
      }

      const visibleText = compactWhitespace((await page.locator('body').textContent().catch(() => '')) ?? '');

      const results = await page.locator('li.b_algo').evaluateAll((items, maxResults) => {
        const results: SearchResult[] = [];

        for (const item of items) {
          const link = item.querySelector('h2 a');

          if (!link) {
            continue;
          }

          const href = link.getAttribute('href') ?? '';
          const title = link.textContent?.replace(/\s+/g, ' ').trim() ?? '';

          if (!href || !title || href.startsWith('#')) {
            continue;
          }

          const snippet = item.querySelector('.b_caption p')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          results.push({ title, url: href, snippet });

          if (results.length >= Number(maxResults)) {
            break;
          }
        }

        return results;
      }, this.config.contactLookup.maxBingResults);

      return {
        results: parseBingResults(results
          .map((result) => ({ ...result, url: normalizeResultUrl(result.url) ?? '' }))
          .filter((result) => result.url.startsWith('http'))),
        captchaDetected: false,
        pageEvidence: visibleText
          ? {
              url: page.url(),
              text: visibleText,
            }
          : undefined,
      };
    } finally {
      await page.close();
    }
  }

  public async searchBing(query: string): Promise<{
    results: SearchResult[];
    captchaDetected: boolean;
    pageEvidence?: BingSearchPageEvidence;
  }> {
    return this.bingSearch(query);
  }

  public async crawlCompanyWebsite(row: PendingRow, websiteUrl?: string): Promise<ContactLookupResult> {
    if (!this.context) {
      throw new Error('Le navigateur de crawl contact n est pas initialise.');
    }

    const visitedUrls: string[] = [];
    const analyzedPdfUrls: string[] = [];
    const emailEvidences: EmailEvidence[] = [];
    const contactNameEvidences: ContactNameEvidence[] = [];
    let captchaDetected = false;

    try {
      await this.collectHunterEvidence(websiteUrl, emailEvidences, contactNameEvidences);
      const searchResults = websiteUrl
        ? await this.collectSearchEvidence(row, websiteUrl, emailEvidences, contactNameEvidences)
        : { results: [], captchaDetected: false };
      captchaDetected = searchResults.captchaDetected;

      const candidateUrls = this.buildCandidateUrlsFromSearch(searchResults.results, websiteUrl);
      await this.collectPageEvidence(candidateUrls, websiteUrl, visitedUrls, emailEvidences, contactNameEvidences);

      if (this.config.contactLookup.maxPdfPerCompany > 0) {
        await this.collectPdfEvidence(searchResults.results, analyzedPdfUrls, emailEvidences, contactNameEvidences);
      }

      const fallbackStatus: ScrapingStatus = captchaDetected
        ? 'BING_BLOCKED'
        : websiteUrl || searchResults.results.length > 0
          ? 'EMAIL_NOT_FOUND'
          : 'WEBSITE_NOT_FOUND';

      return classifyResults(
        emailEvidences,
        contactNameEvidences,
        websiteUrl,
        visitedUrls,
        analyzedPdfUrls,
        fallbackStatus,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ...this.emptyResult(captchaDetected || message === 'CAPTCHA_DETECTED' ? 'BING_BLOCKED' : 'ERROR', visitedUrls, analyzedPdfUrls),
        errorMessage: message,
      };
    }
  }

  private async collectSearchEvidence(
    row: PendingRow,
    websiteUrl: string | undefined,
    emailEvidences: EmailEvidence[],
    contactNameEvidences: ContactNameEvidence[],
  ): Promise<{ results: SearchResult[]; captchaDetected: boolean }> {
    const allResults: SearchResult[] = [];

    if (!this.config.contactLookup.useBingSearch) {
      return { results: allResults, captchaDetected: false };
    }

    for (const query of buildSearchQueries(row, websiteUrl)) {
      if (this.config.contactLookup.slowMode) {
        await sleep(this.config.contactLookup.searchDelayMs);
      }

      console.log(`   Bing query: ${query}`);
      const { results, captchaDetected, pageEvidence } = await this.bingSearch(query);

      if (captchaDetected) {
        console.log('   Bing: blocage/captcha detecte');
        return { results: allResults, captchaDetected: true };
      }

      console.log(`   Bing resultats: ${results.length}`);
      allResults.push(...results);

      if (pageEvidence) {
        const pageLevelEvidence = collectEvidenceFromText({
          url: pageEvidence.url,
          sourceType: 'bing_page',
          text: pageEvidence.text,
        });
        emailEvidences.push(...pageLevelEvidence.emailEvidences);
        contactNameEvidences.push(...pageLevelEvidence.contactNameEvidences);
      }

      for (const result of results) {
        const source: PageEvidence = {
          url: result.url,
          sourceType: 'bing_snippet',
          text: `${result.title}\n${result.snippet}`,
        };
        const evidence = collectEvidenceFromText(source);
        emailEvidences.push(...evidence.emailEvidences);
        contactNameEvidences.push(...evidence.contactNameEvidences);
      }
    }

    const deduped = new Map(allResults.map((result) => [result.url, result]));

    return { results: Array.from(deduped.values()), captchaDetected: false };
  }

  private async collectHunterEvidence(
    websiteUrl: string | undefined,
    emailEvidences: EmailEvidence[],
    contactNameEvidences: ContactNameEvidence[],
  ): Promise<void> {
    const domain = getDomainFromWebsiteUrl(websiteUrl);

    if (!this.config.contactLookup.useHunter || !this.config.contactLookup.hunterApiKey || !domain) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.contactLookup.hunterTimeoutMs);

    try {
      const params = new URLSearchParams({
        domain,
        api_key: this.config.contactLookup.hunterApiKey,
        limit: String(this.config.contactLookup.hunterMaxEmails),
      });
      const response = await fetch(`https://api.hunter.io/v2/domain-search?${params.toString()}`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        console.log(`   Hunter: ignore (${response.status})`);
        return;
      }

      const payload = await response.json() as HunterDomainSearchResponse;
      const hunterEmails = payload.data?.emails ?? [];
      const evidence = collectEvidenceFromHunterEmails(hunterEmails, domain);

      emailEvidences.push(...evidence.emailEvidences);
      contactNameEvidences.push(...evidence.contactNameEvidences);
      console.log(`   Hunter: emails detectes ${evidence.emailEvidences.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`   Hunter: ignore (${message})`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildCandidateUrlsFromSearch(results: SearchResult[], websiteUrl?: string): string[] {
    const urls = new Set<string>();

    if (websiteUrl) {
      buildStrategicPageUrls(websiteUrl, this.config.contactLookup.maxPagesPerCompany).forEach((url) => urls.add(url));
    }

    for (const result of results) {
      if (result.url.toLowerCase().endsWith('.pdf')) {
        continue;
      }

      const sourceType = sourceTypeFromUrl(result.url);

      if (sourceType === 'social_public') {
        continue;
      }

      if (sourceType !== 'website_page' || urls.size < this.config.contactLookup.maxPagesPerCompany) {
        urls.add(result.url);
      }
    }

    const candidateUrls = Array.from(urls).slice(0, this.config.contactLookup.maxPagesPerCompany);

    if (candidateUrls.length > 0) {
      console.log(`   pages officielles candidates: ${candidateUrls.join(' | ')}`);
    }

    return candidateUrls;
  }

  private async collectPageEvidence(
    urls: string[],
    websiteUrl: string | undefined,
    visitedUrls: string[],
    emailEvidences: EmailEvidence[],
    contactNameEvidences: ContactNameEvidence[],
  ): Promise<void> {
    const page = await this.context!.newPage();
    page.setDefaultTimeout(this.config.contactLookup.timeoutMs);
    const websiteHost = websiteUrl ? getHost(websiteUrl) : undefined;

    try {
      for (const url of urls) {
        try {
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: this.config.contactLookup.timeoutMs,
          });

          if (await detectCaptcha(page)) {
            console.log(`   page ignoree: captcha/protection detecte sur ${page.url()}`);
            if (this.config.contactLookup.slowMode) {
              await sleep(this.config.contactLookup.searchDelayMs || 2000);
            }
            continue;
          }

          const source: PageEvidence = {
            url: page.url(),
            sourceType: sourceTypeFromUrl(page.url()),
            text: await extractPageEvidenceText(page),
          };
          const evidence = collectEvidenceFromText(source);
          visitedUrls.push(page.url());
          emailEvidences.push(...evidence.emailEvidences);
          contactNameEvidences.push(...evidence.contactNameEvidences);

          if (findStrictCompanyEmail(emailEvidences, websiteHost)) {
            console.log('   email officiel trouve, recherche contact arretee pour cette entreprise');
            break;
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'CAPTCHA_DETECTED') {
            throw error;
          }
        }
      }
    } finally {
      await page.close();
    }
  }

  private async collectPdfEvidence(
    results: SearchResult[],
    analyzedPdfUrls: string[],
    emailEvidences: EmailEvidence[],
    contactNameEvidences: ContactNameEvidence[],
  ): Promise<void> {
    const pdfUrls = results
      .map((result) => result.url)
      .filter((url) => url.toLowerCase().includes('.pdf'))
      .slice(0, this.config.contactLookup.maxPdfPerCompany);

    for (const pdfUrl of pdfUrls) {
      try {
        const response = await this.context!.request.get(pdfUrl, {
          timeout: this.config.contactLookup.timeoutMs,
        });

        if (!response.ok()) {
          continue;
        }

        const buffer = await response.body();
        const text = await analyzePdf(buffer);
        const source: PageEvidence = {
          url: pdfUrl,
          sourceType: 'pdf',
          text,
        };
        const evidence = collectEvidenceFromText(source);
        analyzedPdfUrls.push(pdfUrl);
        emailEvidences.push(...evidence.emailEvidences);
        contactNameEvidences.push(...evidence.contactNameEvidences);
      } catch {
        // Un PDF illisible ne doit pas bloquer l'entreprise.
      }
    }
  }

  private emptyResult(
    scrapingStatus: ScrapingStatus,
    visitedUrls: string[],
    analyzedPdfUrls: string[],
  ): ContactLookupResult {
    return {
      scrapingStatus,
      lastCheckedAt: new Date().toISOString(),
      visitedUrls,
      analyzedPdfUrls,
      emailsFound: [],
      contactNamesFound: [],
    };
  }
}

export async function crawlCompanyWebsite(
  crawler: CompanyContactCrawler,
  row: PendingRow,
  websiteUrl?: string,
): Promise<ContactLookupResult> {
  return crawler.crawlCompanyWebsite(row, websiteUrl);
}

export const crawlOfficialWebsite = crawlCompanyWebsite;

export async function enrichCompanyRowWithContact(
  crawler: CompanyContactCrawler,
  row: PendingRow,
  websiteUrl?: string,
): Promise<ContactLookupResult> {
  if (
    !crawler.config.processAllRows &&
    !row.needsEmail &&
    !row.needsContactName &&
    !row.needsConfidence &&
    !row.needsSource &&
    !row.needsSourceUrl &&
    !row.needsScrapingStatus
  ) {
    return {
      scrapingStatus: 'OK',
      visitedUrls: [],
      analyzedPdfUrls: [],
      emailsFound: [],
      contactNamesFound: [],
    };
  }

  return crawler.crawlCompanyWebsite(row, websiteUrl);
}
