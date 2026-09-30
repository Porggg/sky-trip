// Darkness and moonlight for a given evening and place, computed locally with SunCalc.
import * as SunCalc from 'suncalc';

export interface Interval {
  from: Date;
  to: Date;
}

export interface NightForecast {
  /** Evening the night starts on (local noon of that day). */
  date: Date;
  /** Start / end of astronomical night (Sun below −18°), or nautical night in midsummer. */
  darkFrom: Date | null;
  darkTo: Date | null;
  /** True when the Sun never reaches −18° (French summer nights around the solstice). */
  noAstronomicalNight: boolean;
  /** Illuminated fraction of the Moon around midnight, 0–1. */
  moonFraction: number;
  moonWaxing: boolean;
  /** Minutes of true darkness with the Moon below the horizon. */
  moonlessMinutes: number;
  /** Longest stretch of dark sky without the Moon. */
  bestWindow: Interval | null;
}

const STEP_MIN = 5;

export function eveningOf(isoDate: string, offsetDays = 0): Date {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

export function forecastNight(evening: Date, lng: number, lat: number): NightForecast {
  const next = new Date(evening.getTime() + 24 * 3600e3);
  const today = SunCalc.getTimes(evening, lat, lng);
  const tomorrow = SunCalc.getTimes(next, lat, lng);

  let darkFrom = today.night ?? null;
  let darkTo = tomorrow.nightEnd ?? null;
  const noAstronomicalNight = !darkFrom || !darkTo || darkTo <= darkFrom;
  if (noAstronomicalNight) {
    darkFrom = today.nauticalDusk ?? today.dusk ?? null;
    darkTo = tomorrow.nauticalDawn ?? tomorrow.dawn ?? null;
  }

  const midnight = new Date((today.nadir as Date).getTime() + (today.nadir < evening ? 24 * 3600e3 : 0));
  const illum = SunCalc.getMoonIllumination(midnight);

  let moonlessMinutes = 0;
  let bestWindow: Interval | null = null;
  if (darkFrom && darkTo && darkTo > darkFrom) {
    let runStart: Date | null = null;
    const closeRun = (end: Date) => {
      if (runStart && (!bestWindow || end.getTime() - runStart.getTime() > bestWindow.to.getTime() - bestWindow.from.getTime())) {
        bestWindow = { from: runStart, to: end };
      }
      runStart = null;
    };
    for (let t = darkFrom.getTime(); t <= darkTo.getTime(); t += STEP_MIN * 60e3) {
      const at = new Date(t);
      const moonUp = SunCalc.getMoonPosition(at, lat, lng).altitude > 0;
      if (!moonUp) {
        moonlessMinutes += STEP_MIN;
        if (!runStart) runStart = at;
      } else {
        closeRun(at);
      }
    }
    closeRun(darkTo);
  }

  return {
    date: evening,
    darkFrom,
    darkTo,
    noAstronomicalNight,
    moonFraction: illum.fraction,
    moonWaxing: illum.waxing,
    moonlessMinutes,
    bestWindow,
  };
}

/** A 0–1 score combining sky darkness and moonlight, used to rank nights. */
export function nightScore(sqm: number | null, night: NightForecast): number {
  const sky = sqm == null ? 0.5 : Math.max(0, Math.min(1, (sqm - 18.5) / (21.8 - 18.5)));
  const darkHours = night.darkFrom && night.darkTo ? (night.darkTo.getTime() - night.darkFrom.getTime()) / 3600e3 : 0;
  const moon = darkHours > 0 ? night.moonlessMinutes / 60 / darkHours : 0;
  return sky * 0.6 + moon * 0.4;
}
