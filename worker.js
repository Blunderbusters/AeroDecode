/* CargoDecode relay — a Cloudflare Worker ------------------------------------------------
 *
 * Two jobs, both tiny, and it stores nothing it is not explicitly given storage for.
 *
 *   /cal?u=<calendar address>   Fetches a calendar feed and hands it back with the one
 *                               header the browser needs before it will let the app read
 *                               the response. Nothing is kept. Nothing is cached. The
 *                               address arrives, is used once, and is gone.
 *
 *   /hit                        Records a sign-in: the salted hash the app already
 *                               computes, the build version, the day. Only works if a KV
 *                               namespace is bound as SIGNINS — with no storage bound it
 *                               accepts the request and discards it, so the app never sees
 *                               an error and nothing is written.
 *
 *   /who?k=<VIEW_KEY>           Reads the counts back as plain text.
 *
 * The calendar relay needs no storage and no configuration. Deploy this as-is and the
 * calendar link works; add KV later if and when you want the sign-in counts.
 *
 * The host allowlist is deliberately narrow and is checked here as well as in the app.
 * Without it this becomes an open proxy that anybody could point at anything, on your
 * account and under your name.
 */

const ORIGIN = 'https://blunderbusters.github.io';
const CAL_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(google|icloud|apple|office365|outlook|live)\.com\//i;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    /* ---- calendar relay ---------------------------------------------------------- */
    if (url.pathname === '/cal') {
      const u = url.searchParams.get('u') || '';
      if (!CAL_HOSTS.test(u)) {
        return new Response('That is not a calendar host.', { status: 400, headers: cors });
      }
      let r;
      try {
        r = await fetch(u, { headers: { 'User-Agent': 'CargoDecode' } });
      } catch (e) {
        return new Response('Could not reach the calendar.', { status: 502, headers: cors });
      }
      if (!r.ok) {
        return new Response('The calendar answered ' + r.status + '.', { status: r.status, headers: cors });
      }
      return new Response(r.body, {
        status: 200,
        headers: Object.assign({}, cors, {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Cache-Control': 'no-store'          // nobody's roster sits in a cache
        })
      });
    }

    /* ---- sign-in counting -------------------------------------------------------- */
    if (url.pathname === '/hit' && req.method === 'POST') {
      if (!env.SIGNINS) return new Response('ok', { headers: cors });   // no storage bound
      let body = null;
      try { body = await req.json(); } catch (e) { /* ignore */ }
      const events = (body && Array.isArray(body.e)) ? body.e.slice(0, 20) : [];
      for (const ev of events) {
        if (!ev || !/^([0-9a-f]{16}|owner)$/.test(String(ev.u))) continue;
        const day = String(ev.t || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        /* Keyed by day and user, so one person opening the app nine times on Tuesday is
           one record, and unique users per day falls straight out of the key list. */
        await env.SIGNINS.put(day + '|' + ev.u,
          JSON.stringify({ u: ev.u, v: String(ev.v || ''), t: ev.t }));
      }
      return new Response('ok', { headers: cors });
    }

    /* ---- reading it back --------------------------------------------------------- */
    if (url.pathname === '/who') {
      const k = url.searchParams.get('k') || '';
      if (!env.VIEW_KEY || k !== env.VIEW_KEY) return new Response('', { status: 404 });
      if (!env.SIGNINS) return new Response('No storage bound yet.', { status: 200 });
      const list = await env.SIGNINS.list({ limit: 1000 });
      const byDay = {}, everyone = new Set();
      for (const key of list.keys) {
        const bits = key.name.split('|');
        const day = bits[0], who = bits[1];
        if (!byDay[day]) byDay[day] = new Set();
        byDay[day].add(who);
        everyone.add(who);
      }
      const days = Object.keys(byDay).sort().reverse();
      const lines = days.map(d => d + '   ' + byDay[d].size);
      return new Response(
        'CargoDecode sign-ins\n' +
        '====================\n' +
        'Distinct people ever: ' + everyone.size + '\n' +
        'Days recorded:        ' + days.length + '\n\n' +
        'DATE         PEOPLE\n' + lines.join('\n') + '\n\n' +
        'Hashes seen:\n' + Array.from(everyone).sort().join('\n') + '\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    return new Response('', { status: 404 });
  }
};
