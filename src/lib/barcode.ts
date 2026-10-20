/**
 * Barcode normalization (spec §4.3). Pure, deterministic, unit-tested.
 *
 * Scanners disagree on representation: iOS reports UPC-A as a 13-digit EAN-13 with a leading 0,
 * UPC-E arrives compressed, and Clover may store either form. So `normalize` returns every
 * equivalent `candidates` form to look up, most specific first.
 */
export type BarcodeFormat = 'upc_a' | 'ean13' | 'ean8' | 'upc_e' | 'other';

/** Scanner-reported type hint (expo-camera BarcodeType subset we care about). */
export type ScannerType = 'upc_a' | 'upc_e' | 'ean13' | 'ean8' | 'code128' | 'code39' | 'qr' | string;

export interface VariableWeightRule {
  /** Leading UPC-A digits that mark price/weight-embedded codes. Default ['2']. */
  prefixes: string[];
  /** Item-reference digits after the prefix. Default 5 (2 IIIII PPPPP C). */
  itemDigits: number;
}

export const DEFAULT_VARIABLE_WEIGHT_RULE: VariableWeightRule = { prefixes: ['2'], itemDigits: 5 };

export interface VariableWeightInfo {
  /** Prefix + item reference, e.g. "201234". */
  itemCode: string;
  /** Embedded price/weight digits (not interpreted: encoding varies by store). */
  embedded: string;
}

export interface NormalizedBarcode {
  raw: string;
  cleaned: string;
  format: BarcodeFormat;
  /** null when the format has no check digit (Code128, QR, …). */
  checkDigitValid: boolean | null;
  /** Canonical GTIN: 12-digit UPC-A for the UPC family (incl. expanded UPC-E), else EAN-13/EAN-8. */
  gtin: string | null;
  /** Codes to try, in order. Always includes `cleaned`. */
  candidates: string[];
  variableWeight: VariableWeightInfo | null;
}

const DIGITS = /^\d+$/;

