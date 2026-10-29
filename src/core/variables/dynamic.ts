/**
 * Dynamic variables ({{$guid}}, {{$timestamp}}, ...), compatible with the most
 * commonly used Postman dynamic variables. Each call produces a fresh value.
 */
// Uses Web Crypto so the module also works in the browser (for UI highlighting).
const randomUUID = () => globalThis.crypto.randomUUID();
/** Random integer in [min, max) (or [0, min) when max is omitted). */
function randomInt(min: number, max?: number): number {
  if (max === undefined) [min, max] = [0, min];
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return min + (buf[0] % (max - min));
}

const FIRST_NAMES = ["Ada", "Alan", "Grace", "Linus", "Margaret", "Ken", "Barbara", "Dennis", "Radia", "Tim"];
const LAST_NAMES = ["Lovelace", "Turing", "Hopper", "Torvalds", "Hamilton", "Thompson", "Liskov", "Ritchie"];
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
const DOMAINS = ["example.com", "example.org", "example.net"];
const COLORS = ["red", "green", "blue", "orange", "purple", "teal", "black", "white"];
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

const pick = <T>(list: T[]): T => list[randomInt(list.length)];
const alnum = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join("");

export const DYNAMIC_VARIABLES: Record<string, () => string> = {
  $guid: () => randomUUID(),
  $randomUUID: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randomInt(0, 1001)),
  $randomBoolean: () => String(randomInt(2) === 1),
  $randomAlphaNumeric: () => alnum(1),
  $randomHexadecimal: () => randomInt(16).toString(16),
  $randomFirstName: () => pick(FIRST_NAMES),
  $randomLastName: () => pick(LAST_NAMES),
  $randomFullName: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
  $randomUserName: () => `${pick(FIRST_NAMES).toLowerCase()}.${alnum(4)}`,
  $randomEmail: () => `${pick(FIRST_NAMES).toLowerCase()}.${alnum(5)}@${pick(DOMAINS)}`,
  $randomPassword: () => alnum(15),
  $randomWord: () => pick(WORDS),
  $randomWords: () => Array.from({ length: 3 }, () => pick(WORDS)).join(" "),
  $randomColor: () => pick(COLORS),
  $randomIP: () => Array.from({ length: 4 }, () => randomInt(1, 255)).join("."),
  $randomPort: () => String(randomInt(1024, 65536)),
  $randomPhoneNumber: () => `${randomInt(200, 999)}-${randomInt(200, 999)}-${randomInt(1000, 9999)}`,
  $randomPrice: () => (randomInt(100, 100000) / 100).toFixed(2),
  $randomUrl: () => `https://${pick(DOMAINS)}/${pick(WORDS)}`,
  $randomDateFuture: () => new Date(Date.now() + randomInt(1, 365) * 86400000).toISOString(),
  $randomDatePast: () => new Date(Date.now() - randomInt(1, 365) * 86400000).toISOString(),
};

export function isDynamicVariable(name: string): boolean {
  return name.startsWith("$") && Object.prototype.hasOwnProperty.call(DYNAMIC_VARIABLES, name);
}

export function generateDynamic(name: string): string | undefined {
  return isDynamicVariable(name) ? DYNAMIC_VARIABLES[name]() : undefined;
}
