// MapLibre loads its worker from a separate file, which Next.js doesn't bundle.
// Copy the installed version into public/ so it always matches the library.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'));
mkdirSync('public', { recursive: true });
copyFileSync(join(dist, 'maplibre-gl-worker.mjs'), join('public', 'maplibre-gl-worker.mjs'));
