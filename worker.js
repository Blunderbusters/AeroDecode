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
        const n = Math.max(1, Math.min(500, parseInt(ev.n, 10) || 1));
        const first = /^\d{4}-\d{2}-\d{2}$/.test(String(ev.f || '')) ? String(ev.f) : day;
        /* Keyed by day and user, so one person opening the app nine times on Tuesday is
           one record, and unique users per day falls straight out of the key list. The
           count of opens rides inside the value, so engagement costs no extra writes.
           Written into the key METADATA as well: list() returns metadata inline, so the
           whole report below is built from key listings without a single read. */
        await env.SIGNINS.put(day + '|' + ev.u,
          JSON.stringify({ u: ev.u, v: String(ev.v || ''), t: ev.t, n: n, f: first }),
          { metadata: { v: String(ev.v || '').slice(0, 16), n: n, f: first } });
      }
      return new Response('ok', { headers: cors });
    }

    /* ---- reading it back --------------------------------------------------------- */
    if (url.pathname === '/who') {
      const k = url.searchParams.get('k') || '';
      /* The CORS header belongs on THESE responses too. Without it the report could be read
         by opening the URL in the address bar - a top-level navigation, which no origin
         check applies to - but NOT by the app's own owner card, which reads it with fetch
         from the GitHub Pages origin. That failed as a bare "Failed to fetch" with nothing
         to say why. */
      const rep = Object.assign({}, cors, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!env.VIEW_KEY || k !== env.VIEW_KEY) return new Response('', { status: 404, headers: cors });
      if (!env.SIGNINS) return new Response('No storage bound yet.', { status: 200, headers: rep });

      /* Paginated. A single list({limit:1000}) silently truncated: at one key per person
         per day, thirty people reach the cap in five weeks and the report would have gone
         quietly wrong - undercounting, with nothing on screen to say so. */
      const keys = [];
      let cursor = null, guard = 0;
      do {
        const page = await env.SIGNINS.list(cursor ? { limit: 1000, cursor } : { limit: 1000 });
        for (const k of page.keys) keys.push(k);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor && ++guard < 50);

      const byDay = {}, people = new Map();
      let totalOpens = 0;
      for (const key of keys) {
        const bits = key.name.split('|');
        const day = bits[0], who = bits[1];
        if (!day || !who) continue;
        const md = key.metadata || {};
        const opens = Math.max(1, parseInt(md.n, 10) || 1);
        totalOpens += opens;
        if (!byDay[day]) byDay[day] = { people: new Set(), opens: 0 };
        byDay[day].people.add(who);
        byDay[day].opens += opens;
        let p = people.get(who);
        if (!p) { p = { days: 0, opens: 0, first: md.f || day, last: day, v: md.v || '' }; people.set(who, p); }
        p.days++; p.opens += opens;
        if (day < p.first) p.first = day;
        if (day > p.last) p.last = day;
        if (md.v) p.v = md.v;
        if (md.f && md.f < p.first) p.first = md.f;
      }

      const days = Object.keys(byDay).sort().reverse();
      const today = new Date().toISOString().slice(0, 10);
      const ago = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      const uniqueSince = since => {
        const s = new Set();
        for (const d of days) if (d >= since) for (const w of byDay[d].people) s.add(w);
        return s.size;
      };
      const newSince = since => {
        let n = 0;
        for (const p of people.values()) if (p.first >= since) n++;
        return n;
      };
      const versions = {};
      for (const p of people.values()) versions[p.v || '(unknown)'] = (versions[p.v || '(unknown)'] || 0) + 1;

      const pad = (s, n) => String(s).padEnd(n);
      const roster = Array.from(people.entries())
        .sort((a, b) => (b[1].last.localeCompare(a[1].last)) || (b[1].opens - a[1].opens))
        .map(([who, p]) => pad(who, 18) + pad(p.first, 12) + pad(p.last, 12) +
                           pad(p.days, 7) + pad(p.opens, 7) + (p.v || ''));

      const out =
        'CargoDecode  ·  sign-in report\n' +
        'generated ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z\n' +
        '==================================================================\n\n' +
        'PEOPLE\n' +
        '  Distinct people ever      ' + people.size + '\n' +
        '  Active in the last 7 days ' + uniqueSince(ago(7)) + '\n' +
        '  Active in the last 30 days ' + uniqueSince(ago(30)) + '\n' +
        '  New in the last 7 days    ' + newSince(ago(7)) + '\n' +
        '  New in the last 30 days   ' + newSince(ago(30)) + '\n' +
        '  Active today (' + today + ')  ' + (byDay[today] ? byDay[today].people.size : 0) + '\n\n' +
        'USE\n' +
        '  App opens recorded        ' + totalOpens + '\n' +
        '  Days with any activity    ' + days.length + '\n' +
        '  Records held              ' + keys.length + (guard >= 50 ? '  (listing hit its page guard — counts are a floor)' : '') + '\n\n' +
        'BUILD IN USE\n' +
        Object.keys(versions).sort().map(v => '  ' + pad(v, 12) + versions[v] + ' people').join('\n') + '\n\n' +
        'BY DAY   (most recent first)\n' +
        '  DATE         PEOPLE   OPENS\n' +
        days.slice(0, 60).map(d => '  ' + pad(d, 13) + pad(byDay[d].people.size, 9) + byDay[d].opens).join('\n') +
        (days.length > 60 ? '\n  ... ' + (days.length - 60) + ' earlier days not listed' : '') + '\n\n' +
        'BY PERSON   (hash matches allow.json; no employee number is ever sent or stored)\n' +
        '  ' + pad('HASH', 18) + pad('FIRST', 12) + pad('LAST', 12) + pad('DAYS', 7) + pad('OPENS', 7) + 'BUILD\n' +
        roster.map(r => '  ' + r).join('\n') + '\n';

      if (url.searchParams.get('f') === 'json') {
        return new Response(JSON.stringify({
          generated: new Date().toISOString(),
          people: people.size,
          active7: uniqueSince(ago(7)), active30: uniqueSince(ago(30)),
          new7: newSince(ago(7)), new30: newSince(ago(30)),
          opens: totalOpens, versions: versions,
          byDay: days.map(d => ({ day: d, people: byDay[d].people.size, opens: byDay[d].opens })),
          byPerson: Array.from(people.entries()).map(([u, p]) => ({ u, ...p }))
        }, null, 1), { headers: Object.assign({}, cors, { 'Content-Type': 'application/json; charset=utf-8' }) });
      }
      return new Response(out, { headers: rep });
    }

    return new Response('', { status: 404 });
  }
};
