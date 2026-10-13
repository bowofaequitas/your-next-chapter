// Builds worker-dashboard.js: same API, but the game (/) and admin (/admin) pages are fetched
// from the public repo, so the Worker stays small enough to paste into the Cloudflare dashboard editor.
const fs = require('fs');
let w = fs.readFileSync('src/worker.js', 'utf8');
const RAW = 'https://raw.githubusercontent.com/bowofaequitas/your-next-chapter/main/';
const marker = "    try {\n      // ---- public: is this batch link valid? ----";
if (!w.includes(marker)) throw new Error('marker missing');
w = w.replace(marker, `    if (!path.startsWith('/api/')) {
      const file = (path === '/admin' || path === '/admin.html') ? 'batch/public/admin.html' : 'index.html';
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const r = await fetch('${RAW}' + file, { cf: { cacheTtl: 60, cacheEverything: true } });
      if (!r.ok) return new Response('Page unavailable', { status: 502 });
      return new Response(r.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
    }

` + marker);
fs.writeFileSync('worker-dashboard.js', w);
console.log(w.length);
