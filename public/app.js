// The report page (§6). Data comes from GET /api/report; sorting, paging and
// CSV happen here, on the full result for the range.
//
// One page, two products: CEU Stamps and RADS10 (SITES below). Each has its own
// tiles, tabs and rows that open under a person; the filters, table, paging and
// CSV are shared.

import {
  addDays, deviceSummary, emptyLocationLabel, formatDuration, formatSeat, ipDisplay, localDay, localDayWindow, toCsv,
} from '/shared/format.js';
import { defaultDirection, pageInfo, sortRows } from '/shared/table.js';

const NO_NAME = '(no name given)';
const DASH = '—';

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// Stored times are UTC; show them on the viewer's clock (§6.7).
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (iso) => (iso ? dateTime.format(new Date(iso)) : null);
const joined = (items) => items.join('; ');
const distinct = (items) => [...new Set(items)];

// ---- Cells: null (a dash), a string, or { text, more, title, tone, pill, tag } ----

function firstPlus(items, word = '') {
  const more = items.length > 1 ? `+${items.length - 1}${word ? ` ${word}` : ''}` : null;
  return { text: items[0], more, title: items.join('\n') };
}

function ipsCell(ips) {
  if (!ips.length) return null;
  return { ...firstPlus(distinct(ips.map(ipDisplay))), title: ips.join('\n') };
}

function placesCell(locations, ips) {
  return locations.length ? firstPlus(locations) : { text: emptyLocationLabel(ips), tone: 'muted' };
}

const LOOKED_UP = 'Approximate: looked up from the IP address when this report ran';

function resultCell(r) {
  const tone = r.completedAt == null ? 'pending' : r.passed === false ? 'bad' : 'ok';
  return { text: r.result, tone, pill: true, tag: r.isDemo ? 'demo' : null };
}

// ---- Columns ----

const text = (key, label, value, extra = {}) => ({ key, label, type: 'text', value, ...extra });
const count = (key, label, value, extra = {}) => ({ key, label, type: 'number', value, ...extra });
const date = (key, label, value) => ({ key, label, type: 'date', value, cell: (r) => when(value(r)) });
const seat = (value) => count('seat', 'Seat time', value, { cell: (r) => formatSeat(value(r)) });
const courseText = (key, label, value) =>
  text(key, label, value, { className: 'course', cell: (r) => ({ text: value(r), title: value(r) }) });

const ipColumn = (ips) =>
  text('ip', 'IP address', (r) => (ips(r).length ? ipDisplay(ips(r)[0]) : ''), { cell: (r) => ipsCell(ips(r)) });
const placeColumn = (locations, ips) =>
  text('location', 'Location', (r) => locations(r)[0] ?? '', {
    cell: (r) => {
      const cell = placesCell(locations(r), ips(r));
      return r.locationLookedUp ? { ...cell, title: LOOKED_UP } : cell;
    },
  });

const contactColumns = (nameLabel, licence) => [
  text('name', nameLabel, (r) => (r.name === NO_NAME ? '' : r.name), {
    cell: (r) => (r.name === NO_NAME ? { text: NO_NAME, tone: 'muted' } : r.name),
  }),
  text('licence', 'Licence', licence, { className: 'mono' }),
  text('email', 'Email', (r) => r.email),
  text('phone', 'Phone', (r) => r.phone),
];

// Time on site: seconds the visit had the site on screen. `unrecorded` is what a
// missing value reads as — visits from before it was tracked, or pages that never reported back.
const timeOnSite = (unrecorded) => count('time', 'Time on site', (r) => r.activeSeconds, {
  cell: (r) => (r.activeSeconds == null ? (unrecorded ? { text: unrecorded, tone: 'muted' } : null) : formatDuration(r.activeSeconds)),
});

const oneIp = (r) => (r.ipAddress ? [r.ipAddress] : []);
const onePlace = (r) => (r.location ? [r.location] : []);

// A count on the Students tab that opens that person's rows underneath (kind: 'signIns' | 'sittings').
const expandable = (key, label, kind) =>
  count(key, label, (r) => r[kind], { cell: (r) => (r[kind] > 0 ? { text: String(r[kind]), expand: kind } : '0') });

