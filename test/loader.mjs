const STUB = new URL("./stubs/vercel-functions.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@vercel/functions") {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
