import { Barcode, DEFAULT_VARIABLE_WEIGHT_RULE } from '../barcode';

describe('Barcode.clean', () => {
  it('strips whitespace and invisible characters', () => {
    expect(Barcode.clean(' 0360 0029\t1452\n')).toBe('036000291452');
    expect(Barcode.clean('\u200b036000291452\ufeff\u0000')).toBe('036000291452');
  });
});

describe('check digits', () => {
  it.each([
    ['03600029145', 2], // UPC-A 036000291452
    ['400638133393', 1], // EAN-13 4006381333931
    ['9638507', 4], // EAN-8 96385074
    ['00000000000', 0],
  ])('checkDigit(%s) = %d', (body, check) => {
    expect(Barcode.checkDigit(body)).toBe(check);
  });

  it.each(['036000291452', '4006381333931', '96385074', '0036000291452', '10036000291459'])('valid %s', (c) => {
    expect(Barcode.isValidGtin(c)).toBe(true);
  });

  it.each(['036000291453', '4006381333932', '96385075', '12345', 'ABCDEFGHIJKL', ''])('invalid %s', (c) => {
    expect(Barcode.isValidGtin(c)).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(() => Barcode.checkDigit('12a')).toThrow(TypeError);
  });
});

describe('UPC-E expansion', () => {
  it.each([
    // [UPC-E, UPC-A]
    ['04252614', '042100005264'], // last digit 0-2 rule (d6 = 1)
    ['01234565', '012345000065'], // last digit 5-9 rule
    ['01200003', '012000000003'], // d6 = 0
    ['01234338', null], // d6 = 3 → check computed below
  ])('%s → %s', (upce, upca) => {
    const expanded = Barcode.expandUpcE(upce);
    if (upca) expect(expanded).toBe(upca);
    else expect(expanded).toBe(`01230000043${upce[7]}`);
  });

  it('applies each rule to the manufacturer/product split', () => {
    // d6 = 3: mfr d1 d2 d3 0 0, product 0 0 0 d4 d5
    expect(Barcode.expandUpcE('0123453')?.slice(0, 11)).toBe('01230000045');
    // d6 = 4: mfr d1..d4 0, product 0 0 0 0 d5
    expect(Barcode.expandUpcE('0123454')?.slice(0, 11)).toBe('01234000005');
    // d6 = 2
    expect(Barcode.expandUpcE('0123452')?.slice(0, 11)).toBe('01220000345');
  });

  it('6 and 7 digit forms assume/keep number system and compute the check digit', () => {
    expect(Barcode.expandUpcE('425261')).toBe('042100005264');
    expect(Barcode.expandUpcE('0425261')).toBe('042100005264');
    expect(Barcode.isValidGtin(Barcode.expandUpcE('1234565') as string)).toBe(true);
  });

  it('rejects number systems other than 0/1 and bad lengths', () => {
    expect(Barcode.expandUpcE('24252614')).toBeNull();
    expect(Barcode.expandUpcE('12345')).toBeNull();
    expect(Barcode.expandUpcE('123456789')).toBeNull();
    expect(Barcode.expandUpcE('04a52614')).toBeNull();
  });
});

