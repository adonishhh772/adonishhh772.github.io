/**
 * Astronomy: where the sun and the moon actually are.
 *
 * The world's light used to be a boolean — day or night — with the two sky
 * bodies sliding up and down a decorative arc that had nothing to do with the
 * visitor's own sky. This module replaces that with the real thing: given the
 * visitor's local clock and a position on Earth, it computes the sun's and the
 * moon's altitude and azimuth to within a fraction of a degree.
 *
 * The algorithms are the standard low-precision ones from Meeus' *Astronomical
 * Formulae for Calculators*: good to about 0.01° for the sun and about 0.3° for
 * the moon. That is far more than a sky needs. The point is not to be an
 * ephemeris — it is that a sun which rises in the east in the morning and sets
 * in the west at night, sits lower in winter than in summer, and is followed
 * across the sky by a moon at the correct phase, is a sun that *means*
 * something. A decorative arc cannot do that, and a viewer notices even without
 * being able to say why.
 *
 * Everything here is arithmetic on numbers: no Three.js and no DOM beyond
 * reading the clock, so it can be exercised on its own.
 */

export const DEG = Math.PI / 180;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Hermite smoothstep between two edges. Between them the band is monotonic. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function norm360(degrees: number): number {
  const value = degrees % 360;
  return value < 0 ? value + 360 : value;
}

/** Angular difference `a - b`, wrapped into `(-180, 180]`. */
function deltaAngle(a: number, b: number): number {
  let value = norm360(a - b);
  if (value > 180) value -= 360;
  return value;
}

/* ── Time and place ──────────────────────────────────────────────────── */

export interface GeoLocation {
  latitude: number;
  longitude: number;
  /** Local timezone offset in hours, east positive. */
  timezone: number;
}

export interface ClockReading extends GeoLocation {
  /** Julian day number, UTC. */
  jd: number;
  /** Hours since local midnight, fractional. */
  localHours: number;
}

/**
 * Estimate a position from the browser's own timezone offset.
 *
 * Where the visitor is, is personal data, and a permission prompt in exchange
 * for drawing a sky is not a trade worth making. The timezone offset places the
 * visitor within about 15° of longitude, which is the difference between a sun
 * that sets at 19:00 and one that sets at 20:00 — visible, but never wrong
 * enough to look broken. Longitude therefore comes straight from the offset,
 * and latitude from the mid-northern default.
 */
export function estimateLocation(date = new Date()): GeoLocation {
  /* `getTimezoneOffset` is minutes *behind* UTC, so the sign flips. */
  const timezone = -date.getTimezoneOffset() / 60;
  return { longitude: timezone * 15, latitude: 45, timezone };
}

export function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

export function readClock(date = new Date(), location?: GeoLocation): ClockReading {
  const geo = location ?? estimateLocation(date);
  return {
    ...geo,
    jd: julianDay(date),
    localHours: date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600,
  };
}

/** Local mean sidereal time in degrees: how far the sky has turned. */
export function siderealTime(jd: number, longitude: number): number {
  const t = (jd - 2451545) / 36525;
  const theta =
    280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - (t * t * t) / 38710000;
  return norm360(theta + longitude);
}

/** Equatorial coordinates to altitude and compass bearing for a place. */
function horizon(
  rightAscension: number,
  declination: number,
  latitude: number,
  lst: number,
): { altitude: number; azimuth: number } {
  const ra = norm360(lst - rightAscension) * DEG;
  const dec = declination * DEG;
  const lat = latitude * DEG;

  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ra);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG;

  /* The standard expression, which measures from south; +180 turns it into a
     compass bearing so 90° is east and 270° is west. */
  const azimuth = norm360(
    Math.atan2(
      Math.sin(ra),
      Math.cos(ra) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat),
    ) /
      DEG +
      180,
  );
  return { altitude, azimuth };
}

/* ── Sun ─────────────────────────────────────────────────────────────── */

export interface BodyPosition {
  /** Degrees above the horizon; negative means set. */
  altitude: number;
  /** Compass bearing in degrees: 0 north, 90 east, 180 south, 270 west. */
  azimuth: number;
  rightAscension: number;
  declination: number;
  /** Ecliptic longitude in degrees — carried for the moon's phase. */
  eclipticLongitude: number;
}

