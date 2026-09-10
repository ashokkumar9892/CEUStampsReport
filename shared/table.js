// Sorting and paging for the report grid (§6.4, §6.5).

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Dates and counts open largest / newest first; text opens A → Z. */
export function defaultDirection(type) {
  return type === 'text' ? 'asc' : 'desc';
}

const isEmpty = (v) => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));

function compare(a, b, type) {
  if (type === 'text') return collator.compare(String(a), String(b));
  if (type === 'date') return Date.parse(a) - Date.parse(b);
  return a - b;
}

/**
 * Sorts by column.value(row). Empty values go last in both directions; ties keep
 * their incoming order.
 */
export function sortRows(rows, column, direction) {
  const sign = direction === 'desc' ? -1 : 1;
  return rows
    .map((row) => ({ row, value: column.value(row) }))
    .sort((x, y) => {
      const ex = isEmpty(x.value);
      const ey = isEmpty(y.value);
      if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1;
      return sign * compare(x.value, y.value, column.type);
    })
    .map((entry) => entry.row);
}

/** Clamps the page and returns the [start, end) slice for it. */
export function pageInfo(total, page, size) {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * size;
  return { page: current, pageCount, start, end: Math.min(start + size, total), total };
}