describe('Barcode.normalize', () => {
  it('UPC-A yields UPC-A and EAN-13 candidates', () => {
    const n = Barcode.normalize('036000291452');
    expect(n).toMatchObject({ format: 'upc_a', gtin: '036000291452', checkDigitValid: true, variableWeight: null });
    expect(n.candidates).toEqual(['036000291452', '0036000291452']);
  });

  it('EAN-13 with leading 0 (iOS UPC-A) is treated as UPC-A', () => {
    const n = Barcode.normalize('0036000291452', { type: 'ean13' });
    expect(n.format).toBe('upc_a');
    expect(n.candidates).toEqual(['0036000291452', '036000291452']);
  });

  it('true EAN-13', () => {
    const n = Barcode.normalize('4006381333931');
    expect(n).toMatchObject({ format: 'ean13', gtin: '4006381333931', checkDigitValid: true });
    expect(n.candidates).toEqual(['4006381333931']);
  });

  it('UPC-E is expanded and all forms are candidates', () => {
    const n = Barcode.normalize('04252614', { type: 'upc_e' });
    expect(n).toMatchObject({ format: 'upc_e', gtin: '042100005264', checkDigitValid: true });
    expect(n.candidates).toEqual(['04252614', '042100005264', '0042100005264']);
  });

  it('EAN-8 when hinted or when it validates as EAN-8', () => {
    expect(Barcode.normalize('96385074', { type: 'ean8' })).toMatchObject({ format: 'ean8', checkDigitValid: true });
    expect(Barcode.normalize('96385074').format).toBe('ean8'); // NS 9 can't be UPC-E
  });

  it('ambiguous 8-digit without hint: prefers UPC-E when only UPC-E validates', () => {
    expect(Barcode.isValidGtin('04252614')).toBe(false);
    expect(Barcode.normalize('04252614').format).toBe('upc_e');
  });

  it('reports invalid check digits but still returns candidates', () => {
    const n = Barcode.normalize('036000291453');
    expect(n.checkDigitValid).toBe(false);
    expect(n.candidates).toContain('036000291453');
  });

  it('GTIN-14 wrapping a UPC-A', () => {
    expect(Barcode.normalize('00036000291452')).toMatchObject({ format: 'upc_a', gtin: '036000291452' });
  });

  it.each([
    ['RICE-JAS-20', 'RICE-JAS-20'],
    [' https://example.com/x ', 'https://example.com/x'],
    ['12345', '12345'],
  ])('non-GTIN %p is passed through as "other"', (raw, cleaned) => {
    expect(Barcode.normalize(raw)).toMatchObject({ format: 'other', checkDigitValid: null, candidates: [cleaned] });
  });

  it('empty input has no candidates', () => {
    expect(Barcode.normalize('  ').candidates).toEqual([]);
  });
});

describe('variable-weight (price-embedded) codes', () => {
  // 2 01234 01299 C → item 01234, embedded price 01299
  const code = Barcode.withCheckDigit('20123401299');

  it('detects prefix-2 UPC-A and extracts the item portion', () => {
    const n = Barcode.normalize(code);
    expect(n.variableWeight).toEqual({ itemCode: '201234', embedded: '01299' });
    expect(n.checkDigitValid).toBe(true);
  });

  it('looks up by item portion, not the full (price-varying) code', () => {
    const n = Barcode.normalize(code);
    expect(n.candidates).not.toContain(code);
    expect(n.candidates).toEqual(['201234', Barcode.withCheckDigit('20123400000'), '201234000000', `0${Barcode.withCheckDigit('20123400000')}`]);
    // Two different weights of the same item produce the same candidates.
    expect(Barcode.normalize(Barcode.withCheckDigit('20123400750')).candidates).toEqual(n.candidates);
  });

  it('also detects the EAN-13 form (leading 0)', () => {
    expect(Barcode.normalize(`0${code}`).variableWeight?.itemCode).toBe('201234');
  });

  it('non-prefix codes are not variable-weight', () => {
    expect(Barcode.normalize('036000291452').variableWeight).toBeNull();
  });

  it('prefix rule is configurable', () => {
    const rule = { prefixes: ['02', '2'], itemDigits: 4 };
    expect(Barcode.variableWeight('020123401299', rule)).toEqual({ itemCode: '020123', embedded: '40129' });
    expect(Barcode.normalize('036000291452', { rule: { prefixes: ['0'], itemDigits: 5 } }).variableWeight?.itemCode).toBe('036000');
    expect(Barcode.normalize(code, { rule: { prefixes: ['4'], itemDigits: 5 } }).variableWeight).toBeNull();
  });

  it('parseRule', () => {
    expect(Barcode.parseRule('2, 02 x')).toEqual({ prefixes: ['2', '02'], itemDigits: 5 });
    expect(Barcode.parseRule('')).toBe(DEFAULT_VARIABLE_WEIGHT_RULE);
    expect(Barcode.parseRule(null)).toBe(DEFAULT_VARIABLE_WEIGHT_RULE);
  });
});