// What opens under a student: one row per visit or sitting, newest first.
const CEU_DETAILS = {
  signIns: {
    noun: ['sign-in', 'sign-ins'],
    time: (r) => r.at,
    columns: [
      date('at', 'When', (r) => r.at),
      timeOnSite('not recorded'),
      ipColumn(oneIp),
      placeColumn(onePlace, oneIp),
      text('device', 'Device', (r) => r.device, { cell: (r) => (r.device ? { text: deviceSummary(r.device), title: r.device } : null) }),
    ],
  },
  sittings: {
    noun: ['sitting', 'sittings'],
    time: (r) => r.startedAt,
    columns: [
      date('started', 'Started', (r) => r.startedAt),
      courseText('course', 'Course', (r) => r.course),
      text('result', 'Result', (r) => r.result, { cell: resultCell }),
      seat((r) => r.seatMinutes),
      ipColumn(oneIp),
      placeColumn(onePlace, oneIp),
    ],
  },
};

const CEU_TABS = [
  {
    id: 'students',
    label: 'Students',
    rows: (report) => report.students,
    sort: ['lastSeen', 'desc'],
    expandable: true,
    columns: [
      ...contactColumns('Student', (r) => r.key),
      text('courses', 'Courses taken', (r) => r.courses[0] ?? '', {
        className: 'course',
        cell: (r) => (r.courses.length ? firstPlus(r.courses, 'more') : { text: 'signed in, never enrolled', tone: 'muted' }),
      }),
      expandable('signIns', 'Sign-ins', 'signIns'),
      expandable('sittings', 'Sittings', 'sittings'),
      count('finished', 'Finished', (r) => r.finished),
      seat((r) => r.seatMinutes),
      timeOnSite(null),
      date('lastSeen', 'Last seen', (r) => r.lastSeen),
      ipColumn((r) => r.ipAddresses),
      placeColumn((r) => r.locations, (r) => r.ipAddresses),
    ],
    csv: {
      headers: ['Name', 'Licence', 'Email', 'Phone', 'State', 'Courses taken', 'Sign-ins', 'Sittings', 'Finished',
        'Seat minutes', 'Time on site (seconds)', 'Average score', 'First seen', 'Last seen', 'Addresses', 'Locations'],
      row: (r) => [r.name, r.key, r.email, r.phone, r.state, joined(r.courses), r.signIns, r.sittings, r.finished,
        r.seatMinutes, r.activeSeconds, r.averageScore, r.firstSeen, r.lastSeen, joined(r.ipAddresses), joined(r.locations)],
    },
  },
  {
    id: 'courses',
    label: 'Courses',
    rows: (report) => report.courses,
    sort: ['sittings', 'desc'],
    columns: [
      courseText('course', 'Course', (r) => r.course),
      text('state', 'State', (r) => r.state),
      count('students', 'Students', (r) => r.students),
      count('sittings', 'Sittings', (r) => r.sittings),
      count('finished', 'Finished', (r) => r.finished, {
        cell: (r) => ({ text: String(r.finished), more: r.graded ? `${r.passed} passed` : null }),
      }),
      count('score', 'Average score', (r) => r.averageScore, {
        cell: (r) => (r.averageScore == null ? null : `${r.averageScore}%`),
      }),
      ipColumn((r) => r.ipAddresses),
      placeColumn((r) => r.locations, (r) => r.ipAddresses),
    ],
    csv: {
      headers: ['Course', 'State', 'Students', 'Sittings', 'Finished', 'Passed', 'Average score', 'Seat minutes',
        'IP addresses', 'Locations'],
      row: (r) => [r.course, r.state, r.students, r.sittings, r.finished, r.passed, r.averageScore, r.seatMinutes,
        joined(r.ipAddresses), joined(r.locations)],
    },
  },
  {
    id: 'sittings',
    label: 'Sittings',
    rows: (report) => report.sittings,
    sort: ['started', 'desc'],
    columns: [
      date('started', 'Started', (r) => r.startedAt),
      ...contactColumns('Student', (r) => r.license),
      courseText('course', 'Course', (r) => r.course),
      text('result', 'Result', (r) => r.result, { cell: resultCell }),
      seat((r) => r.seatMinutes),
      ipColumn(oneIp),
      placeColumn(onePlace, oneIp),
    ],
    csv: {
      headers: ['Started', 'Name', 'Licence', 'Email', 'Phone', 'State', 'Course', 'Completed', 'Score %',
        'Seat minutes', 'Certificate', 'IP address', 'Location', 'Device'],
      row: (r) => [r.startedAt, r.name, r.license, r.email, r.phone, r.state, r.course, r.completedAt, r.score,
        r.seatMinutes, r.certificate, r.ip, r.location, r.device],
    },
  },
  {
    id: 'sign-ins',
    label: 'Sign-ins',
    rows: (report) => report.signIns,
    sort: ['at', 'desc'],
    columns: [
      date('at', 'When', (r) => r.at),
      timeOnSite('not recorded'),
      ...contactColumns('Name', (r) => r.license),
      ipColumn(oneIp),
      placeColumn(onePlace, oneIp),
    ],
    csv: {
      headers: ['When', 'Time on site (seconds)', 'Last active', 'Name', 'Licence', 'Email', 'Phone', 'State', 'IP address', 'Location', 'Device'],
      row: (r) => [r.at, r.activeSeconds, r.lastActiveAt, r.name, r.license, r.email, r.phone, r.state, r.ip, r.location, r.device],
    },
  },
];