export function sunPosition(clock: ClockReading): BodyPosition {
  const t = (clock.jd - 2451545) / 36525;
  const meanLongitude = norm360(280.46646 + 36000.76983 * t + 0.0003032 * t * t);
  const meanAnomaly = norm360(357.52911 + 35999.05029 * t - 0.0001537 * t * t);
  const anomaly = meanAnomaly * DEG;

  const centre =
    Math.sin(anomaly) * (1.914602 - 0.004817 * t - 0.000014 * t * t) +
    Math.sin(2 * anomaly) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * anomaly) * 0.000289;
  const trueLongitude = meanLongitude + centre;

  /*
   * Nutation and aberration: a few hundredths of a degree. Kept because it is
   * two lines, and because it is the difference between the computed equinox
   * falling on the right day and on the day before.
   */
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const obliquity = (23.439291 - 0.0130042 * t) * DEG;

  const lambda = apparentLongitude * DEG;
  const rightAscension = norm360(
    Math.atan2(Math.cos(obliquity) * Math.sin(lambda), Math.cos(lambda)) / DEG,
  );
  const declination =
    Math.asin(Math.sin(obliquity) * Math.sin(lambda)) / DEG;

  const { altitude, azimuth } = horizon(
    rightAscension,
    declination,
    clock.latitude,
    siderealTime(clock.jd, clock.longitude),
  );

  return { altitude, azimuth, rightAscension, declination, eclipticLongitude: apparentLongitude };
}

/* ── Moon ────────────────────────────────────────────────────────────── */

export interface MoonPosition extends BodyPosition {
  /** Illuminated fraction: 0 at new moon, 1 at full. */
  illumination: number;
  /** 0 new, 90 first quarter, 180 full, 270 last quarter. */
  phaseAngle: number;
  /** The sun's ecliptic longitude minus the moon's, wrapped to `(-180, 180]`. */
  elongation: number;
}

/**
 * The moon, from the standard truncated lunar theory.
 *
 * Six longitude and six latitude terms rather than the sixty-odd of a full
 * implementation: what is kept are the terms larger than about 0.05°, which is
 * a small fraction of the moon's own half-degree disc. The result is a moon in
 * the right place, in the right phase, at the right time — which is what a sky
 * needs — for a few hundred floating-point operations.
 */
export function moonPosition(clock: ClockReading, sun: BodyPosition): MoonPosition {
  const t = (clock.jd - 2451545) / 36525;

  const meanLongitude = norm360(
    218.3164477 + 481267.88123421 * t - 0.0015786 * t * t + (t * t * t) / 538841,
  );
  const meanElongation = norm360(
    297.8501921 + 445267.1114034 * t - 0.0018819 * t * t + (t * t * t) / 545868,
  );
  const sunAnomaly = norm360(
    357.5291092 + 35999.0502909 * t - 0.0001536 * t * t + (t * t * t) / 24490000,
  );
  const moonAnomaly = norm360(
    134.9633964 + 477198.8675055 * t + 0.0087414 * t * t + (t * t * t) / 69699,
  );
  const argumentOfLatitude = norm360(
    93.272095 + 483202.0175233 * t - 0.0036539 * t * t - (t * t * t) / 3526000,
  );

  /* The moon's orbit is noticeably non-circular. These correct the terms that
     involve the sun's anomaly — the largest single refinement after the main
     terms themselves. */
  const e = 1 - 0.002516 * t - 0.0000074 * t * t;
  const d = meanElongation * DEG;
  const m = sunAnomaly * DEG;
  const mp = moonAnomaly * DEG;
  const f = argumentOfLatitude * DEG;

  const longitude =
    meanLongitude +
    6.288774 * Math.sin(mp) +
    1.274027 * Math.sin(2 * d - mp) +
    0.658314 * Math.sin(2 * d) +
    0.213618 * Math.sin(2 * mp) -
    0.185116 * Math.sin(m) * e -
    0.114332 * Math.sin(2 * f);

  const latitude =
    5.128122 * Math.sin(f) +
    0.280602 * Math.sin(mp + f) +
    0.277693 * Math.sin(mp - f) +
    0.173237 * Math.sin(2 * d - f) +
    0.055413 * Math.sin(2 * d - mp + f) +
    0.046271 * Math.sin(2 * d - mp - f);

  const lambda = longitude * DEG;
  const beta = latitude * DEG;
  const obliquity = (23.439291 - 0.0130042 * t) * DEG;

  const rightAscension = norm360(
    Math.atan2(
      Math.sin(lambda) * Math.cos(obliquity) - Math.tan(beta) * Math.sin(obliquity),
      Math.cos(lambda),
    ) / DEG,
  );
  const declination =
    Math.asin(
      Math.sin(beta) * Math.cos(obliquity) +
        Math.cos(beta) * Math.sin(obliquity) * Math.sin(lambda),
    ) / DEG;

  const { altitude, azimuth } = horizon(
    rightAscension,
    declination,
    clock.latitude,
    siderealTime(clock.jd, clock.longitude),
  );

  /*
   * Phase, measured the way it is actually defined: the difference in ecliptic
   * longitude between the moon and the sun. At 0° the moon is between the Earth
   * and the sun and there is nothing lit to see; at 180° it is opposite and
   * full. Taking the magnitude of this difference — as an early version did —
   * makes a waning crescent indistinguishable from a waxing one, which is a
   * mistake nobody can name but everybody can see.
   */
  const elongation = deltaAngle(longitude, sun.eclipticLongitude);
  const phaseAngle = Math.abs(elongation);
  const illumination = (1 - Math.cos(elongation * DEG)) / 2;

  return {
    altitude,
    azimuth,
    rightAscension,
    declination,
    eclipticLongitude: norm360(longitude),
    illumination,
    phaseAngle,
    elongation,
  };
}

