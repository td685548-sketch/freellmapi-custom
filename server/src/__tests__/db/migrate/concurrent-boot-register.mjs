// Loaded via --import before the concurrent-boot worker's entry module so
// the `.js` -> `.ts` resolve hook (concurrent-boot-hooks.mjs) is in place
// before the worker imports the TypeScript runner.
import { register } from 'node:module';

register('./concurrent-boot-hooks.mjs', import.meta.url);
