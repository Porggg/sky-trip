const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

export function km(meters: number): string {
  const k = meters / 1000;
  return `${k < 10 ? nf1.format(k) : nf0.format(k)} km`;
}

export function meters(value: number): string {
  return `${nf0.format(value)} m`;
}

export function percent(fraction: number): string {
  return `${nf0.format(fraction * 100)} %`;
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });

export function clock(date: Date | null | undefined): string {
  return date ? timeFmt.format(date).replace(':', ' h ') : '—';
}

export function shortDay(date: Date): string {
  return dayFmt.format(date);
}

/** YYYY-MM-DD in the Europe/Paris calendar. */
export function isoDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(date);
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
