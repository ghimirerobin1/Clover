const colorNames = [
  'bg',
  'surface',
  'surface-muted',
  'border',
  'text',
  'text-muted',
  'accent',
  'accent-fg',
  'success',
  'warning',
  'danger',
];

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: Object.fromEntries(
        colorNames.map((name) => [name, `rgb(var(--color-${name}) / <alpha-value>)`]),
      ),
      minHeight: { touch: '48px', primary: '56px' },
      minWidth: { touch: '48px', primary: '56px' },
    },
  },
  plugins: [],
};