// ---- RADS10: visitors are browsers, not signed-in people ----

const anonymous = (r) => r.kind === 'Visitor';
const visitorColumns = [
  text('name', 'Visitor', (r) => (anonymous(r) ? '' : r.name), {
    cell: (r) => (anonymous(r) ? { text: r.name, tone: 'muted', title: 'Not logged in. The letters are the start of this browser’s id.' } : r.name),
  }),
  text('kind', 'Type', (r) => r.kind),
];
const pathText = (key, label, value) => text(key, label, value, { className: 'mono' });
const pageList = (key, label, value) => text(key, label, (r) => value(r)[0] ?? '', {
  className: 'mono',
  cell: (r) => (value(r).length ? firstPlus(value(r), 'more') : null),
});
const stationColumn = text('station', 'Station', (r) => r.station, {
  cell: (r) => (r.station ? { text: r.station, title: r.stationName ?? 'The station whose page brought this visitor' } : null),
});
const deviceColumn = text('device', 'Device', (r) => r.device, {
  cell: (r) => (r.device ? { text: deviceSummary(r.device), title: r.device } : null),
});

// What opens under a visitor: one row per visit, newest first.
const RADS10_DETAILS = {
  visits: {
    noun: ['visit', 'visits'],
    time: (r) => r.startedAt,
    columns: [
      date('started', 'Started', (r) => r.startedAt),
      pathText('landing', 'Landed on', (r) => r.landing),
      pageList('pages', 'Pages opened', (r) => r.pages),
      timeOnSite('not recorded'),
      text('referrer', 'Came from', (r) => r.referrer),
      ipColumn(oneIp),
      placeColumn(onePlace, oneIp),
      deviceColumn,
    ],
  },
};

