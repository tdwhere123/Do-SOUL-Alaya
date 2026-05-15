/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        beige: {
          50: '#FDFDF3',
          100: '#FDF6E3',
          150: '#EEE8D5',
          200: '#E8E2D0',
          300: '#D4CDB8',
        },
        ink: {
          500: '#93A1A1',
          600: '#586E75',
          700: '#657B83',
        },
        morandi: {
          green: '#96AD90',
          pink: '#C9ADA7',
          blue: '#92A8B3',
          sage: '#B5BD89',
          orange: '#E0C7B0',
        },
        state: {
          ok: '#859900',
          warm: '#C9A36F',
          warning: '#D4AF37',
          emphasis: '#B58900',
          'emphasis-text': '#7A5A0F',
          error: '#DC322F',
          'error-soft': '#C9ADA7',
          'error-text': '#8B4536',
          info: '#4A90A4',
        }
      },
    },
  },
  plugins: [],
}
