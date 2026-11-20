/* Token Radar — the page.
 *
 * Data comes from data.js (window.TOKEN_RADAR), written by main.ts from the
 * same sealed snapshot as board.json: `rows` is the ranked board (pre-token
 * protocols, eligible), `excluded` the pre-token protocols the exclusion rule
 * set aside, `launched` the token-bearing protocols shown only as reference.
 *
 * The value model, stated here so a reader can check it against the numbers
 * on the page: implied = TVL x category multiple x growth x age x chains.
 * The multiple is the winsorized geometric mean market-cap/TVL of the
 * token-bearing protocols in the same category (the global geometric mean
 * when a category has fewer than three such comps), clamped to 0.08-1.50.
 * Each log ratio is winsorized to the global mean plus or minus 1.5
 * standard deviations before it is averaged. Growth is 1 + half the
 * 7-day TVL change. Age is 1 + 0.15 per year tracked with no token recorded,
 * up to 1.60. Chains add 0.02 per extra chain, up to 1.10. Every factor is
 * stored on the row, so the detail view can show the arithmetic instead of
 * asserting it. The multiple was backtested leave-one-out against the 128
 * launched protocols that report a positive market cap (Spearman 0.41,
 * median error 0.64 orders of magnitude, 23% within twofold), against
 * 0.38 / 0.73 / 17% for the plain median multiple it replaces.
 *
 * Deep links: #/detail/<slug> opens a protocol, #/filter/chain/<chain> and
 * #/filter/category/<category> open the board pre-filtered, #/tab/<board |
 * excluded | launched> opens a list.
 */