const RADS10_TABS = [
  {
    id: 'visitors',
    label: 'Visitors',
    rows: (report) => report.visitors,
    sort: ['lastSeen', 'desc'],
    expandable: true,
    columns: [
      ...visitorColumns,
      stationColumn,
      expandable('visits', 'Visits', 'visits'),
      count('pageViews', 'Page views', (r) => r.pageViews),
      pageList('pages', 'Pages opened', (r) => r.pages),
      timeOnSite(null),
      date('firstSeen', 'First seen', (r) => r.firstSeen),
      date('lastSeen', 'Last seen', (r) => r.lastSeen),
      ipColumn((r) => r.ipAddresses),
      placeColumn((r) => r.locations, (r) => r.ipAddresses),
      deviceColumn,
    ],
    csv: {
      headers: ['Visitor', 'Type', 'Account', 'Browser id', 'Station', 'Visits', 'Page views', 'Pages opened',
        'Time on site (seconds)', 'First seen', 'Last seen', 'Addresses', 'Locations', 'Device'],
      row: (r) => [r.name, r.kind, r.account, r.key, r.station, r.visits, r.pageViews, joined(r.pages),
        r.activeSeconds, r.firstSeen, r.lastSeen, joined(r.ipAddresses), joined(r.locations), r.device],
    },
  },
  {
    id: 'visits',
    label: 'Visits',
    rows: (report) => report.visits,
    sort: ['started', 'desc'],
    columns: [
      date('started', 'Started', (r) => r.startedAt),
      ...visitorColumns,
      pathText('landing', 'Landed on', (r) => r.landing),
      count('pageViews', 'Page views', (r) => r.pageViews, {
        cell: (r) => ({ text: String(r.pageViews), title: r.pages.join('\n') }),
      }),
      timeOnSite('not recorded'),
      text('referrer', 'Came from', (r) => r.referrer),
      stationColumn,
      ipColumn(oneIp),
      placeColumn(onePlace, oneIp),
      deviceColumn,
    ],
    csv: {
      headers: ['Started', 'Last page at', 'Visitor', 'Type', 'Account', 'Browser id', 'Landed on', 'Page views',
        'Pages opened', 'Time on site (seconds)', 'Came from', 'Station', 'IP address', 'Location', 'Device'],
      row: (r) => [r.startedAt, r.lastAt, r.name, r.kind, r.account, r.personKey, r.landing, r.pageViews,
        joined(r.pages), r.activeSeconds, r.referrer, r.station, r.ip, r.location, r.device],
    },
  },
  {
    id: 'pages',
    label: 'Pages',
    rows: (report) => report.pages,
    sort: ['views', 'desc'],
    columns: [
      pathText('path', 'Page', (r) => r.path),
      count('views', 'Views', (r) => r.views),
      count('visitors', 'Visitors', (r) => r.visitors),
      count('visits', 'Visits', (r) => r.visits),
      timeOnSite(null),
      date('lastAt', 'Last opened', (r) => r.lastAt),
    ],
    csv: {
      headers: ['Page', 'Views', 'Visitors', 'Visits', 'Time on page (seconds)', 'Last opened'],
      row: (r) => [r.path, r.views, r.visitors, r.visits, r.activeSeconds, r.lastAt],
    },
  },
  {
    id: 'clicks',
    label: 'Shop clicks',
    rows: (report) => report.clicks,
    sort: ['clicks', 'desc'],
    columns: [
      text('shop', 'Shop', (r) => r.shop),
      text('station', 'Station code', (r) => r.station, { className: 'mono' }),
      text('stationName', 'Station', (r) => r.stationName, {
        cell: (r) => r.stationName ?? (r.station ? { text: 'house code', tone: 'muted' } : null),
      }),
      count('clicks', 'Clicks', (r) => r.clicks),
      date('lastAt', 'Last click', (r) => r.lastAt),
    ],
    csv: {
      headers: ['Shop', 'Shop id', 'Station code', 'Station', 'Clicks', 'Last click'],
      row: (r) => [r.shop, r.slug, r.station, r.stationName, r.clicks, r.lastAt],
    },
  },
];

// ---- The two products ----

function ceuTiles({ totals, includeDemo, demoHidden, geoipConfigured, locationLookup }) {
  const demoNote = includeDemo ? 'demo sittings included' : demoHidden ? `${demoHidden} demo hidden` : 'demo excluded';
  return [
    ['People', totals.people, `${totals.signedInOnly} signed in only`],
    ['Sign-ins', totals.signIns, 'self-declared visits'],
    ['Sittings', totals.sittings, demoNote],
    ['Finished', totals.finished, `${totals.certificates} with a certificate`],
    ['Seat time', formatSeat(totals.seatMinutes), 'credited'],
    // The API says whether it resolves addresses at all; zero means something different when it doesn't.
    ['Locations', totals.locations, geoipConfigured === false ? 'address lookup is off'
      : locationLookup ? 'placed from IP addresses' : 'sittings + sign-ins placed'],
  ];
}

function rads10Tiles({ totals, includeAdmin, adminHidden, pages, locationLookup }) {
  const adminNote = includeAdmin ? 'admin visits included' : adminHidden ? `${adminHidden} admin hidden` : 'admin excluded';
  return [
    ['Unique visitors', totals.visitors, `${totals.accounts} logged in to an account`],
    ['Visits', totals.visits, adminNote],
    ['Page views', totals.pageViews, `across ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`],
    ['Time on site', formatDuration(totals.activeSeconds) ?? DASH, 'with the site on screen'],
    ['Shop clicks', totals.clicks, `to ${totals.shopsClicked} ${totals.shopsClicked === 1 ? 'shop' : 'shops'}`],
    ['Places', totals.locations, locationLookup ? `${totals.placed} of ${totals.visitors} visitors placed` : 'address lookup is off'],
  ];
}

