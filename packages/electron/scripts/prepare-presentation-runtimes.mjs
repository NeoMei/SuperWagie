import { fileURLToPath } from 'node:url';
import { preparePresentationRuntimes } from '../../web/scripts/prepare-presentation-runtimes.mjs';

await preparePresentationRuntimes({ destination: fileURLToPath(new URL('../resources/presentation-runtime', import.meta.url)) });
