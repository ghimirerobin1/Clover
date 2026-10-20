import { readFileSync } from 'fs';
import { join } from 'path';

import { Tokens, type ColorScheme } from '../tokens';

/** global.css (NativeWind vars) must mirror Tokens.palette. */
function cssVars(css: string, scheme: ColorScheme): Record<string, string> {
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  const section = scheme === 'light' ? css.slice(0, darkStart) : css.slice(darkStart);
  const out: Record<string, string> = {};
  for (const m of section.matchAll(/--color-([\w-]+):\s*([\d ]+);/g)) {
    out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

describe('theme tokens', () => {
  const css = readFileSync(join(__dirname, '../../../global.css'), 'utf8');

  it.each(['light', 'dark'] as const)('%s palette matches global.css', (scheme) => {
    expect(cssVars(css, scheme)).toEqual(Tokens.palette[scheme]);
  });

  it('formats rgb strings', () => {
    expect(Tokens.rgb('light', 'text')).toBe('rgb(24, 24, 27)');
  });

  it('meets minimum touch sizes', () => {
    expect(Tokens.touchMin).toBeGreaterThanOrEqual(48);
    expect(Tokens.touchPrimary).toBeGreaterThanOrEqual(56);
  });
});
