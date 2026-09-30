// Minimal GTFS helpers for the data build scripts: download a zip, read CSV tables,
// and work out which services run on a given date.
import { unzipSync, strFromU8 } from 'fflate';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = path.resolve('.cache');
const MAX_CACHE_AGE_MS = 24 * 3600 * 1000;

export async function downloadCached(url, name) {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name);
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs < MAX_CACHE_AGE_MS) return readFile(file);
  } catch {
    // not cached yet
  }
  console.log(`  ↓ ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'sky-trip-data-build/0.1' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  return buf;
}

export function openZip(buf) {
  return unzipSync(new Uint8Array(buf));
}

/** Parses one CSV line, honouring double quotes. */
function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Iterates over the rows of a GTFS table. Only the requested columns are materialised,
 * which keeps memory reasonable on the large stop_times.txt files.
 */
export function* readTable(zip, name, columns) {
  const entry = zip[name];
  if (!entry) return;
  const text = strFromU8(entry).replace(/^﻿/, '');
  let start = 0;
  let header = null;
  let idx = null;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells;
      idx = columns.map((c) => header.indexOf(c));
      continue;
    }
    const row = {};
    for (let i = 0; i < columns.length; i++) row[columns[i]] = idx[i] >= 0 ? cells[idx[i]] ?? '' : '';
    yield row;
  }
}

/** Returns the set of service_ids active on `date` (YYYYMMDD), from calendar + calendar_dates. */
export function activeServices(zip, date) {
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00Z`).getUTCDay()
  ];
  const active = new Set();
  for (const r of readTable(zip, 'calendar.txt', ['service_id', 'start_date', 'end_date', weekday])) {
    if (r.start_date <= date && date <= r.end_date && r[weekday] === '1') active.add(r.service_id);
  }
  for (const r of readTable(zip, 'calendar_dates.txt', ['service_id', 'date', 'exception_type'])) {
    if (r.date !== date) continue;
    if (r.exception_type === '1') active.add(r.service_id);
    else active.delete(r.service_id);
  }
  return active;
}

/** Picks a representative weekday (a Tuesday) roughly two weeks into the feed. */
export function representativeDate(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 14));
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}
