// The report page (§6). Data comes from GET /api/report; sorting, paging and
// CSV happen here, on the full result for the range.

import {
  addDays, emptyLocationLabel, formatSeat, ipDisplay, localDay, localDayWindow, toCsv,
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
  text('location', 'Location', (r) => locations(r)[0] ?? '', { cell: (r) => placesCell(locations(r), ips(r)) });

const contactColumns = (nameLabel, licence) => [
  text('name', nameLabel, (r) => (r.name === NO_NAME ? '' : r.name), {
    cell: (r) => (r.name === NO_NAME ? { text: NO_NAME, tone: 'muted' } : r.name),
  }),
  text('licence', 'Licence', licence, { className: 'mono' }),
  text('email', 'Email', (r) => r.email),
  text('phone', 'Phone', (r) => r.phone),
];

const oneIp = (r) => (r.ipAddress ? [r.ipAddress] : []);
const onePlace = (r) => (r.location ? [r.location] : []);

const TABS = [
  {
    id: 'students',
    label: 'Students',
    rows: (report) => report.students,
    sort: ['lastSeen', 'desc'],
    columns: [
      ...contactColumns('Student', (r) => r.key),
      text('courses', 'Courses taken', (r) => r.courses[0] ?? '', {
        className: 'course',
        cell: (r) => (r.courses.length ? firstPlus(r.courses, 'more') : { text: 'signed in, never enrolled', tone: 'muted' }),
      }),
      count('signIns', 'Sign-ins', (r) => r.signIns),
      count('sittings', 'Sittings', (r) => r.sittings),
      count('finished', 'Finished', (r) => r.finished),
      seat((r) => r.seatMinutes),
      date('lastSeen', 'Last seen', (r) => r.lastSeen),
      ipColumn((r) => r.ipAddresses),
      placeColumn((r) => r.locations, (r) => r.ipAddresses),
    ],
    csv: {
      headers: ['Name', 'Licence', 'Email', 'Phone', 'State', 'Courses taken', 'Sign-ins', 'Sittings', 'Finished',
        'Seat minutes', 'Average score', 'First seen', 'Last seen', 'Addresses', 'Locations'],
      row: (r) => [r.name, r.key, r.email, r.phone, r.state, joined(r.courses), r.signIns, r.sittings, r.finished,
        r.seatMinutes, r.averageScore, r.firstSeen, r.lastSeen, joined(r.ipAddresses), joined(r.locations)],
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
      ...contactColumns('Name', (r) => r.license),
      ipColumn(oneIp),
      placeColumn(onePlace, oneIp),
    ],
    csv: {
      headers: ['When', 'Name', 'Licence', 'Email', 'Phone', 'State', 'IP address', 'Location', 'Device'],
      row: (r) => [r.at, r.name, r.license, r.email, r.phone, r.state, r.ip, r.location, r.device],
    },
  },
];

// ---- State ----

const state = {
  report: null,
  range: null, // the From / To days the loaded report was run for
  tab: TABS[0],
  sortKey: TABS[0].sort[0],
  sortDir: TABS[0].sort[1],
  page: 1,
  pageSize: 10,
};
let latestRequest = 0;

function sortedRows() {
  const rows = state.tab.rows(state.report);
  const column = state.tab.columns.find((c) => c.key === state.sortKey);
  return column ? sortRows(rows, column, state.sortDir) : rows;
}

// ---- Rendering ----

function renderTiles() {
  const { totals, includeDemo, demoHidden, geoipConfigured } = state.report;
  const demoNote = includeDemo ? 'demo sittings included' : demoHidden ? `${demoHidden} demo hidden` : 'demo excluded';
  const tiles = [
    ['People', totals.people, `${totals.signedInOnly} signed in only`],
    ['Sign-ins', totals.signIns, 'self-declared visits'],
    ['Sittings', totals.sittings, demoNote],
    ['Finished', totals.finished, `${totals.certificates} with a certificate`],
    ['Seat time', formatSeat(totals.seatMinutes), 'credited'],
    // The API says whether it resolves addresses at all; zero means something different when it doesn't.
    ['Locations', totals.locations, geoipConfigured === false ? 'address lookup is off' : 'sittings + sign-ins placed'],
  ];
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
    ...TABS.map((tab) => {
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
    body.replaceChildren(...rows.slice(info.start, info.end)
      .map((row) => el('tr', {}, ...columns.map((col) => renderCell(col, row)))));
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

  const params = new URLSearchParams({ from: window.from, to: window.to, includeDemo: $('demo').checked ? '1' : '0' });
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
    const label = `${dayOnly.format(new Date(window.from))} – ${dayOnly.format(addDays(new Date(window.to), -1))}`;
    const origin = body.source === 'api' ? 'the CEU Stamps API' : 'the database';
    setStatus(`${label}, days on ${timeZone} time (UTC ${window.from} → ${window.to}). Loaded from ${origin} ${when(body.generatedAt)}.`);
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
  const link = el('a', { href: url, download: `ceustamps_${tab.id}_${state.range.fromDay}_to_${state.range.toDay}.csv` });
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
  const next = TABS[(TABS.indexOf(state.tab) + step + TABS.length) % TABS.length];
  selectTab(next);
  $(`tab-${next.id}`).focus();
});

// Load once on open; afterwards only when asked, so a half-typed date never fires a query.
runReport();
