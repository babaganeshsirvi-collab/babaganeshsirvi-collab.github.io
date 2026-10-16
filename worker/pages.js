import app from './app.js';

// Pages consumes the existing Worker namespace; it cannot declare a DO class.
// Control files are deployment inputs rather than public download endpoints.
export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/_worker.js' || path.startsWith('/_worker.js/') ||
        ['/_routes.json', '/_headers', '/_redirects'].includes(path) || path.startsWith('/wrangler')) {
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return app.fetch(request, env);
  },
};
