/** Money is integer cents everywhere (spec §0.4). Never floats. */
export class Money {
  /** "$1,234.56" / "-$0.05". Throws on non-integer input so float bugs surface immediately. */
  static format(cents: number, symbol = '$'): string {
    if (!Number.isSafeInteger(cents)) {
      throw new TypeError(`Money.format expects integer cents, got ${cents}`);
    }
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const dollars = Math.floor(abs / 100)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const rem = (abs % 100).toString().padStart(2, '0');
    return `${sign}${symbol}${dollars}.${rem}`;
  }

  /** Margin in basis points (e.g. 2750 = 27.50%), integer math only. null when price is 0. */
  static marginBps(priceCents: number, costCents: number): number | null {
    if (!Number.isSafeInteger(priceCents) || !Number.isSafeInteger(costCents)) {
      throw new TypeError('Money.marginBps expects integer cents');
    }
    if (priceCents === 0) return null;
    return Math.round(((priceCents - costCents) * 10000) / priceCents);
  }

  static formatBps(bps: number): string {
    return `${(bps / 100).toFixed(1)}%`;
  }
}
