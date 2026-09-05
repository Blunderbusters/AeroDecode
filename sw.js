/* CargoDecode service worker.
   This has to be its own file at a same-origin URL. The previous build tried to register a
   worker built from a Blob URL, which browsers refuse outright — so the app had no service
   worker at all and its "offline" behaviour was really just the browser's HTTP cache. That
   held up in airplane mode, where a request fails instantly, and collapsed airborne with the
   radio still switched on, where a request neither succeeds nor fails: it hangs on DNS and
   TCP timeouts while the page sits blank.

   Two rules follow from that:
     1. The page is served CACHE-FIRST. A cached copy goes back immediately, every time, and
        the network is consulted afterwards to refresh it for next launch.
     2. Nothing waits on the network without a deadline. */
var V='cargodecode-v20-8';
var SHELL=['./','./index.html','./manifest.webmanifest','./apple-touch-icon.png',
           './icon-192.png','./icon-512.png','./hf-pac.jpg','./hf-atl.jpg','./hf-vhf.jpg','./hf-mex.jpg'];
var NET_MS=8000;
/* A SEPARATE, much longer deadline for the page itself.

   This is the bug that pinned phones to an old build. NET_MS exists to stop the app hanging
   on a dead radio - the state of a phone left out of airplane mode at altitude, where a
   fetch does not fail, it stalls on DNS and TCP. Eight seconds is right for the small
   requests the UI actually waits on.

   It was also being applied to index.html, which is now over 1.2 MB. Downloading that in
   under eight seconds needs a sustained connection INCLUDING TLS setup and origin latency,
   and a phone on cellular routinely misses it. Every miss rejected the promise, so the
   c.put never ran and the cached page was never replaced - not "one launch behind", but
   never, for as long as the app stayed installed. The app grew from about 1.0 MB to 1.25 MB
   over a few days, so this got quietly worse with every release.

   Nothing is waiting on the document refresh. It runs in waitUntil, in the background,
   after a cached page has already gone back to the user. It can afford to be patient. */
var PAGE_MS=60000;

function timed(req, ms){
  return new Promise(function(resolve, reject){
    var done=false, t=setTimeout(function(){ if(!done){ done=true; reject(new Error('timeout')); } }, ms||NET_MS);
    fetch(req).then(function(r){ if(done) return; done=true; clearTimeout(t); resolve(r); },
                    function(e){ if(done) return; done=true; clearTimeout(t); reject(e); });
  });
}

