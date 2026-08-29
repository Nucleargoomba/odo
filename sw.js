/* ODO service worker: app shell cached for offline, map tiles cached as you drive them */
const SHELL='odo-shell-v1', TILES='odo-tiles-v1';
const FILES=['./','./index.html','./app.css','./app.js','./manifest.webmanifest',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(SHELL).then(c=>c.addAll(FILES.map(u=>new Request(u,{cache:'reload'}))))
    .catch(()=>{}).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(
    ks.filter(k=>k!==SHELL&&k!==TILES).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET')return;

  // map tiles: serve from cache, fill it in the background, cap the size
  if(url.hostname.endsWith('tile.openstreetmap.org')){
    e.respondWith(caches.open(TILES).then(async c=>{
      const hit=await c.match(e.request);
      if(hit)return hit;
      try{
        const res=await fetch(e.request);
        if(res.ok){c.put(e.request,res.clone());trimTiles(c)}
        return res;
      }catch(err){return hit||Response.error()}
    }));
    return;
  }
  // never cache API answers
  if(url.hostname.includes('open-meteo')||url.hostname.includes('nominatim'))return;

  // app shell: cache first, refresh behind the scenes
  e.respondWith(caches.match(e.request).then(hit=>{
    const net=fetch(e.request).then(res=>{
      if(res.ok&&url.origin===location.origin)caches.open(SHELL).then(c=>c.put(e.request,res.clone()));
      return res;
    }).catch(()=>hit);
    return hit||net;
  }));
});
async function trimTiles(c){
  const ks=await c.keys();
  if(ks.length>1200)for(let i=0;i<200;i++)await c.delete(ks[i]);
}
