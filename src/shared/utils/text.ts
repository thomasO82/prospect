export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(min: number, max: number): number {
  if (max <= min) {
    return min;
  }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function sleepRandom(min: number, max: number): Promise<number> {
  const delay = randomBetween(min, max);
  await sleep(delay);

  return delay;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function extractPhoneFromText(value: string): string | undefined {
  const match = compactWhitespace(value).match(/(\+?\d[\d\s().-]{7,}\d)/);

  return match?.[1];
}

export function formatAmbiguousCandidates(
  candidates: Array<{ name: string; url: string }>,
): string {
  return candidates
    .map((candidate, index) => `${index + 1}. ${candidate.name} (${candidate.url})`)
    .join(' | ');
}