export class Barcode {
  /** Strip whitespace and invisible control chars (some scanners/keyboards add them). */
  static clean(raw: string): string {
    return raw.replace(/[\s\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, '');
  }

  /** GTIN mod-10 check digit for a body (all digits except the check digit). */
  static checkDigit(body: string): number {
    if (!DIGITS.test(body)) throw new TypeError('checkDigit expects digits');
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      const digit = body.charCodeAt(body.length - 1 - i) - 48;
      sum += digit * (i % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10;
  }

  /** Valid GTIN-8/12/13/14 (length + check digit). */
  static isValidGtin(code: string): boolean {
    if (!DIGITS.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
    return Barcode.checkDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
  }

  static withCheckDigit(body: string): string {
    return `${body}${Barcode.checkDigit(body)}`;
  }

  /**
   * UPC-E → UPC-A. Accepts 6 digits (number system 0 assumed, check computed), 7 (NS + 6, check computed)
   * or 8 (NS + 6 + check, check preserved). Returns null if not expandable (NS must be 0 or 1).
   */
  static expandUpcE(code: string): string | null {
    if (!DIGITS.test(code) || code.length < 6 || code.length > 8) return null;
    const ns = code.length === 6 ? '0' : (code[0] as string);
    if (ns !== '0' && ns !== '1') return null;
    const d = code.length === 6 ? code : code.slice(1, 7);
    const [d1, d2, d3, d4, d5, d6] = d.split('') as [string, string, string, string, string, string];
    let body: string;
    switch (d6) {
      case '0':
      case '1':
      case '2':
        body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
        break;
      case '3':
        body = `${d1}${d2}${d3}00000${d4}${d5}`;
        break;
      case '4':
        body = `${d1}${d2}${d3}${d4}00000${d5}`;
        break;
      default:
        body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
    }
    const upcaBody = `${ns}${body}`;
    const check = code.length === 8 ? (code[7] as string) : String(Barcode.checkDigit(upcaBody));
    return `${upcaBody}${check}`;
  }

  static upcAToEan13(upca: string): string {
    return `0${upca}`;
  }

  /** EAN-13 with a leading 0 is a UPC-A; otherwise null. */
  static ean13ToUpcA(ean13: string): string | null {
    return ean13.length === 13 && ean13.startsWith('0') ? ean13.slice(1) : null;
  }

  static variableWeight(upca: string, rule: VariableWeightRule = DEFAULT_VARIABLE_WEIGHT_RULE): VariableWeightInfo | null {
    if (upca.length !== 12 || !DIGITS.test(upca)) return null;
    const prefix = rule.prefixes.find((p) => p.length > 0 && upca.startsWith(p));
    if (prefix == null) return null;
    const end = prefix.length + rule.itemDigits;
    if (end >= 11) return null;
    return { itemCode: upca.slice(0, end), embedded: upca.slice(end, 11) };
  }

  static normalize(raw: string, opts: { type?: ScannerType; rule?: VariableWeightRule } = {}): NormalizedBarcode {
    const cleaned = Barcode.clean(raw);
    const rule = opts.rule ?? DEFAULT_VARIABLE_WEIGHT_RULE;
    const base = { raw, cleaned };
    const other = (): NormalizedBarcode => ({
      ...base,
      format: 'other',
      checkDigitValid: null,
      gtin: null,
      candidates: cleaned ? [cleaned] : [],
      variableWeight: null,
    });
    if (!DIGITS.test(cleaned)) return other();

    let format: BarcodeFormat;
    let upca: string | null = null;
    let gtin: string;
    const extra: string[] = [];

    if (cleaned.length === 12) {
      format = 'upc_a';
      upca = cleaned;
      gtin = cleaned;
    } else if (cleaned.length === 13) {
      upca = Barcode.ean13ToUpcA(cleaned);
      format = upca ? 'upc_a' : 'ean13';
      gtin = upca ?? cleaned;
    } else if (cleaned.length === 14 && cleaned.startsWith('00')) {
      // GTIN-14 wrapper around a UPC-A.
      upca = cleaned.slice(2);
      format = 'upc_a';
      gtin = upca;
    } else if (cleaned.length === 6 || cleaned.length === 7 || cleaned.length === 8) {
      const expanded = Barcode.expandUpcE(cleaned);
      const upcEValid = expanded != null && Barcode.isValidGtin(expanded);
      const asUpcE =
        expanded != null &&
        (opts.type === 'upc_e' ||
          cleaned.length < 8 ||
          (opts.type !== 'ean8' && upcEValid && !Barcode.isValidGtin(cleaned)));
      if (asUpcE) {
        format = 'upc_e';
        upca = expanded;
        gtin = expanded;
      } else if (cleaned.length === 8) {
        format = 'ean8';
        gtin = cleaned;
        // Ambiguous 8-digit code with no type hint: also try the UPC-E reading.
        if (opts.type === undefined && upcEValid && expanded) extra.push(expanded, Barcode.upcAToEan13(expanded));
      } else {
        return other();
      }
    } else {
      return other();
    }

    const checkDigitValid = Barcode.isValidGtin(gtin);
    const candidates = new Set<string>([cleaned]);
    if (upca) {
      candidates.add(upca);
      candidates.add(Barcode.upcAToEan13(upca));
      if (format === 'upc_e') candidates.add(cleaned);
    } else {
      candidates.add(gtin);
    }
    for (const c of extra) candidates.add(c);

    const variableWeight = upca ? Barcode.variableWeight(upca, rule) : null;
    if (variableWeight) {
      // The full code changes with every weight/price, so look up by the item portion.
      const pad = '0'.repeat(11 - variableWeight.itemCode.length);
      const zeroed = Barcode.withCheckDigit(`${variableWeight.itemCode}${pad}`);
      candidates.clear();
      for (const c of [variableWeight.itemCode, zeroed, `${variableWeight.itemCode}${pad}0`, Barcode.upcAToEan13(zeroed)]) {
        candidates.add(c);
      }
    }

    return { ...base, format, checkDigitValid, gtin, candidates: [...candidates], variableWeight };
  }

  /** Parse "2, 02" style settings text into a rule; falls back to the default for empty input. */
  static parseRule(text: string | null | undefined, itemDigits = DEFAULT_VARIABLE_WEIGHT_RULE.itemDigits): VariableWeightRule {
    const prefixes = (text ?? '')
      .split(/[\s,]+/)
      .filter((p) => /^\d{1,3}$/.test(p));
    return prefixes.length ? { prefixes, itemDigits } : DEFAULT_VARIABLE_WEIGHT_RULE;
  }
}