/* ── State ───────────────────────────────────────────────────────────── */

export interface SkyState {
  sun: BodyPosition;
  moon: MoonPosition;
  /** The Julian day this state was computed for. */
  jd: number;
  /** The longitude it was computed for, for the sidereal rotation. */
  longitude: number;
  /** The visitor's latitude, for the caption and the diagnostics. */
  latitude: number;
  /** 0 at night, 1 in full daylight. Smooth through twilight. */
  dayness: number;
  /** 1 at the darkest part of the night. */
  nightness: number;
  /** Peaks as the sun crosses the horizon: sunrise and sunset. */
  twilight: number;
  /** Peaks with the sun low and warm: the golden hour. */
  golden: number;
  /** The deep blue after the sun has set and before it rises. */
  blueHour: number;
  /** How much haze the air carries. */
  haze: number;
  /** A clock label for the visitor, e.g. "18:42". */
  label: string;
  /** The local wall-clock hour, fractional, for the dial. */
  hours: number;
  /** Whether this state came from a manual override rather than the clock. */
  overridden: boolean;
}

/**
 * Turn a clock reading into the whole sky's state.
 *
 * The four factors are deliberately not one curve. A sky does not cross-fade
 * from night to day: it passes through *stages*, and each stage has its own
 * colour. Civil twilight is not a dimmer noon and the golden hour is not a
 * slightly orange morning, so keeping separate factors lets the palette name
 * each stage rather than trying to recover all of them from one number.
 */
export function computeSkyState(
  clock: ClockReading,
  options: { overridden?: boolean; label?: string } = {},
): SkyState {
  const sun = sunPosition(clock);
  const moon = moonPosition(clock, sun);

  /*
   * Daylight follows the sun's *altitude*, not the hour, which is what makes
   * the world dark at 16:00 in a northern December and light at 22:00 in a
   * northern June. The band from -6° to +3° is civil twilight, and crossing it
   * is what the visitor perceives as sunrise and sunset.
   */
  const dayness = smoothstep(-6, 3, sun.altitude);

  /*
   * The golden hour is a *window* around the horizon, not a monotonic ramp: it
   * peaks with the sun about 4.5° up, falls away below the horizon, and is gone
   * once the sun is high. A bell rather than a smoothstep, for that reason.
   */
  const golden = clamp01(Math.exp(-Math.pow((sun.altitude - 4.5) / 7.5, 2)));
  const twilight = clamp01(Math.exp(-Math.pow(sun.altitude / 3.4, 2)) * smoothstep(-11, -4.5, sun.altitude));
  const blueHour = clamp01(Math.exp(-Math.pow((sun.altitude + 5.5) / 3.6, 2)));
  const nightness = 1 - dayness;

  return {
    sun,
    moon,
    jd: clock.jd,
    longitude: clock.longitude,
    latitude: clock.latitude,
    dayness,
    nightness,
    twilight,
    golden,
    blueHour,
    /* Haze thickens as the sun drops: a low sun lights the air from beneath. */
    haze: clamp01(0.16 + golden * 0.62 + twilight * 0.5 + blueHour * 0.22),
    label: options.label ?? formatClock(clock.localHours),
    hours: clock.localHours,
    overridden: options.overridden ?? false,
  };
}

