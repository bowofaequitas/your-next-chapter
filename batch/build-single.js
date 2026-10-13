// Builds dist/worker-single.js: the Worker with the game and admin page embedded,
// so it can be pasted into the Cloudflare dashboard editor (no asset upload needed).
const fs = require('fs');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const game = fs.readFileSync('../index.html', 'utf8');
const admin = fs.readFileSync('public/admin.html', 'utf8');
const html = (s) => 'new Response(' + JSON.stringify(s) + ", {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}})";
const patched = worker.replace(
  "return json({ error: 'Not found' }, 404);\n    } catch (e) {",
  "return json({ error: 'Not found' }, 404);\n    } catch (e) {"
).replace(
  "    try {\n      // ---- public: is this batch link valid? ----",
  "    if (!path.startsWith('/api/')) {\n      if (path === '/admin' || path === '/admin.html') return " + html(admin) + ";\n      return " + html(game) + ";\n    }\n\n    try {\n      // ---- public: is this batch link valid? ----"
);
if (patched === worker) throw new Error('patch failed');
fs.writeFileSync('dist/worker-single.js', patched);
console.log('bytes', patched.length);
