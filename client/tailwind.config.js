import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
export default {
  content: [path.join(here, 'index.html'), path.join(here, 'src/**/*.{js,jsx}')],
  theme: {
    extend: {
      colors: {
        pitch: { DEFAULT: '#0A1F17', 900: '#061510', 800: '#0E281D', 700: '#13402B', 600: '#1C553A', 500: '#2A6E4C' },
        turf: { DEFAULT: '#2FD67B', dim: '#1FA35D' },
        flood: { DEFAULT: '#FFD23F', dim: '#C9A12A' },
        leather: { DEFAULT: '#E0393E', dark: '#9E1E24' },
        chalk: { DEFAULT: '#F2F5EC', dim: '#A9BDB0', faint: '#6F8A7B' },
      },
      fontFamily: {
        display: ['"Barlow Condensed"', 'sans-serif'],
        body: ['Barlow', 'sans-serif'],
      },
    },
  },
};
