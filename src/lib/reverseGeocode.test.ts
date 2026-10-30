import { describe, expect, it } from 'vitest';
import { extractCandidates, formatAlsChinese, pickAlsAddress } from './reverseGeocode';

const origin = { x: 816500, y: 825700 };

describe('extractCandidates', () => {
  it('finds nested named points and sorts by distance', () => {
    const json = {
      results: [
        { layer: 'building', addressInfo: [{ nameZH: '興輝樓', addressZH: '屯門大興邨', x: 816510, y: 825705 }] },
        { layer: 'facility', addressInfo: [{ cname: '大興體育館', x: '816600', y: '825750' }] },
        { addressInfo: [{ nameZH: '興輝樓', x: 816510, y: 825705 }] }, // duplicate
        { addressInfo: [{ nameZH: '無座標' }] },
      ],
    };
    const c = extractCandidates(json, origin);
    expect(c.map(v => v.name)).toEqual(['興輝樓', '大興體育館']);
    expect(c[0].address).toBe('屯門大興邨');
    expect(c[0].distanceM).toBeCloseTo(Math.hypot(10, 5));
  });
  it('handles a plain array response and empty input', () => {
    expect(extractCandidates([{ nameZH: 'A', x: 816500, y: 825700 }], origin)[0].distanceM).toBe(0);
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
