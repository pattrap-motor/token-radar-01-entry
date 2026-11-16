// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/
// by main.ts from the same board that board.json carries) and renders the
// ranked board, its filters, a per-protocol detail view with the model's own
// arithmetic, and the table of already-trading protocols the multiples came
// from. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var MODEL = DATA.model;
  var state = { q: '', category: 'all', chain: 'all', watchOnly: false, sort: 'rank', dir: 1 };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unreported';
    if (days >= 365) return (days / 365).toFixed(1) + ' yrs';
    return Math.round(days) + ' days';
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // The model in one function, the same arithmetic lib/model.ts runs: the
  // page recomputes a row's implied value from the snapshot figures the row
  // carries and the model's printed constants, and the detail view checks it
  // against the value board.json holds, so code and board cannot drift.
  // The range is the same pricing with the category's shrunk quartile
  // multiples (its middle half of peers) in place of the median.
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function impliedOf(row) {
    var growth = clamp(row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d, MODEL.growth_floor, MODEL.growth_cap);
    var growthMult = round4(1 + (growth / 100) * MODEL.growth_weight);
    var age = row.age_days === null || row.age_days === undefined ? MODEL.age_stand_in_days : row.age_days;
    var seasonMult = round4(MODEL.season_base + MODEL.season_range * (1 - Math.exp(-(age / 365.25) / MODEL.season_tau_years)));
    var implied = Math.max(1, Math.round(row.tvl_usd * row.multiple * growthMult * seasonMult));
    var low = Math.min(implied, Math.max(1, Math.round(row.tvl_usd * row.multiple_low * growthMult * seasonMult)));
    var high = Math.max(implied, Math.round(row.tvl_usd * row.multiple_high * growthMult * seasonMult));
    return { implied: implied, low: low, high: high, growthMult: growthMult, seasonMult: seasonMult };
  }

  // How far a row's evidence agrees, read off its peer count and the raw
  // spread of its category's middle half: the words the detail view prints
  // beside the range, so a thin price is labelled where it is shown.
  function evidenceOf(row) {
    var peers = row.multiple_peers;
    var spread = row.peer_q1 > 0 ? row.peer_q3 / row.peer_q1 : Infinity;
    if (peers >= 8 && spread <= 4) return 'firm — many priced peers, and their middle half agrees';
    if (peers >= 3 && spread <= 8) return 'fair — a real peer set, but its middle half disagrees';
    if (peers < 3) return 'thin — priced off ' + peers + ' priced peer' + (peers === 1 ? '' : 's') + '; read the point as a sketch, the range as the claim';
    return 'scattered — the peers disagree widely; the range matters more than the point';
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // A two-point slope from the snapshot's own figures: TVL seven days ago is
  // TVL / (1 + change/100), so the line is the record, not a decoration.
  function spark(row) {
    var g = row.change_7d;
    var color = g === null || g === undefined || Math.abs(g) < 0.05 ? '#66738a' : g > 0 ? '#3fb96f' : '#e05d5d';
    var prev = g === null || g === undefined ? row.tvl_usd : row.tvl_usd / (1 + g / 100);
    var lo = Math.min(prev, row.tvl_usd);
    var hi = Math.max(prev, row.tvl_usd);
    var span = hi - lo || 1;
    function y(v) { return (16 - ((v - lo) / span) * 12).toFixed(1); }
    var holder = el('span', null);
    holder.innerHTML =
      '<svg class="spark" width="64" height="20" viewBox="0 0 64 20">' +
      '<polyline points="3,' + y(prev) + ' 61,' + y(row.tvl_usd) + '" fill="none" stroke="' + color + '" stroke-width="1.6"/>' +
      '<circle cx="61" cy="' + y(row.tvl_usd) + '" r="2.2" fill="' + color + '"/></svg>';
    return holder;
  }

  function badge(row) {
    return row.watchlist
      ? el('span', { class: 'badge watch', text: 'WATCHLIST' })
      : el('span', { class: 'badge early', text: 'EARLY' });
  }

  function header() {
    return el('div', { class: 'top' },
      el('div', { class: 'brand' },
        el('h1', null, 'LAUNCH ', el('span', { class: 'rad', text: 'RADAR' })),
        el('p', { text: 'Protocols that record no token yet, ranked by what their launch would be worth if their record stayed as it is — and the steps to farm each one before it issues.' })
      ),
      el('div', { class: 'asof' },
        el('div', null, 'Snapshot ', el('b', { text: DATA.as_of })),
        el('div', { text: 'Model ' + MODEL.version + ' · runs offline' })
      )
    );
  }

  function stats() {
    var s = DATA.summary;
    function card(k, v, sub) {
      return el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), el('div', { class: 's', text: sub }));
    }
    return el('div', { class: 'stats' },
      card('Protocols scanned', String(s.protocols), 'every DefiLlama record at $5M TVL or more'),
      card('Watchlist covered', s.watchlist + ' / ' + s.watchlist, 'the house floor: $50M and no token recorded'),
      card('Board rows', String(s.board_rows), s.early_rows + ' early finds below the floor'),
      card('Implied value on board', fmtUsd(s.total_implied_usd), 'across ' + fmtUsd(s.total_tvl_usd) + ' of pre-token TVL')
    );
  }

  function method() {
    var chips = MODEL.category_multiples.slice(0, 10).map(function (cm) {
      return el('span', { class: 'chip' }, cm.category + ' ', el('b', { text: 'x' + cm.multiple.toFixed(2) }), ' · ' + cm.peers + ' traded');
    });
    chips.push(el('span', { class: 'chip' }, 'Fallback ', el('b', { text: 'x' + MODEL.global_multiple.toFixed(2) }), ' · ' + MODEL.global_peers + ' traded'));
    return el('section', { class: 'method' },
      el('h2', { text: 'How a launch is priced' }),
      el('p', null,
        'No names are picked by hand. For every protocol whose token already trades, the snapshot gives a market cap and a TVL, so a price-to-TVL multiple; ',
        el('b', { text: 'a category is priced at the median multiple of its traded protocols' }),
        ', shrunk toward the global median when the category has few priced peers (the snapshot carries a market cap for barely a third of its traded protocols). A pre-token protocol starts at its TVL times its category multiple, is tilted by its seven-day TVL momentum, and is lifted by a seasoning term the longer it has run with no token recorded. Protocols whose token already trades are set aside as the comparables (bottom of the page), never ranked as finds. ',
        el('b', { text: 'Every row also carries a range' }),
        ': the same pricing run with the category\'s middle half of peer multiples (first to third quartile, shrunk the same way), so the board states how far its own evidence agrees — a price off many agreeing peers reads firm, and the top row, priced off a single peer, carries the wide range that earns.'),
      el('span', { class: 'formula', text: 'implied value  =  TVL  x  category multiple  x  momentum (7d, clamped -40%..+60%)  x  seasoning (0.80x -> 1.25x with age)  ·  range = the same with the peer multiples\' middle half' }),
      el('div', { class: 'chips' }, chips)
    );
  }

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { if (r.category) seen[r.category] = true; });
    return Object.keys(seen).sort();
  }
  function chains() {
    var seen = {};
    DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  function controls(count) {
    var catSel = el('select', { 'aria-label': 'Category filter' },
      [el('option', { value: 'all', text: 'All categories' })].concat(categories().map(function (c) {
        return el('option', { value: c, text: c });
      })));
    catSel.value = state.category;
    catSel.addEventListener('change', function () { state.category = catSel.value; render(); });
    var chainSel = el('select', { 'aria-label': 'Chain filter' },
      [el('option', { value: 'all', text: 'All chains' })].concat(chains().map(function (c) {
        return el('option', { value: c, text: c });
      })));
    chainSel.value = state.chain;
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; render(); });
    var sortSel = el('select', { 'aria-label': 'Sort' },
      [['rank', 'Sort: radar rank'], ['implied', 'Sort: implied value'], ['tvl', 'Sort: TVL'], ['change', 'Sort: 7d move'], ['score', 'Sort: radar score'], ['age', 'Sort: age']].map(function (pair) {
        return el('option', { value: pair[0], text: pair[1] });
      }));
    sortSel.value = state.sort;
    sortSel.addEventListener('change', function () { state.sort = sortSel.value; state.dir = state.sort === 'rank' ? 1 : -1; render(); });
    var search = el('input', { type: 'search', placeholder: 'Search protocols...', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { state.q = search.value; render(true); search.focus(); });
    var watchBox = el('input', { type: 'checkbox' });
    watchBox.checked = state.watchOnly;
    watchBox.addEventListener('change', function () { state.watchOnly = watchBox.checked; render(); });
    return el('div', { class: 'controls' },
      search, catSel, chainSel, sortSel,
      el('label', { class: 'toggle' }, watchBox, 'Watchlist only'),
      el('span', { class: 'count', text: count + ' shown' })
    );
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    var key = {
      rank: function (r) { return r.rank; },
      implied: function (r) { return r.implied_value_usd; },
      tvl: function (r) { return r.tvl_usd; },
      change: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
      score: function (r) { return r.radar_score; },
      age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    }[state.sort];
    rows.sort(function (a, b) { return (key(a) - key(b)) * state.dir || a.rank - b.rank; });
    return rows;
  }

  function boardTable(rows) {
    if (rows.length === 0) return el('div', { class: 'empty', text: 'No protocol matches that filter. Loosen it: the radar only ranks protocols that record no token.' });
    function th(label, sortKey, num) {
      var attrs = { class: num ? 'num' : null, text: label + (state.sort === sortKey ? (state.dir === 1 ? ' ^' : ' v') : '') };
      var cell = el('th', attrs);
      cell.addEventListener('click', function () {
        if (state.sort === sortKey) state.dir = -state.dir;
        else { state.sort = sortKey; state.dir = sortKey === 'rank' ? 1 : -1; }
        render();
      });
      return cell;
    }
    var body = rows.map(function (r) {
      var moveCls = r.change_7d === null ? 'flat' : r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : 'flat';
      return el('tr', { onclick: function () { location.hash = '#/p/' + r.slug; } },
        el('td', { class: 'rank' + (r.rank <= 3 ? ' top' : ''), text: '#' + r.rank }),
        el('td', { class: 'proto' },
          el('div', null, el('span', { class: 'name', text: r.name }), badge(r)),
          el('div', { class: 'sub', text: (r.category || 'Uncategorised') + ' · tracked ' + fmtAge(r.age_days) + ' with no token recorded' })
        ),
        el('td', { class: 'chains', text: r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') }),
        el('td', { class: 'money num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num' }, spark(r)),
        el('td', { class: 'move num ' + moveCls, text: fmtPct(r.change_7d) }),
        el('td', { class: 'implied num' },
          el('div', { text: fmtUsd(r.implied_value_usd) }),
          el('div', { class: 'sub range', text: 'range ' + fmtUsd(r.implied_low_usd) + ' – ' + fmtUsd(r.implied_high_usd) })
        ),
        el('td', { class: 'money num', text: 'x' + r.multiple.toFixed(2) }),
        el('td', { class: 'scorecell num' },
          el('span', { class: 'scoreval', text: String(r.radar_score) }),
          el('div', { class: 'scorebar' }, el('i', { style: 'width:' + r.radar_score + '%' }))
        )
      );
    });
    return el('table', { class: 'board' },
      el('thead', null, el('tr', null,
        th('#', 'rank'), th('Protocol', 'rank'), th('Chains', 'rank'), th('TVL', 'tvl', true),
        th('7d trend', 'change', true), th('7d', 'change', true), th('Implied value', 'implied', true),
        th('Multiple', 'implied', true), th('Radar score', 'score', true)
      )),
      el('tbody', null, body)
    );
  }

  function liveTable() {
    var body = DATA.live.map(function (r) {
      return el('tr', null,
        el('td', null, el('b', { text: r.name }), ' ', el('span', { class: 'flat', text: r.symbol || '' })),
        el('td', { text: r.category || 'Uncategorised' }),
        el('td', { class: 'money num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'money num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'money num', text: 'x' + r.multiple.toFixed(2) })
      );
    });
    return el('div', null,
      el('div', { class: 'section-head' },
        el('h2', { text: 'Already trading — the comparables, set aside' }),
        el('p', { text: 'These protocols have a token; they are never ranked as finds. Their market caps are what price the board above.' })
      ),
      el('table', { class: 'live' },
        el('thead', null, el('tr', null,
          el('th', { text: 'Protocol' }), el('th', { text: 'Category' }), el('th', { class: 'num', text: 'TVL' }),
          el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'Price / TVL' })
        )),
        el('tbody', null, body)
      )
    );
  }

  function footer() {
    return el('footer', null,
      el('p', { text: 'Data: ' + DATA.source + '. The board reads that sealed snapshot only; run the program on a fresher snapshot and every multiple, rank and plan moves with it.' }),
      el('p', { text: 'Wording matters: a protocol here "records no token" in DefiLlama\'s record, which is not proof it has none. An implied value is this board\'s own claim about a launch that may never happen; it is not a prediction that a token will be issued, or when.' })
    );
  }

  function boardView(keepFocus) {
    var rows = visibleRows();
    app.textContent = '';
    app.appendChild(header());
    app.appendChild(stats());
    app.appendChild(method());
    app.appendChild(controls(rows.length));
    app.appendChild(boardTable(rows));
    app.appendChild(liveTable());
    app.appendChild(footer());
    app.setAttribute('aria-busy', 'false');
    if (keepFocus) {
      var s = app.querySelector('input[type="search"]');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }
  }

  function detailView(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) { boardView(); return; }
    var check = impliedOf(row);
    var peers = DATA.rows.filter(function (r) { return r.category === row.category && r.slug !== row.slug; }).slice(0, 5);
    app.textContent = '';
    app.appendChild(header());
    var back = el('a', { class: 'back', href: '#/', text: '<- Back to the board' });
    app.appendChild(back);
    app.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('h2', null, row.name, badge(row)),
        el('div', { class: 'sub', text: (row.category || 'Uncategorised') + ' · rank #' + row.rank + ' of ' + DATA.rows.length + ' · records no token in the snapshot' })
      ),
      el('div', { class: 'big' },
        el('div', { class: 'k', text: 'Implied launch value' }),
        el('div', { class: 'v', text: fmtUsd(row.implied_value_usd) }),
        el('div', { class: 'rline', text: 'range ' + fmtUsd(row.implied_low_usd) + ' – ' + fmtUsd(row.implied_high_usd) + ' · evidence: ' + evidenceOf(row).split(' — ')[0] })
      )
    ));
    var facts = el('div', { class: 'card' },
      el('h3', { text: 'The record' }),
      kv('Total value locked', fmtUsd(row.tvl_usd)),
      kv('TVL change, 7 days', fmtPct(row.change_7d), row.change_7d !== null && row.change_7d > 0 ? 'up' : row.change_7d !== null && row.change_7d < 0 ? 'down' : 'flat'),
      kv('Tracked by DefiLlama since', row.listed_at || 'unreported'),
      kv('Running with no token recorded', fmtAge(row.age_days)),
      kv('Chains', row.chains.join(', ') || 'unreported', true),
      kv('Radar score', row.radar_score + ' / 100'),
      scoreParts(row)
    );
    var multNote = row.multiple_own
      ? 'its category\'s median, shrunk toward the global median by peer count'
      : 'global median (no traded protocol in its category carries a market cap)';
    var raw = null;
    (MODEL.category_medians || []).forEach(function (cm) { if (cm.category === (row.category || 'Uncategorised')) raw = cm; });
    var modelKids = [
      el('h3', { text: 'How the value is built' }),
      kv('TVL (the base)', fmtUsd(row.tvl_usd)),
      kv('Category multiple x' + row.multiple.toFixed(2), multNote, false, true),
    ];
    if (raw) {
      modelKids.push(kv('Raw category median x' + raw.multiple.toFixed(2), 'median of ' + raw.peers + ' traded peer' + (raw.peers === 1 ? '' : 's') + ' with a market cap', false, true));
      modelKids.push(kv('Shrinkage', 'peer weight ' + raw.peers + '/(' + raw.peers + ' + 3) toward the global median x' + MODEL.global_multiple.toFixed(2), false, true));
    }
    modelKids.push(kv('Momentum x' + check.growthMult.toFixed(4), 'seven-day TVL change, clamped'));
    modelKids.push(kv('Seasoning x' + check.seasonMult.toFixed(4), 'age with no token recorded'));
    modelKids.push(kv('Implied launch value', fmtUsd(row.implied_value_usd)));
    modelKids.push(kv('Value range', fmtUsd(row.implied_low_usd) + ' – ' + fmtUsd(row.implied_high_usd), false, true));
    modelKids.push(kv('Peer spread', 'the middle half of the ' + row.multiple_peers + ' priced peer' + (row.multiple_peers === 1 ? '' : 's') + ' runs x' + row.peer_q1.toFixed(2) + ' to x' + row.peer_q3.toFixed(2) + '; the range prices with those quartiles, shrunk like the median', false, true));
    modelKids.push(kv('Evidence', evidenceOf(row), false, true));
    var matches = check.implied === row.implied_value_usd && check.low === row.implied_low_usd && check.high === row.implied_high_usd;
    modelKids.push(el('div', { class: 'check', text: 'This page recomputes the row and its range from those figures: ' + fmtUsd(check.implied) + ', range ' + fmtUsd(check.low) + ' – ' + fmtUsd(check.high) + (matches ? ' — matches board.json exactly.' : ' — differs from board.json; trust board.json.') }));
    var model = el('div', { class: 'card' }, modelKids);
    var plan = el('div', { class: 'card' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'plan' }, row.farm_steps.map(function (s) { return el('li', { text: s }); }))
    );
    var peerCard = el('div', { class: 'card' },
      el('h3', { text: 'Next in ' + (row.category || 'its category') }),
      peers.length === 0
        ? el('p', { class: 'flat', text: 'No other board row shares this category.' })
        : el('div', { class: 'peers' }, peers.map(function (p) {
            var a = el('a', { class: 'chip', href: '#/p/' + p.slug }, '#' + p.rank + ' ' + p.name + ' ', el('b', { text: fmtUsd(p.implied_value_usd) }));
            return a;
          }))
    );
    var grid = el('div', { class: 'detail-grid' },
      el('div', { class: 'col' }, facts, plan),
      el('div', { class: 'col' }, model, tradedCard(row, raw), peerCard)
    );
    app.appendChild(grid);
    app.appendChild(footer());
    app.setAttribute('aria-busy', 'false');
  }

  // The score's four parts as bars, so the number on the board is explained
  // where it is printed: value size out of 45, momentum out of 25, TVL scale
  // and seasoning out of 15 each, summing to the score itself.
  function scoreParts(row) {
    var parts = row.score_parts;
    if (!parts) return null;
    function bar(label, pts, max) {
      return el('div', { class: 'part' },
        el('span', { class: 'pl', text: label }),
        el('span', { class: 'pbar' }, el('i', { style: 'width:' + Math.round((pts / max) * 100) + '%' })),
        el('span', { class: 'pv', text: pts + '/' + max })
      );
    }
    return el('div', { class: 'parts' },
      bar('Implied value', parts.value, 45),
      bar('7d momentum', parts.momentum, 25),
      bar('TVL scale', parts.scale, 15),
      bar('Seasoning', parts.seasoning, 15)
    );
  }

  // The traded protocols a row's category multiple was medianed from, with
  // the snapshot's own figures: the model's evidence, on the page, beside
  // the arithmetic that used it.
  function tradedCard(row, raw) {
    var cat = row.category || 'Uncategorised';
    var peers = (DATA.category_peers && DATA.category_peers[cat]) || [];
    var kids = [el('h3', { text: 'Traded peers behind the multiple' })];
    if (peers.length === 0) {
      kids.push(el('p', { class: 'flat', text: 'No traded protocol in this category carries a market cap in the snapshot, so this row is priced at the global median of ' + MODEL.global_peers + ' traded protocols, x' + MODEL.global_multiple.toFixed(2) + '.' }));
      return el('div', { class: 'card' }, kids);
    }
    var body = peers.map(function (p) {
      return el('tr', null,
        el('td', null, el('b', { text: p.name }), ' ', el('span', { class: 'flat', text: p.symbol || '' })),
        el('td', { class: 'money num', text: fmtUsd(p.tvl_usd) }),
        el('td', { class: 'money num', text: fmtUsd(p.mcap_usd) }),
        el('td', { class: 'money num', text: 'x' + p.multiple.toFixed(2) })
      );
    });
    kids.push(el('table', { class: 'live mini' },
      el('thead', null, el('tr', null,
        el('th', { text: 'Traded peer' }), el('th', { class: 'num', text: 'TVL' }),
        el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'Price / TVL' })
      )),
      el('tbody', null, body)
    ));
    var total = raw ? raw.peers : peers.length;
    kids.push(el('p', { class: 'note', text: (total > peers.length ? 'The ' + peers.length + ' largest of ' + total + ' priced peers by market cap. ' : '') + 'The category multiple above is the median of these ratios, shrunk toward the global median by peer count; every figure is the snapshot\'s own.' }));
    return el('div', { class: 'card' }, kids);
  }

  function kv(k, v, cls, plain) {
    return el('div', { class: 'kv' },
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v' + (plain ? ' plain' : '') + (cls ? ' ' + cls : ''), text: v })
    );
  }

  function render(keepFocus) {
    var hash = location.hash || '#/';
    if (hash.indexOf('#/p/') === 0) { detailView(decodeURIComponent(hash.slice(4))); return; }
    if (hash.indexOf('#/f/') === 0) {
      var cat = decodeURIComponent(hash.slice(4));
      if (state.category !== cat) state.category = cat;
    }
    boardView(keepFocus);
  }

  window.addEventListener('hashchange', function () { render(); });
  render();
})();