const SITES = [
  {
    id: 'ceu',
    label: 'CEU Stamps',
    subtitle: 'CEU Stamps · read-only · contains student contact details — do not share',
    demoLabel: 'Include demo sittings',
    origin: 'the CEU Stamps API',
    file: 'ceustamps',
    tabs: CEU_TABS,
    details: CEU_DETAILS,
    tiles: ceuTiles,
    footnote: 'A sign-in is self-declared and unverified — the record a board relies on is the sittings, ' +
      'which start from a redeemed voucher.',
  },
  {
    id: 'rads10',
    label: 'RADS10',
    subtitle: 'RADS10 · read-only · contains visitors’ IP addresses — do not share',
    demoLabel: 'Include admin visits',
    origin: 'the RADS10 API',
    file: 'rads10',
    tabs: RADS10_TABS,
    details: RADS10_DETAILS,
    tiles: rads10Tiles,
    footnote: 'A visitor is a browser, not a person: the same person on a phone and a laptop counts twice, and ' +
      'clearing the browser starts them again. Visits are counted from the day rads10.com began reporting them. ' +
      'Shop clicks are counted separately and are not tied to a visitor.',
  },
];

// ---- State ----

// #rads10 in the address opens that product, so a link can point at either.
const startSite = SITES.find((s) => `#${s.id}` === location.hash) ?? SITES[0];

const state = {
  site: startSite,
  report: null,
  range: null, // the From / To days the loaded report was run for
  tab: startSite.tabs[0],
  sortKey: startSite.tabs[0].sort[0],
  sortDir: startSite.tabs[0].sort[1],
  page: 1,
  pageSize: 10,
  byPerson: {}, // detail kind → (person key → that person's rows)
  open: new Map(), // person key → which detail is open under them
};
let latestRequest = 0;

function sortedRows() {
  const rows = state.tab.rows(state.report);
  const column = state.tab.columns.find((c) => c.key === state.sortKey);
  return column ? sortRows(rows, column, state.sortDir) : rows;
}

function groupByPerson(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.personKey)) groups.set(row.personKey, []);
    groups.get(row.personKey).push(row);
  }
  return groups;
}

// Stable ids for aria-controls; licence numbers can hold characters an id should not.
const detailIds = new Map();
function detailId(key) {
  if (!detailIds.has(key)) detailIds.set(key, `detail-${detailIds.size + 1}`);
  return detailIds.get(key);
}

// ---- Rendering ----

function renderSites() {
  $('sites').replaceChildren(
    ...SITES.map((site) => el('button', {
      type: 'button', 'aria-current': site === state.site ? 'true' : null, onclick: () => selectSite(site),
    }, site.label)),
  );
  $('subtitle').textContent = state.site.subtitle;
  $('demolabel').textContent = state.site.demoLabel;
  $('footnote').textContent = state.site.footnote;
  document.title = `${state.site.label} · Usage report`;
}

function renderTiles() {
  const tiles = state.site.tiles(state.report);
  $('tiles').replaceChildren(
    ...tiles.map(([label, value, sub]) =>
      el('div', { className: 'tile' },
        el('div', { className: 'label', text: label }),
        el('div', { className: 'value', text: String(value) }),
        el('div', { className: 'sub', text: sub }))),
  );
}

function renderTabs() {
  $('tabs').replaceChildren(
    ...state.site.tabs.map((tab) => {
      const selected = tab === state.tab;
      return el('button', {
        type: 'button', role: 'tab', id: `tab-${tab.id}`, 'aria-selected': String(selected),
        'aria-controls': 'panel', tabindex: selected ? '0' : '-1', onclick: () => selectTab(tab),
      }, tab.label, el('span', { className: 'count', text: String(tab.rows(state.report).length) }));
    }),
  );
  $('panel').setAttribute('aria-labelledby', `tab-${state.tab.id}`);
}

function renderCell(column, row) {
  const raw = column.cell ? column.cell(row) : column.value(row);
  const cell = raw == null || raw === '' ? { text: DASH, tone: 'muted' } : typeof raw === 'object' ? raw : { text: String(raw) };
  const classes = [column.type === 'number' && 'num', column.className].filter(Boolean).join(' ');
  if (cell.expand) {
    const open = state.open.get(row.key) === cell.expand;
    const noun = state.site.details[cell.expand].noun[1];
    return el('td', { className: classes || null }, el('button', {
      type: 'button',
      className: 'expander',
      'aria-expanded': String(open),
      'aria-controls': open ? detailId(row.key) : null,
      'aria-label': `${open ? 'Hide' : 'Show'} ${cell.text} ${noun} for ${row.name}`,
      'data-person': row.key,
      'data-kind': cell.expand,
      onclick: () => toggleDetail(row.key, cell.expand),
    }, cell.text, el('span', { className: 'caret', 'aria-hidden': 'true', text: open ? '▾' : '▸' })));
  }
  const main = el('span', {
    className: [cell.pill ? `pill ${cell.tone}` : cell.tone, column.className === 'course' && 'truncate']
      .filter(Boolean).join(' ') || null,
    title: cell.title,
    text: cell.text,
  });
  return el('td', { className: classes || null }, main,
    cell.more ? el('span', { className: 'more', title: cell.title, text: cell.more }) : null,
    cell.tag ? el('span', { className: 'tag', text: cell.tag }) : null);
}

