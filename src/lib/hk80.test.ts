import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import officialA from './__fixtures__/transform-kam-sheung-road-a.json';
import { parseTransformResponse, wgs84ToHK80Local } from './hk80';

describe('wgs84ToHK80Local', () => {
  it('agrees with the LandsD simplified datum shift within 3 m', () => {
    // 地政總署簡化公式：HK80 緯度 = WGS84 + 5.5″，經度 = WGS84 − 8.8″，再做 HK80 橫軸麥卡托投影
    const lat = 22.322172, lng = 114.141189;
    const tm = '+proj=tmerc +lat_0=22.31213333333334 +lon_0=114.1785555555556 +k=1 +x_0=836694.05 +y_0=819069.8 +ellps=intl +units=m +no_defs';
    const [ex, ey] = proj4('+proj=longlat +ellps=intl +no_defs', tm, [lng - 8.8 / 3600, lat + 5.5 / 3600]);
    const p = wgs84ToHK80Local(lat, lng);
    expect(Math.hypot(p.x - ex, p.y - ey)).toBeLessThan(3);
  });
  it('maps the HK80 origin area near the false origin', () => {
    const p = wgs84ToHK80Local(22.3121333 - 5.5 / 3600, 114.1785556 + 8.8 / 3600);
    expect(Math.hypot(p.x - 836694.05, p.y - 819069.8)).toBeLessThan(5);
  });
});

describe('parseTransformResponse', () => {
  it('reads hkE / hkN', () => {
    expect(parseTransformResponse({ hkE: 836055.4, hkN: 819599.6, hkpd: 0 })).toEqual({ x: 836055.4, y: 819599.6 });
  });
  it('reads string E / N', () => {
    expect(parseTransformResponse({ E: '836055.4', N: '819599.6' })).toEqual({ x: 836055.4, y: 819599.6 });
  });
  it('rejects out-of-range or missing values', () => {
    expect(parseTransformResponse({ hkE: 1, hkN: 2 })).toBeNull();
    expect(parseTransformResponse({ foo: 1 })).toBeNull();
    expect(parseTransformResponse(null)).toBeNull();
  });
});

describe('official transform API (real capture, Kam Sheung Road station exit A)', () => {
  // https://www.geodetic.gov.hk/transform/v2/?inSys=wgsgeog&outSys=hkgrid&lat=22.4353086&long=114.0628922 → 200, 312 ms
  it('parses the real response ({ hkN, hkE })', () => {
    expect(parseTransformResponse(officialA)).toEqual({ x: 824534.201, y: 832883.635 });
  });
  it('the local proj4 conversion agrees with it to well under 10 cm at this point', () => {
    const local = wgs84ToHK80Local(22.4353086, 114.0628922);
    expect(Math.hypot(local.x - 824534.201, local.y - 832883.635)).toBeLessThan(0.1);
  });
});

describe('local conversion vs three real official results (exit A, exit D settled, exit D coarse)', () => {
  const points: [string, number, number, number, number][] = [
    ['exit A', 22.4353086, 114.0628922, 824534.201, 832883.635],
    ['exit D settled', 22.4341571, 114.0637333, 824620.691, 832756.056],
    ['exit D coarse', 22.4340508, 114.0635697, 824603.84, 832744.298],
  ];
  it.each(points)('%s: within 1 cm', (_name, lat, lng, e, n) => {
    const l = wgs84ToHK80Local(lat, lng);
    expect(Math.hypot(l.x - e, l.y - n)).toBeLessThan(0.01);
  });
});
