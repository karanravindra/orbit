import type { Child } from "hono/jsx";

const CSS = `
:root{--bg:#fbf7f0;--fg:#2b2118;--muted:#7a6a5a;--line:#e8dccb;--card:#fffdf8;--accent:#b4491f;--accent-fg:#fff;--chip:#f3e8d6;--done:#a99a89}
@media (prefers-color-scheme:dark){:root{--bg:#1a1511;--fg:#f1e8dc;--muted:#a8998a;--line:#33291f;--card:#221c16;--accent:#e08a5a;--accent-fg:#1a1511;--chip:#2e251c;--done:#6f6254}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 ui-serif,Georgia,"Iowan Old Style",serif}
a{color:var(--accent)}
.wrap{max-width:46rem;margin:0 auto;padding:0 16px 64px}
header.site{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);margin-bottom:20px;flex-wrap:wrap}
header.site .brand{font-size:1.35rem;font-weight:700;text-decoration:none;color:var(--fg);letter-spacing:.01em}
header.site form{margin-left:auto;display:flex;gap:6px;flex:1 1 12rem;max-width:20rem}
input[type=search]{flex:1;min-width:0;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);font:inherit;font-size:16px}
button,.btn{font:inherit;font-size:.95rem;padding:8px 14px;border-radius:999px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer;text-decoration:none}
button.ghost{background:transparent;color:var(--accent)}
h1{font-size:1.9rem;line-height:1.2;margin:.2em 0 .3em}
h2{font-size:1.2rem;margin:1.6em 0 .5em;border-bottom:1px solid var(--line);padding-bottom:.25em}
h3{font-size:1rem;margin:1.2em 0 .3em;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.muted{color:var(--muted)}
.meta{color:var(--muted);font-size:.95rem;display:flex;gap:6px 14px;flex-wrap:wrap}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:.5em 0}
.chip{background:var(--chip);border-radius:999px;padding:3px 12px;font-size:.9rem;text-decoration:none;color:var(--fg)}
.chip small{color:var(--muted);margin-left:4px}
.cards{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.cards a{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;text-decoration:none;color:var(--fg)}
.cards a:hover{border-color:var(--accent)}
.cards .t{font-weight:700}
.cards .s{color:var(--muted);font-size:.92rem}
.badge{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;background:var(--accent);color:var(--accent-fg);border-radius:6px;padding:1px 6px;margin-left:6px;vertical-align:middle}
ul.ing,ol.steps{padding-left:0;list-style:none;margin:.4em 0}
ul.ing li{padding:6px 0;border-bottom:1px dashed var(--line)}
ul.ing .qty{font-weight:700;margin-right:.35em}
ul.ing .note{color:var(--muted)}
ol.steps{counter-reset:s}
ol.steps li{counter-increment:s;position:relative;padding:8px 0 8px 2.2rem}
ol.steps li::before{content:counter(s);position:absolute;left:0;top:8px;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--chip);text-align:center;font-size:.85rem;line-height:1.6rem;font-weight:700}
.notes{background:var(--chip);border-radius:10px;padding:10px 14px;margin-top:1.4em}
.warn{border:1px solid var(--accent);border-radius:10px;padding:8px 14px;margin:1em 0;font-size:.92rem}
.toolbar{display:flex;gap:8px;margin:12px 0}
footer.site{margin-top:48px;color:var(--muted);font-size:.85rem;text-align:center}
/* cook mode: bigger type, tap to check off */
body.cook{font-size:22px}
body.cook header.site,body.cook footer.site,body.cook .hide-cook{display:none}
body.cook ul.ing li,body.cook ol.steps li{cursor:pointer;padding-top:12px;padding-bottom:12px;-webkit-tap-highlight-color:transparent}
body.cook li.done{color:var(--done);text-decoration:line-through}
body.cook .toolbar{position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2}
@media print{header.site,footer.site,.toolbar{display:none}body{background:#fff;color:#000}}
`;

/** Cook mode: toggles `body.cook`, keeps the screen awake, and remembers ticked items for this tab. */
const COOK_JS = `
(() => {
  const btn = document.getElementById('cook-toggle');
  if (!btn) return;
  const key = 'cook:' + location.pathname;
  let lock = null;
  const items = [...document.querySelectorAll('[data-check]')];
  const save = () => { try { sessionStorage.setItem(key, JSON.stringify(items.flatMap((li, i) => li.classList.contains('done') ? [i] : []))); } catch {} };
  try { for (const i of JSON.parse(sessionStorage.getItem(key) || '[]')) items[i]?.classList.add('done'); } catch {}
  const wake = async (on) => {
    try {
      if (on && 'wakeLock' in navigator) lock = await navigator.wakeLock.request('screen');
      else if (lock) { await lock.release(); lock = null; }
    } catch {}
  };
  const set = (on) => { document.body.classList.toggle('cook', on); btn.textContent = on ? 'Exit cook mode' : 'Cook mode'; wake(on); };
  btn.addEventListener('click', () => set(!document.body.classList.contains('cook')));
  items.forEach((li) => li.addEventListener('click', () => { if (document.body.classList.contains('cook')) { li.classList.toggle('done'); save(); } }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.body.classList.contains('cook')) wake(true); });
})();
`;

export const Layout = (props: { title: string; q?: string; drafts?: boolean; cook?: boolean; children?: Child }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title === "holykhao" ? "holykhao" : `${props.title} · holykhao`}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <div class="wrap">
        <header class="site">
          <a class="brand" href="/">holykhao</a>
          <form action="/search" method="get" role="search">
            <input type="search" name="q" value={props.q ?? ""} placeholder="Search recipes, ingredients…" aria-label="Search" />
            <button type="submit">Search</button>
          </form>
        </header>
        <main>{props.children}</main>
        <footer class="site">{props.drafts ? "Preview: drafts are visible" : "Mom's recipes"}</footer>
      </div>
      {props.cook ? <script dangerouslySetInnerHTML={{ __html: COOK_JS }} /> : null}
    </body>
  </html>
);
