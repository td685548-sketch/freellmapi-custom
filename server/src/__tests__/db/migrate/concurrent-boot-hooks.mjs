// Resolve hook for the concurrent-boot worker (concurrent-boot-worker.ts):
// the server sources import each other with `.js` extensions, but raw node
// does not resolve a `.js` specifier to its `.ts` source file. This hook
// retries a failed `.js` resolution as `.ts` so the worker can import the
// TypeScript runner directly, with no build step.
//
// Plain JavaScript on purpose: it is loaded by raw node via --import, before
// any TypeScript is involved.
export async function resolve(specifier, context, next) {
  if (typeof specifier === 'string' && specifier.endsWith('.js')) {
    try {
      return await next(specifier.slice(0, -3) + '.ts', context);
    } catch {
      // No `.ts` sibling — fall through to the original specifier.
    }
  }
  return next(specifier, context);
}