self.addEventListener('install', function(e){
  self.skipWaiting();
  // Pre-cache the shell so the FIRST launch after install is already flight-ready.
  e.waitUntil(caches.open(V).then(function(c){
    return Promise.all(SHELL.map(function(u){
      return timed(new Request(u, {cache:'reload'}), PAGE_MS)
        .then(function(r){ if(r && (r.ok || r.type==='opaque')) return c.put(u, r); })
        .catch(function(){});                       // a missing optional asset must not fail the install
    }));
  }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.map(function(k){ return k===V? null : caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener('message', function(e){
  if(e.data==='skipWaiting') self.skipWaiting();
  if(e.data==='purge') caches.keys().then(function(ks){ ks.forEach(function(k){ caches.delete(k); }); });
});

self.addEventListener('fetch', function(e){
  var req=e.request;
  if(req.method!=='GET') return;
  var url;
  try{ url=new URL(req.url); }catch(_){ return; }
  if(url.protocol!=='http:' && url.protocol!=='https:') return;

  /* Anything on another origin is none of this worker's business — the calendar relay and
     the sign-in beacon go straight to the network.

     Two separate things went wrong without this. The obvious one: a relay request that
     failed or ran past the eight-second deadline came back as Response.error(), and the app
     reported "response served by service worker is an error" rather than the real reason.
     The quiet one was worse — the branch below is CACHE-FIRST, so the first calendar pull
     would have been stored and every later pull would have returned that same stored copy.
     The roster would have looked like it was refreshing while silently never changing
     again, which is a far harder problem to notice than an error message. */
  /* One exception, and it is the reason a flight log vanished at altitude. The PDF reader
     and the OCR engine are loaded from a CDN on demand, and the app tells the crew member
     they need internet "once" and then work offline. That was not true: this early return
     fired first, so those files never reached this cache and the only thing holding them
     was the browser's own HTTP cache - which is exactly what the note at the top of this
     file says collapses airborne. Relaunch the app over the Atlantic and the OFP could no
     longer be read at all.

     Narrow on purpose. The relay and the sign-in beacon must stay network-only: caching a
     calendar pull would freeze the roster, which is the quiet failure described above. */
  /* unpkg serves these WITHOUT the /npm/ segment that jsdelivr uses, and it is the fallback
     the OCR loader falls back TO - so a pattern that only matched jsdelivr would have left
     the fallback uncached, which is the exact case it exists for. */
  var CDN_CACHE=/^https:\/\/(cdn\.jsdelivr\.net\/npm|unpkg\.com)\/(pdfjs-dist|tesseract\.js)/;
  if(url.origin!==self.location.origin && !CDN_CACHE.test(req.url)) return;

  var isDoc = req.mode==='navigate' || req.destination==='document';

  /* Only the app's OWN address gets the app. This branch used to answer every navigation
     anywhere in scope with the cached index.html, so any other page on this origin came
     back as CargoDecode - and worse, the refresh below then cached whatever that address
     returned AS the app, which is a cache poisoned by visiting a wrong URL once. */
  var base=new URL('./', self.location).pathname;
  if(isDoc && url.pathname!==base && url.pathname!==base+'index.html') return;

  /* An escape hatch that is a LINK rather than a reinstall.

     When updates jam - and they did, for exactly the reason PAGE_MS documents above - the
     only reliable recovery on an installed iOS app was deleting the home-screen icon and
     adding it again, which also takes the roster with it. Opening the app's address with
     ?fresh=1 now bypasses the cache for the document, takes whatever the server has, and
     stores THAT as the cached page. Nothing else is touched, so nothing is lost. */
  if(isDoc && /(^|[?&])fresh=1(&|$)/.test(url.search)){
    e.respondWith(
      caches.open(V).then(function(c){
        return timed(new Request(url.pathname+'?fresh='+Date.now(), {cache:'no-store'}), PAGE_MS)
          .then(function(resp){
            if(resp && resp.ok){ try{ c.put('./index.html', resp.clone()); }catch(_){} }
            return resp;
          })
          .catch(function(){ return c.match('./index.html').then(function(r){ return r || Response.error(); }); });
      })
    );
    return;
  }

  if(isDoc){
    e.respondWith(
      caches.open(V).then(function(c){
        return c.match('./index.html').then(function(hit){
          return (hit? Promise.resolve(hit) : c.match('./')).then(function(cached){
            cached = cached || hit;
            var net = timed(new Request(url.pathname+'?sw='+Date.now(), {cache:'no-store'}), PAGE_MS)
              .then(function(resp){
                if(resp && resp.ok){ try{ c.put('./index.html', resp.clone()); }catch(_){} }
                return resp;
              });
            // A cached page goes back NOW. The refresh continues in the background.
            if(cached){ e.waitUntil(net.catch(function(){})); return cached; }
            return net.catch(function(){
              return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'+
                '<body style="font:16px system-ui;background:#0a1730;color:#dce8fb;padding:26px">'+
                '<h2>CargoDecode is not cached yet</h2><p>Open this page once with a working connection and it will be '+
                'available offline from then on.</p></body>',
                {headers:{'Content-Type':'text/html; charset=utf-8'}});
            });
          });
        });
      })
    );
    return;
  }

  /* The version probe is network-only. It exists to answer "is there a newer build", and a
     cache-first answer to that question is worse than no answer: it would report the version
     that was current when the app was installed, forever, and look authoritative doing it. */
  if(/\/version\.txt$/.test(url.pathname)) return;

  // Everything else: cache-first, network time-boxed, opaque CDN responses cached too.
  e.respondWith(
    caches.open(V).then(function(c){
      return c.match(req).then(function(hit){
        if(hit) return hit;
        return timed(req, NET_MS).then(function(resp){
          if(resp && (resp.ok || resp.type==='opaque')){ try{ c.put(req, resp.clone()); }catch(_){} }
          return resp;
        }).catch(function(){
          return c.match(req).then(function(r){ return r || Response.error(); });
        });
      });
    })
  );
});