/** `18:42` — a 24-hour clock label from fractional hours. */
export function formatClock(hours: number): string {
  const wrapped = ((hours % 24) + 24) % 24;
  const h = Math.floor(wrapped);
  const m = Math.floor((wrapped - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A word for the phase, for the sky's caption. */
export function phaseName(elongation: number): string {
  const value = norm360(elongation);
  if (value < 22.5 || value >= 337.5) return 'new moon';
  if (value < 67.5) return 'waxing crescent';
  if (value < 112.5) return 'first quarter';
  if (value < 157.5) return 'waxing gibbous';
  if (value < 202.5) return 'full moon';
  if (value < 247.5) return 'waning gibbous';
  if (value < 292.5) return 'last quarter';
  return 'waning crescent';
}

/* ── The clock the world runs on ─────────────────────────────────────── */

export interface SkyOverride {
  /** Local hour, 0..24. */
  hour: number;
  label?: string;
}

/** What a manual time selection asks for, whether from the dial or a URL. */
export interface SkyRequest extends SkyOverride {
  /**
   * The date to compute for. Defaults to today.
   *
   * The *date* is a second lever and it is not decoration: the moon's phase is a
   * property of the day rather than of the hour, so a system that can only move
   * the clock cannot be asked whether its phases are real. Nothing in the
   * visitor's own interface moves the date — the world is always today — but the
   * verification harness uses it, and a date that cannot be set is a phase that
   * cannot be checked.
   */
  date?: Date;
}

/**
 * The world's time source.
 *
 * Reads the visitor's real clock and recomputes the sky when the minute rolls
 * over. A sky does not need sixty updates a second, and the trigonometry — cheap
 * as it is — has no business running in the frame loop. A manual override pins
 * the sky to a chosen hour, so a visitor (or a verification run) can look at any
 * hour of the day without waiting for it.
 */
export class SkyClock {
  private readonly location: GeoLocation;
  private state: SkyState;
  private override: SkyOverride | null = null;
  private lastMinute: number;

  constructor(date = new Date(), location?: GeoLocation) {
    this.location = location ?? estimateLocation(date);
    this.state = computeSkyState(readClock(date, this.location));
    this.lastMinute = date.getMinutes();
  }

  get current(): SkyState {
    return this.state;
  }

  get place(): GeoLocation {
    return this.location;
  }

  get pinned(): SkyOverride | null {
    return this.override;
  }

  /**
   * Pin the sky to an hour of the local day.
   *
   * The override moves the *instant*, not just the number the clock prints.
   * That distinction is the whole implementation: setting the hour and then
   * asking for the sun's altitude at the real instant gives a sun that does not
   * move, which is precisely the bug this shipped with — a "midnight" that was
   * as bright as noon because the astronomy had never been told the time had
   * changed. Advancing the Julian day by the difference between the pinned hour
   * and the current one moves the Earth as well as the clock, so the sidereal
   * rotation and the sun's declination follow.
   */
  setOverride(override: SkyOverride | null, request: SkyRequest = { hour: 0 }, date = new Date()): SkyState {
    this.override = override;
    const when = request.date ?? date;
    const clock = readClock(when, this.location);
    if (!override) {
      this.state = computeSkyState(clock);
      this.lastMinute = when.getMinutes();
      return this.state;
    }
    const hour = ((override.hour % 24) + 24) % 24;
    this.state = computeSkyState(
      { ...clock, jd: clock.jd + (hour - clock.localHours) / 24, localHours: hour },
      { overridden: true, label: override.label ?? formatClock(hour) },
    );
    return this.state;
  }

  /** Re-read the clock. Returns a new state only when the minute has turned. */
  poll(date = new Date()): SkyState | null {
    if (this.override) return null;
    if (date.getMinutes() === this.lastMinute) return null;
    this.lastMinute = date.getMinutes();
    this.state = computeSkyState(readClock(date, this.location));
    return this.state;
  }

  /** Force a recomputation whatever the minute says. */
  refresh(date = new Date()): SkyState {
    if (this.override) {
      return this.setOverride(this.override, { hour: this.override.hour, date });
    }
    this.state = computeSkyState(readClock(date, this.location));
    this.lastMinute = date.getMinutes();
    return this.state;
  }
}