/** The rows under a person whose Sign-ins, Sittings or Visits count is open, or null. */
function detailRow(student, span) {
  const kind = state.open.get(student.key);
  if (!kind) return null;
  const spec = state.site.details[kind];
  const rows = [...(state.byPerson[kind]?.get(student.key) ?? [])]
    .sort((a, b) => String(spec.time(b) ?? '').localeCompare(String(spec.time(a) ?? '')));
  const noun = spec.noun[rows.length === 1 ? 0 : 1];
  return el('tr', { className: 'detail', id: detailId(student.key) },
    el('td', { colspan: String(span) },
      el('div', { className: 'detail-body' },
        el('p', { className: 'detail-title', text: `${rows.length} ${noun} by ${student.name}, newest first` }),
        el('table', { className: 'subtable' },
          el('thead', {}, el('tr', {}, ...spec.columns.map((c) =>
            el('th', { scope: 'col', className: c.type === 'number' ? 'num' : null, text: c.label })))),
          el('tbody', {}, ...rows.map((r) => el('tr', {}, ...spec.columns.map((c) => renderCell(c, r)))))))));
}

function renderTable() {
  const { columns } = state.tab;
  const rows = sortedRows(); // sort first, then page (§6.4)
  const info = pageInfo(rows.length, state.page, state.pageSize);
  state.page = info.page;

  const head = el('tr', {}, ...columns.map((col) => {
    const active = col.key === state.sortKey;
    const ascending = state.sortDir === 'asc';
    return el('th', {
      scope: 'col',
      className: col.type === 'number' ? 'num' : null,
      'aria-sort': active ? (ascending ? 'ascending' : 'descending') : null,
    }, el('button', { type: 'button', onclick: () => sortBy(col) },
      col.label,
      el('span', { className: 'arrow', 'aria-hidden': 'true', text: active ? (ascending ? '▲' : '▼') : '' })));
  }));
  $('grid').tHead.replaceChildren(head);

  const body = $('grid').tBodies[0];
  if (rows.length) {
    body.replaceChildren(...rows.slice(info.start, info.end).flatMap((row) => [
      el('tr', {}, ...columns.map((col) => renderCell(col, row))),
      state.tab.expandable ? detailRow(row, columns.length) : null,
    ].filter(Boolean)));
  } else {
    body.replaceChildren(el('tr', {}, el('td', { colspan: String(columns.length), className: 'empty', text: 'Nothing in this range.' })));
  }

  $('showing').textContent = rows.length ? `Showing ${info.start + 1}–${info.end} of ${rows.length}` : 'Showing 0 of 0';
  $('pager').hidden = info.pageCount <= 1;
  $('pagelabel').textContent = `Page ${info.page} of ${info.pageCount}`;
  for (const button of $('pager').querySelectorAll('button')) {
    const back = button.dataset.page === 'first' || button.dataset.page === 'prev';
    button.disabled = back ? info.page === 1 : info.page === info.pageCount;
  }
  $('csv').disabled = !rows.length;
}

function render() {
  $('results').hidden = !state.report;
  if (!state.report) return;
  renderTiles();
  renderTabs();
  renderTable();
}

// ---- Actions ----

function selectSite(site) {
  if (site === state.site) return;
  state.site = site;
  state.report = null; // the other product's rows mean nothing under these tabs
  state.tab = site.tabs[0];
  [state.sortKey, state.sortDir] = state.tab.sort;
  $('demo').checked = false;
  history.replaceState(null, '', site === SITES[0] ? location.pathname : `#${site.id}`);
  renderSites();
  render();
  runReport();
  $('sites').querySelector('[aria-current]')?.focus();
}

