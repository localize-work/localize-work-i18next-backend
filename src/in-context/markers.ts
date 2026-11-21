/**
 * Invisible markers that tell the in-context editor which key a piece of text
 * on the page came from.
 *
 * While editing is on, every translated string ends with a marker: a short
 * run of characters that browsers draw as nothing. A marker holds only a
 * number; the page keeps a registry from that number to the key. So markers
 * stay short however long key names are, and copied text reveals no key.
 *
 * The characters are U+2060 (word joiner) as the frame and U+2061–U+2064
 * (invisible math operators) as base-4 digits. All are "default ignorable":
 * they have no width, do not allow a line break, and do not change how
 * neighbouring letters join, which zero-width joiners would in Arabic or
 * Indic scripts.
 */

const FRAME = '⁠';
const DIGITS = ['⁡', '⁢', '⁣', '⁤'] as const;
const MARKER_SOURCE = `${FRAME}([${DIGITS[0]}-${DIGITS[3]}]+)${FRAME}`;

/** The key a marker stands for. */
export interface MarkedKey {
  namespace: string;
  key: string;
  /** The language the call asked for with `lng`, when it named one. */
  language?: string;
}

export function encodeMarker(id: number): string {
  if (!Number.isInteger(id) || id < 0) throw new RangeError('marker id must be a non-negative integer');
  let digits = '';
  let rest = id;
  do {
    digits = DIGITS[rest % 4]! + digits;
    rest = Math.floor(rest / 4);
  } while (rest > 0);
  return `${FRAME}${digits}${FRAME}`;
}

function decodeDigits(digits: string): number {
  let id = 0;
  for (const digit of digits) id = id * 4 + (digit.charCodeAt(0) - 0x2061);
  return id;
}

export interface FoundMarker {
  id: number;
  /** Where the marker starts in the text. The text it marks ends here. */
  index: number;
}

/** Every marker in a text, in order. */
export function findMarkers(text: string): FoundMarker[] {
  const found: FoundMarker[] = [];
  for (const match of text.matchAll(new RegExp(MARKER_SOURCE, 'g'))) {
    found.push({ id: decodeDigits(match[1]!), index: match.index });
  }
  return found;
}

/**
 * The marker for the text at `offset`. A marker follows the text it marks, so
 * this is the first marker at or after the offset; past the last marker, the
 * last one.
 */
export function markerAt(text: string, offset: number): FoundMarker | null {
  const markers = findMarkers(text);
  if (markers.length === 0) return null;
  return markers.find((marker) => marker.index >= offset) ?? markers[markers.length - 1]!;
}

export function hasMarker(text: string): boolean {
  return new RegExp(MARKER_SOURCE).test(text);
}

/**
 * Remove markers from a text. Use it where a translated string leaves the
 * page while editing is on: a comparison, a URL, a value sent to a server.
 */
export function stripMarkers(text: string): string {
  return text.replace(new RegExp(MARKER_SOURCE, 'g'), '');
}

/** Gives each (namespace, key) a small number and finds it again. */
export class MarkerRegistry {
  private readonly ids = new Map<string, number>();
  private readonly keys: MarkedKey[] = [];

  id(namespace: string, key: string, language?: string): number {
    // NUL cannot appear in a namespace, key or language name, so the parts are unambiguous.
    const lookup = `${namespace}\u0000${key}\u0000${language ?? ''}`;
    let id = this.ids.get(lookup);
    if (id === undefined) {
      id = this.keys.length;
      this.ids.set(lookup, id);
      this.keys.push(language ? { namespace, key, language } : { namespace, key });
    }
    return id;
  }

  key(id: number): MarkedKey | null {
    return this.keys[id] ?? null;
  }
}
