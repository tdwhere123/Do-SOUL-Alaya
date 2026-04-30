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
        }
      },
    },
  },
  plugins: [],
}
