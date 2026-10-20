/**
 * Design tokens — single source of truth for colors, spacing, sizing.
 *
 * Colors are stored as "R G B" triplets so they can back both
 * NativeWind CSS variables (global.css) and direct JS styles (tab bar, etc.).
 * `global.css` MUST mirror `Tokens.palette`; `src/theme/__tests__/tokens.test.ts`
 * fails if they drift.
 */
export type ColorScheme = 'light' | 'dark';

export type SemanticColor =
  | 'bg'
  | 'surface'
  | 'surface-muted'
  | 'border'
  | 'text'
  | 'text-muted'
  | 'accent'
  | 'accent-fg'
  | 'success'
  | 'warning'
  | 'danger';

type Palette = Record<SemanticColor, string>;

export class Tokens {
  static readonly palette: Record<ColorScheme, Palette> = {
    light: {
      bg: '250 250 250',
      surface: '255 255 255',
      'surface-muted': '241 241 243',
      border: '228 228 231',
      text: '24 24 27',
      'text-muted': '113 113 122',
      accent: '22 128 92',
      'accent-fg': '255 255 255',
      success: '22 163 74',
      warning: '217 119 6',
      danger: '220 38 38',
    },
    dark: {
      bg: '12 12 14',
      surface: '24 24 27',
      'surface-muted': '39 39 42',
      border: '52 52 56',
      text: '244 244 245',
      'text-muted': '161 161 170',
      accent: '52 199 140',
      'accent-fg': '12 12 14',
      success: '74 222 128',
      warning: '251 191 36',
      danger: '248 113 113',
    },
  };

  /** Minimum touch target (pt). Spec §5. */
  static readonly touchMin = 48;
  /** Primary action height (pt). Spec §5. */
  static readonly touchPrimary = 56;
  /** Motion durations (ms). Spec §5: 150–250ms. */
  static readonly motion = { fast: 150, base: 200, slow: 250 } as const;

  /** `rgb(r, g, b)` string for direct JS styling. */
  static rgb(scheme: ColorScheme, color: SemanticColor): string {
    return `rgb(${Tokens.palette[scheme][color].split(' ').join(', ')})`;
  }
}
