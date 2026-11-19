// Same shape as the real helper: a Response that tells Vercel to continue routing
export function next() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}
