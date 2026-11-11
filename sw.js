/* Taash Adda service worker: app turant khule (cache se), peeche se naya version aa jaye.
   Render ka free server so jaye tab bhi app ka pehla screen kaala nahi dikhega. */
const V = 'taash-v4';
const SHELL = ['/', '/manifest.json', '/icon-192.png'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || u.pathname === '/ws' || u.pathname === '/healthz' || u.pathname === '/sw.js') return;
  const key = r.mode === 'navigate' ? '/' : r;        // ?pin=1234 jaise link bhi wahi page kholte hain
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(key);
    const net = fetch(r).then(res => { if (res && res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }          // cache hai: turant dikhao, peeche se naya le aao
    const res = await net;
    return res || new Response('<meta name=viewport content="width=device-width"><body style="background:#0e4a32;color:#fff;font:20px system-ui;text-align:center;padding:40px">Server abhi jaag raha hai…<br>Thodi der baad dobara kholiye 🙏</body>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});
