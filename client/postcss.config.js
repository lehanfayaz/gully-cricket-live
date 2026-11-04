import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
export default { plugins: { tailwindcss: { config: path.join(here, 'tailwind.config.js') }, autoprefixer: {} } };
