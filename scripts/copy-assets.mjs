// Copies non-TypeScript runtime assets into dist/ after a build.
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/i18n/locales', { recursive: true });
await cp('src/i18n/locales', 'dist/i18n/locales', { recursive: true });
await cp('src/console', 'dist/console', { recursive: true });
console.log('assets copied to dist/');