(function () {
  'use strict';
  var DATA = window.TOKEN_RADAR;
  if (!DATA) {
    document.getElementById('tbody').innerHTML =
      '<tr><td class="empty" colspan="9">No data loaded.</td></tr>';
    return;
  }
  var ROWS = DATA.rows;
  var EXCLUDED = DATA.excluded;
  var LAUNCHED = DATA.launched;
  var META = DATA.meta;

  var state = { tab: 'board', q: '', chain: '', category: '', sort: 'value', selected: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(v) {
    if (v === null || v === undefined) return '<span class="cat">—</span>';
    var cls = v >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function age(v) {
    if (v === null || v === undefined) return '<span class="cat">—</span>';
    return v.toFixed(1) + 'y';
  }

  /* ---- header ---- */
  $('meta').innerHTML =
    'Snapshot <b>' + esc(META.as_of) + '</b> · ' +
    '<b>' + META.protocols_scanned + '</b> protocols scanned · ' +
    '<b>' + META.watchlist + '</b> on the watchlist · ' +
    '<b>' + META.board_rows + '</b> ranked';
  $('asof').textContent = META.as_of;

  /* ---- filter options ---- */
  var chains = {};
  var cats = {};
  ROWS.forEach(function (r) {
    r.chains.forEach(function (c) { chains[c] = true; });
    if (r.category) cats[r.category] = true;
  });
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c;
    $('chain').appendChild(o);
  });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c;
    $('category').appendChild(o);
  });

  /* ---- tabs ---- */
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll('#tabs button'));
  function setTab(tab) {
    state.tab = tab;
    state.selected = null;
    tabButtons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === tab); });
    $('controls').style.display = tab === 'board' ? '' : 'none';
    render();
  }
  tabButtons.forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  /* ---- controls ---- */
  $('q').addEventListener('input', function () { state.q = $('q').value.trim().toLowerCase(); render(); });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; render(); });
  $('category').addEventListener('change', function () { state.category = $('category').value; render(); });
  $('sort').addEventListener('change', function () { state.sort = $('sort').value; render(); });

  /* ---- filtering + sorting ---- */
  function visibleRows() {
    var list = ROWS.filter(function (r) {
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q) < 0) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.category && r.category !== state.category) return false;
      return true;
    });
    var by = {
      value: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d); },
      age: function (a, b) { return (b.age_years === null ? -1 : b.age_years) - (a.age_years === null ? -1 : a.age_years); },
    }[state.sort];
    return list.slice().sort(by);
  }

  /* ---- table ---- */
  function headFor(tab) {
    if (tab === 'board') {
      return '<tr><th>#</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
        '<th class="num">TVL</th><th class="num">7d</th><th class="num">Age</th>' +
        '<th class="num">Implied value</th><th></th></tr>';
    }
    if (tab === 'excluded') {
      return '<tr><th>Protocol</th><th>Category</th>' +
        '<th class="num">TVL</th><th>Why it is set aside</th></tr>';
    }
    return '<tr><th>Protocol</th><th>Category</th>' +
      '<th class="num">Market cap</th><th class="num">TVL</th><th class="num">MCap / TVL</th></tr>';
  }

  function rowHtml(r) {
    var watch = r.watchlist ? '<span class="badge">WATCHLIST</span>' : '';
    return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
      '<td class="rank">' + r.rank + '</td>' +
      '<td><span class="name">' + esc(r.name) + '</span>' + watch +
      '<br><span class="slug">' + esc(r.slug) + '</span></td>' +
      '<td class="cat">' + esc(r.category || '—') + '</td>' +
      '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num">' + pct(r.change_7d) + '</td>' +
      '<td class="num">' + age(r.age_years) + '</td>' +
      '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
      '<td><button class="farmbtn" data-farm="' + esc(r.slug) + '">Farm plan</button></td></tr>';
  }

  function excludedHtml(e) {
    return '<tr><td><span class="name">' + esc(e.name) + '</span><br><span class="slug">' + esc(e.slug) + '</span></td>' +
      '<td class="cat">' + esc(e.category || '—') + '</td>' +
      '<td class="num">' + money(e.tvl_usd) + '</td>' +
      '<td>' + esc(e.reason) + '</td></tr>';
  }

  function launchedHtml(l) {
    return '<tr><td><span class="name">' + esc(l.name) + '</span><br><span class="slug">' + esc(l.slug) + '</span></td>' +
      '<td class="cat">' + esc(l.category || '—') + '</td>' +
      '<td class="num">' + money(l.mcap_usd) + '</td>' +
      '<td class="num">' + money(l.tvl_usd) + '</td>' +
      '<td class="num">' + l.ratio.toFixed(2) + 'x</td></tr>';
  }

  function render() {
    $('thead').innerHTML = headFor(state.tab);
    var body = $('tbody');
    var hint = '';
    if (state.tab === 'board') {
      var list = visibleRows();
      body.innerHTML = list.length
        ? list.map(rowHtml).join('')
        : '<tr><td class="empty" colspan="9">Nothing matches these filters.</td></tr>';
      $('count').textContent = list.length + ' of ' + ROWS.length + ' protocols';
      hint = 'Click a row for the detail view: the value math and the farm plan. ' +
        'Ranks are by implied value; sorting re-orders the table without changing ranks.';
    } else if (state.tab === 'excluded') {
      body.innerHTML = EXCLUDED.map(excludedHtml).join('');
      $('count').textContent = EXCLUDED.length + ' protocols set aside';
      hint = 'These record no token too, but the exclusion rule sets them aside: exchanges, ' +
        'bridges, liquid staking and wrapped or versioned products are not launches of their own. ' +
        'The biggest ones by TVL are exchanges and bridges — that is why a TVL table alone misleads.';
    } else {
      body.innerHTML = LAUNCHED.map(launchedHtml).join('');
      $('count').textContent = LAUNCHED.length + ' largest launched protocols';
      hint = 'Reference only: these already trade, so they are not on the board. Their ' +
        'market-cap/TVL ratios are where the board’s category multiples come from.';
    }
    $('hint').textContent = hint;
    renderDetail();
  }

  /* ---- detail ---- */
  function findRow(slug) {
    for (var i = 0; i < ROWS.length; i++) if (ROWS[i].slug === slug) return ROWS[i];
    return null;
  }

  function renderDetail() {
    var box = $('detail');
    var r = state.selected ? findRow(state.selected) : null;
    if (!r) { box.hidden = true; box.innerHTML = ''; return; }
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    box.hidden = false;
    box.innerHTML =
      '<button class="close" id="detailClose">Close</button>' +
      '<h2>' + esc(r.name) + ' <span class="slug">' + esc(r.slug) + '</span>' +
      (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="thesis">' + esc(r.thesis) + '</p>' +
      '<h3>Implied value — the math</h3>' +
      '<div class="math">' +
      '<span class="pill">TVL <b>' + money(r.tvl_usd) + '</b></span><span class="eq">×</span>' +
      '<span class="pill">multiple <b>' + r.multiple.toFixed(2) + 'x</b></span><span class="eq">×</span>' +
      '<span class="pill">growth <b>' + r.growth_factor.toFixed(2) + 'x</b></span><span class="eq">×</span>' +
      '<span class="pill">age <b>' + r.age_factor.toFixed(2) + 'x</b></span><span class="eq">×</span>' +
      '<span class="pill">chains <b>' + r.chain_factor.toFixed(2) + 'x</b></span><span class="eq">=</span>' +
      '<span class="pill">implied <b>' + money(r.implied_value_usd) + '</b></span>' +
      '</div>' +
      '<h3>Farm plan — what to do</h3>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<h3>Facts</h3>' +
      '<div class="facts">' +
      '<span>Category <b>' + esc(r.category || '—') + '</b></span>' +
      '<span>Chains <b>' + esc(r.chains.slice(0, 5).join(', ')) + (r.chains.length > 5 ? ' +' + (r.chains.length - 5) : '') + '</b></span>' +
      '<span>TVL <b>' + money(r.tvl_usd) + '</b></span>' +
      '<span>7-day <b>' + (r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b></span>' +
      '<span>Tracked since <b>' + esc(r.listed_at || '—') + '</b></span>' +
      '<span>Token recorded <b>none</b></span>' +
      '</div>';
    $('detailClose').addEventListener('click', function () {
      state.selected = null;
      render();
    });
  }

  /* ---- row clicks (event delegation) ---- */
  $('tbody').addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-farm]') : null;
    var tr = ev.target.closest ? ev.target.closest('tr[data-slug]') : null;
    var slug = btn ? btn.getAttribute('data-farm') : (tr ? tr.getAttribute('data-slug') : null);
    if (!slug) return;
    state.selected = slug;
    render();
    var box = $('detail');
    if (!box.hidden) box.scrollIntoView({ block: 'nearest' });
  });

  /* ---- deep links ---- */
  function readHash() {
    var h = window.location.hash || '';
    var m = h.match(/^#\/tab\/(board|excluded|launched)$/);
    if (m) {
      setTab(m[1]);
      return;
    }
    m = h.match(/^#\/detail\/([A-Za-z0-9._-]+)$/);
    if (m) {
      state.tab = 'board';
      state.selected = m[1];
      tabButtons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === 'board'); });
      $('controls').style.display = '';
      return;
    }
    m = h.match(/^#\/filter\/chain\/(.+)$/);
    if (m) {
      state.chain = decodeURIComponent(m[1]);
      $('chain').value = state.chain;
      return;
    }
    m = h.match(/^#\/filter\/category\/(.+)$/);
    if (m) {
      state.category = decodeURIComponent(m[1]);
      $('category').value = state.category;
    }
  }
  window.addEventListener('hashchange', function () { readHash(); render(); });

  readHash();
  render();
})();
