import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractCandidates, formatAlsChinese, parseNominatim, pickAlsAddress, reverseGeocode } from './reverseGeocode';

const origin = { x: 816500, y: 825700, lat: 22.40801, lng: 113.97312 };

describe('extractCandidates', () => {
  it('finds nested named points and sorts by distance', () => {
    const json = {
      results: [
        { layer: 'building', addressInfo: [{ nameZH: '興輝樓', addressZH: '屯門大興邨', x: 816510, y: 825705 }] },
        { layer: 'facility', addressInfo: [{ cname: '大興體育館', x: '816600', y: '825750' }] },
        { addressInfo: [{ nameZH: '興輝樓', x: 816510, y: 825705 }] }, // duplicate
      ],
    };
    const c = extractCandidates(json, origin);
    expect(c.map(v => v.name)).toEqual(['興輝樓', '大興體育館']);
    expect(c[0].address).toBe('屯門大興邨');
    expect(c[0].distanceM).toBeCloseTo(Math.hypot(10, 5));
  });
  it('keeps names without coordinates (identify may omit them), after the located ones', () => {
    const c = extractCandidates([{ nameZH: '無座標' }, { nameZH: '有座標', x: 816500, y: 825700 }], origin);
    expect(c.map(v => v.name)).toEqual(['有座標', '無座標']);
    expect(Number.isNaN(c[1].distanceM)).toBe(true);
  });
  it('accepts unknown name keys, prefers Chinese, ignores layer names and lat/lng coordinates', () => {
    const c = extractCandidates(
      { features: [{ layerName: 'BUILDING', buildingNameEN: 'Hing Yiu House', buildingNameTC: '興耀樓', lat: 22.40801, long: 113.97312 }] },
      origin,
    );
    expect(c).toHaveLength(1);
    expect(c[0].name).toBe('興耀樓');
    expect(c[0].distanceM).toBeCloseTo(0);
  });
  it('handles empty input', () => {
    expect(extractCandidates({}, origin)).toEqual([]);
    expect(extractCandidates(null, origin)).toEqual([]);
  });
});

describe('ALS', () => {
  const chi = {
    Region: '新界',
    ChiDistrict: { DcDistrict: '屯門區' },
    ChiStreet: { StreetName: '大興街', BuildingNoFrom: '1' },
    ChiEstate: { EstateName: '大興邨' },
    BuildingName: '興輝樓',
  };
  it('formats Chinese address in local order', () => {
    expect(formatAlsChinese(chi)).toBe('新界屯門區大興街1號大興邨興輝樓');
  });
  it('picks the nearest suggestion within range, ignoring same-name buildings far away', () => {
    const json = {
      SuggestedAddress: [
        { Address: { PremisesAddress: { ChiPremisesAddress: { ...chi, Region: '九龍' }, GeospatialInformation: { Easting: '836000', Northing: '819000' } } } },
        { Address: { PremisesAddress: { ChiPremisesAddress: chi, GeospatialInformation: { Easting: '816520', Northing: '825690' } } } },
      ],
    };
    expect(pickAlsAddress(json, origin)).toBe('新界屯門區大興街1號大興邨興輝樓');
    expect(pickAlsAddress({ SuggestedAddress: [json.SuggestedAddress[0]] }, origin)).toBeUndefined();
    expect(pickAlsAddress(null, origin)).toBeUndefined();
  });
});

describe('parseNominatim', () => {
  it('uses the building name and builds a big-to-small Chinese address', () => {
    const c = parseNominatim({
      name: '興耀樓', lat: '22.40801', lon: '113.97312',
      address: { building: '興耀樓', road: '興輝街', neighbourhood: '大興邨', suburb: '大興', city_district: '屯門區', state: '新界' },
    }, origin);
    expect(c?.name).toBe('興耀樓');
    expect(c?.address).toBe('新界屯門區大興大興邨興輝街');
    expect(c?.distanceM).toBeCloseTo(0);
  });
  it('falls back to the road when there is no named feature', () => {
    expect(parseNominatim({ address: { road: '屯門公路', house_number: '8' } }, origin)?.name).toBe('屯門公路8號');
    expect(parseNominatim({ error: 'Unable to geocode' }, origin)).toBeNull();
  });
});

describe('reverseGeocode', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (routes: Record<string, unknown>) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(hit[1]), { status: 200 });
    }));
  const p80 = { x: origin.x, y: origin.y, source: 'local' as const };

  it('uses identify from www.map.gov.hk and nearby landmarks', async () => {
    respond({
      'www.map.gov.hk/gs/api/v1.0.0/identify': { results: [{ nameZH: '興耀樓' }] },
      searchNearby: [{ nameZH: '青田花園', x: 816530, y: 825700 }, { nameZH: '興耀樓', x: 816505, y: 825700 }],
    });
    const r = await reverseGeocode(p80, origin);
    expect(r?.name).toBe('興耀樓');
    expect(r?.proximity).toBe('at');
    expect(r?.source).toBe('identify');
    expect(r?.landmarks.map(l => l.name)).toEqual(['青田花園']);
  });

  it('falls back to the geodata.gov.hk mirror, then nearby, then OpenStreetMap', async () => {
    respond({ 'geodata.gov.hk/gs/api/v1.0.0/identify': [{ nameZH: '鏡像結果' }] });
    expect((await reverseGeocode(p80, origin))?.name).toBe('鏡像結果');

    respond({ searchNearby: [{ nameZH: '青田花園', x: 816560, y: 825700 }] });
    const n = await reverseGeocode(p80, origin);
    expect([n?.name, n?.proximity, n?.source]).toEqual(['青田花園', 'near', 'nearby']);

    respond({ 'nominatim.openstreetmap.org': { name: '興耀樓', lat: '22.40801', lon: '113.97312', address: { building: '興耀樓', city_district: '屯門區' } } });
    const o = await reverseGeocode(p80, origin);
    expect([o?.name, o?.source, o?.address]).toEqual(['興耀樓', 'osm', '屯門區']);
  });

  it('returns null only when every source fails', async () => {
    respond({});
    expect(await reverseGeocode(p80, origin)).toBeNull();
  });
});
