/* CargoDecode — sign-in reporting -------------------------------------------------------
   Answers one question for whoever maintains this: is anybody using it.

   What it sends: the salted hash the gate already computes from the employee number, the
   build version, and a timestamp. That is the whole payload. The hash is the same one that
   is already in allow.json, so the maintainer can match it back against the list they built
   without a raw employee number ever crossing the wire or sitting on a server.

   What it does not send, and has no access to: the roster, the flight plan, the fatigue
   answers, the sleep plan, hotel information, stations, or anything else the app holds.
   Those live in localStorage and this module never reads them.

   How it behaves, which matters more than what it sends:

     It cannot delay the app. The first send is scheduled well after load, it is never
     awaited, and it is never on the path the service worker uses. An app that hangs on the
     ground because a beacon is retrying is worse than no beacon.

     It cannot break the app offline. There is no network at FL350 and there is none on the
     ramp with airplane mode on. A failed send is remembered and goes out next time, and a
     queue that never drains is capped rather than growing forever.

     It cannot fire without an endpoint. ENDPOINT ships empty, which disables the module
     completely — no timers, no storage, nothing. */
(function(root){
  'use strict';

  var ENDPOINT='';                  // set to the collector URL to switch this on
  var EVERY_MS=6*3600000;           // at most one report per install per six hours
  var QUEUE_MAX=20;                 // stale sign-ins past this are dropped, oldest first
  var DELAY_MS=2500;                // let the app finish starting before touching the radio
  var TIMEOUT_MS=4000;

  function get(k,d){ try{ var v=localStorage.getItem(k); return v==null? d : v; }catch(e){ return d; } }
  function set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function queue(){ try{ return JSON.parse(get('ad_bq','[]'))||[]; }catch(e){ return []; } }
  function setQueue(q){ set('ad_bq', JSON.stringify(q.slice(-QUEUE_MAX))); }

  /* Who is signed in, as the hash the allowlist already holds. Returns null when nobody is
     signed in, which is the only state where there is nothing to report. */
  function who(){
    try{
      var c=JSON.parse(get('ad_unlock','null'));
      if(!c) return null;
      if(c.owner) return 'owner';
      if(c.id && root.AEROGATE && root.AEROGATE.idHash) return root.AEROGATE.idHash(c.id);
    }catch(e){}
    return null;
  }

  function send(batch){
    if(!ENDPOINT || !batch.length) return Promise.resolve(false);
    var body=JSON.stringify({ e:batch });
    /* sendBeacon is the right transport: the browser owns the request, it survives the page
       going away, and it cannot block anything the user is doing. It reports only that the
       request was handed over, not that it arrived, which is why the queue is cleared on
       the fetch path where the answer is real. */
    var ctl=(typeof AbortController!=='undefined')? new AbortController() : null;
    var timer=ctl? setTimeout(function(){ try{ ctl.abort(); }catch(e){} }, TIMEOUT_MS) : null;
    return fetch(ENDPOINT, { method:'POST', body:body, keepalive:true,
                             headers:{'Content-Type':'text/plain'},
                             signal:ctl? ctl.signal : undefined })
      .then(function(r){ if(timer) clearTimeout(timer); return !!(r && r.ok); })
      .catch(function(){ if(timer) clearTimeout(timer); return false; });
  }

  /* Called once per launch, and again straight after a sign-in. Everything inside is
     wrapped, because a reporting module has no business being able to break the app it
     reports on. */
  function ping(version, force){
    if(!ENDPOINT) return;
    setTimeout(function(){
      try{
        var u=who();
        if(!u) return;                                   // nobody signed in, nothing to say
        var last=+get('ad_blast','0')||0, lastV=get('ad_bver','');
        var now=Date.now();
        var due = force || !last || (now-last)>=EVERY_MS || lastV!==String(version||'');
        var q=queue();
        if(due){
          q.push({ u:u, v:String(version||''), t:new Date(now).toISOString() });
          set('ad_blast', String(now));
          set('ad_bver', String(version||''));
          setQueue(q);
          q=queue();
        }
        if(!q.length) return;
        send(q).then(function(ok){ if(ok) setQueue([]); });
      }catch(e){}
    }, force? 400 : DELAY_MS);
  }

  var API={ ping:ping, who:who, enabled:function(){ return !!ENDPOINT; },
            _queue:queue, ENDPOINT:ENDPOINT };
  if(typeof module!=='undefined'&&module.exports) module.exports=API;
  root.BEACON=API;
})(typeof window!=='undefined'?window:globalThis);