function selectTab(tab) {
  state.tab = tab;
  [state.sortKey, state.sortDir] = tab.sort; // each tab opens on its own default sort
  state.page = 1;
  renderTabs();
  renderTable();
}

function sortBy(column) {
  if (column.key === state.sortKey) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = column.key;
    state.sortDir = defaultDirection(column.type);
  }
  state.page = 1;
  renderTable();
}

function toggleDetail(key, kind) {
  if (state.open.get(key) === kind) state.open.delete(key);
  else state.open.set(key, kind); // one detail per student: opening Sittings replaces Sign-ins
  renderTable();
  // The table was redrawn; put focus back on the button that was pressed.
  const selector = `button.expander[data-person="${CSS.escape(key)}"][data-kind="${kind}"]`;
  $('grid').querySelector(selector)?.focus();
}

function goToPage(which) {
  const { pageCount } = pageInfo(sortedRows().length, state.page, state.pageSize);
  state.page = { first: 1, prev: state.page - 1, next: state.page + 1, last: pageCount }[which];
  renderTable();
}

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

async function runReport() {
  const fromDay = $('from').value;
  const toDay = $('to').value;
  const window = localDayWindow(fromDay, toDay);
  if (!window) return setStatus('Pick both a From and a To date.', true);
  if (Date.parse(window.to) <= Date.parse(window.from)) {
    return setStatus('The To date must be on or after the From date.', true);
  }

  const site = state.site;
  const params = new URLSearchParams({ site: site.id, from: window.from, to: window.to, includeDemo: $('demo').checked ? '1' : '0' });
  const request = ++latestRequest;
  $('run').disabled = true;
  setStatus('Loading…');
  try {
    const response = await fetch(`/api/report?${params}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (request !== latestRequest) return; // a newer run has started
    if (response.status === 401) throw new Error('Sign in to view the report — reload the page to be asked again.');
    if (!response.ok) throw new Error(body.error || `The server answered ${response.status}.`);

    state.report = body;
    state.range = { fromDay, toDay };
    state.page = 1;
    // The rows that open under a person are the report's lists of the same name.
    state.byPerson = Object.fromEntries(Object.keys(site.details).map((kind) => [kind, groupByPerson(body[kind])]));
    state.open = new Map();
    const label = `${dayOnly.format(new Date(window.from))} – ${dayOnly.format(addDays(new Date(window.to), -1))}`;
    const origin = body.source === 'api' ? site.origin : 'the database';
    const cut = body.truncated ? ' Too many page views for one report: only the newest are shown. Pick a shorter range.' : '';
    setStatus(`${label}, days on ${timeZone} time (UTC ${window.from} → ${window.to}). Loaded from ${origin} ${when(body.generatedAt)}.${cut}`);
    render();
  } catch (err) {
    if (request === latestRequest) setStatus(err.message || 'The report could not be loaded.', true);
  } finally {
    if (request === latestRequest) $('run').disabled = false;
  }
}

function downloadCsv() {
  if (!state.report) return;
  const tab = state.tab;
  const csv = `\uFEFF${toCsv(tab.csv.headers, sortedRows().map(tab.csv.row))}`; // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = el('a', { href: url, download: `${state.site.file}_${tab.id}_${state.range.fromDay}_to_${state.range.toDay}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function setLastDays(days) {
  const today = new Date();
  $('from').value = localDay(addDays(today, -days));
  $('to').value = localDay(today);
}

// ---- Wiring ----

setLastDays(30);
$('filters').addEventListener('submit', (event) => {
  event.preventDefault();
  runReport();
});
for (const button of document.querySelectorAll('.shortcuts button')) {
  button.addEventListener('click', () => {
    setLastDays(Number(button.dataset.days));
    runReport();
  });
}
$('pagesize').addEventListener('change', (event) => {
  state.pageSize = Number(event.target.value);
  state.page = 1;
  renderTable();
});
$('csv').addEventListener('click', downloadCsv);
for (const button of $('pager').querySelectorAll('button')) {
  button.addEventListener('click', () => goToPage(button.dataset.page));
}
$('tabs').addEventListener('keydown', (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  const tabs = state.site.tabs;
  const next = tabs[(tabs.indexOf(state.tab) + step + tabs.length) % tabs.length];
  selectTab(next);
  $(`tab-${next.id}`).focus();
});

// Load once on open; afterwards only when asked, so a half-typed date never fires a query.
renderSites();
runReport();
