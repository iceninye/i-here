import { afterEach, describe, expect, it, vi } from 'vitest';
import { wgs84ToHK80Local } from './hk80';
import alsDAccess from './__fixtures__/als-kam-sheung-road-d-access.json';
import alsGrandMayfair from './__fixtures__/als-grand-mayfair.json';
import identifyPodium from './__fixtures__/identify-grand-mayfair-podium.json';
import alsStreet from './__fixtures__/als-street-query.json';
import alsAAccess from './__fixtures__/als-kam-sheung-road-a-access.json';
import identifyAAccess from './__fixtures__/identify-kam-sheung-road-a-access.json';
import identifyGrandMayfair from './__fixtures__/identify-grand-mayfair.json';
import nearbyExitD from './__fixtures__/searchnearby-kam-sheung-road-exit-d.json';
import identifyKamSheung from './__fixtures__/identify-kam-sheung-road.json';
import identifyTinFuk from './__fixtures__/identify-tin-fuk-road.json';
import identifyTinShuiWai from './__fixtures__/identify-tin-shui-wai-station.json';
import identifyWangTat from './__fixtures__/identify-wang-tat-road.json';
import nominatimKamSheung from './__fixtures__/nominatim-kam-sheung-road.json';
import {
  classifyName, formatAlsChinese, isTitleEligible, parseIdentify, parseNearby, parseNominatim,
  pickAlsAddress, pickLandmarks, pickTitle, reverseGeocode, type PlaceCandidate,
} from './reverseGeocode';

/** 實測位置：錦上路站 A 出口（±3 m；官方坐標轉換 API 回 hkE 824534.201 / hkN 832883.635） */
const exitA = { x: 824534.201, y: 832883.635, lat: 22.4353086, lng: 114.0628922 };
/**
 * 實測：錦上路站 D 出口。手機第一次查地址用嘅係最初嗰個粗略 fix（±23.8 m，22.4342849, 114.0635424
 * → HK80 824601, 832770），離你真實位置約 26 m；之後先收窄到 ±2 m（22.434139, 114.063738）。
 * exitD = 粗略 fix 嘅位置（當時查地址用嘅點）；exitDSettled = 收窄後嘅真實位置。
 */
const exitD = { x: 824601.1, y: 832770.2, lat: 22.4342849, lng: 114.0635424 };
const exitDSettled = { ...wgs84ToHK80Local(22.434139, 114.063738), lat: 22.434139, lng: 114.063738 };
/** 實測位置：天水圍站（手機 debug 面板錄到） */
const tsw = { x: 818477.0, y: 834242.6, lat: 22.447608, lng: 114.003996 };
/** 實測位置：錦上路站附近（手機 debug 面板錄到） */
const kam = { x: 824647.8, y: 832746.0, lat: 22.434066, lng: 114.063997 };
const origin = { x: 816500, y: 825700, lat: 22.40801, lng: 113.97312 };
const c = (name: string, distanceM: number, kind?: PlaceCandidate['kind']): PlaceCandidate =>
  ({ name, distanceM, kind: kind ?? classifyName(name) });

describe('parseIdentify (real captured response)', () => {
  it('reads the building from results[].addressInfo[] and ignores the nested facilities', () => {
    const list = parseIdentify(identifyKamSheung, kam);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('錦上路站');
    expect(list[0].kind).toBe('transport');
    expect(list[0].distanceM).toBeCloseTo(Math.hypot(824588 - kam.x, 832830 - kam.y), 1);
    expect(list[0].distanceM).toBeGreaterThan(100); // ~103 m：「附近」而唔係「就喺度」
  });
  it('falls back to the English name, and survives garbage', () => {
    const j = { results: [{ addressInfo: [{ ename: 'Hing Yiu House', addressType: 'B', x: 816510, y: 825705 }] }] };
    expect(parseIdentify(j, origin)[0]).toMatchObject({ name: 'Hing Yiu House', kind: 'building' });
    expect(parseIdentify({}, origin)).toEqual([]);
    expect(parseIdentify(null, origin)).toEqual([]);
    expect(parseIdentify({ results: [{ addressInfo: [null, 5, { cname: null }] }] }, origin)).toEqual([]);
  });
  it('does not pick up status-like fields as names (nameStatus used to be matched)', () => {
    const j = { results: [{ addressInfo: [{ cname: null, ename: null, nameStatus: 'ACTIVE', x: 816500, y: 825700 }] }] };
    expect(parseIdentify(j, origin)).toEqual([]);
  });
});

describe('parseIdentify: streets have no coordinates (real captures, Tin Shui Wai)', () => {
  it('treats a street without x/y as being at the query point', () => {
    const list = parseIdentify(identifyTinFuk, tsw);
    expect(list).toEqual([{ name: '天福路', address: undefined, distanceM: 0, kind: 'street' }]);
    expect(pickTitle(list)?.name).toBe('天福路');
  });
  it('reads every street at a junction, in order', () => {
    const list = parseIdentify(identifyWangTat, tsw);
    expect(list.map(c => c.name)).toEqual(['宏達路', '媽橫路']);
    expect(pickTitle(list)?.name).toBe('宏達路');
  });
  it('a building ~100 m away still beats the street you are on', () => {
    const list = [...parseIdentify(identifyTinShuiWai, tsw), ...parseIdentify(identifyTinFuk, tsw)];
    const station = list.find(c => c.name === '天水圍站')!;
    expect(station.kind).toBe('transport');
    expect(Math.round(station.distanceM)).toBe(110);
    expect(pickTitle(list)?.name).toBe('天水圍站');
  });
  it('but a street beats a building that is too far to be "where you are"', () => {
    const list = [c('某某大廈', 280, 'building'), ...parseIdentify(identifyTinFuk, tsw)];
    expect(pickTitle(list)?.name).toBe('天福路');
  });
});

describe('title ranking and blacklist', () => {
  it('never uses WiFi hotspots, post boxes, kerb parking, car parks, AED, toilets as the title', () => {
    for (const n of ['WiFi.HK 熱點', '郵箱 PB1234', '路旁泊車位', '錦田公眾停車場', '自動心臟除顫器 - 錦上路站', '公廁', '免費Wi-Fi']) {
      expect(isTitleEligible(n), n).toBe(false);
    }
    expect(isTitleEligible('興輝樓')).toBe(true);
  });

  it('returns no title when only junk is nearby (UI then shows coordinates only)', () => {
    expect(pickTitle([c('WiFi.HK 熱點', 3), c('郵箱 PB1', 5), c('路旁泊車位', 8), c('公眾停車場', 12)])).toBeUndefined();
  });

  it('prefers the building you are in over a nearby shop, but a very close shop beats a far building', () => {
    expect(pickTitle([c('某某餐廳', 10, 'shop'), c('興輝樓', 40, 'building')])?.name).toBe('興輝樓');
    expect(pickTitle([c('某某餐廳', 5, 'shop'), c('興輝樓', 60, 'building')])?.name).toBe('某某餐廳');
  });

  it('applies per-kind distance caps (a shop 80 m away is not "where you are")', () => {
    expect(pickTitle([c('某某餐廳', 80, 'shop')])).toBeUndefined();
    expect(pickTitle([c('興輝樓', 200, 'building')])?.name).toBe('興輝樓');
    expect(pickTitle([c('興輝樓', 400, 'building')])).toBeUndefined();
  });

  it('falls back to a street only when nothing better exists', () => {
    expect(pickTitle([c('青田路', 20, 'street'), c('錦上路站', 100, 'transport')])?.name).toBe('錦上路站');
    expect(pickTitle([c('青田路', 20, 'street')])?.name).toBe('青田路');
  });

  it('landmarks skip the title and junk, and are limited to 3 within 300 m', () => {
    const title = c('興輝樓', 10, 'building');
    const l = pickLandmarks([title, c('WiFi.HK 熱點', 5), c('A樓', 50), c('B苑', 90), c('C中心', 120), c('D閣', 200), c('遠處', 900)], title);
    expect(l.map(x => x.name)).toEqual(['A樓', 'B苑', 'C中心']);
  });
});

describe('parseNearby', () => {
  // 注意：searchNearby 未有真實完整 fixture；呢個係按「陣列 + cname/caddress/x/y」嘅合理形狀造嘅合成資料，
  // 一旦用 ?debug=1 錄到真實回應就要換成真 fixture。
  it('reads an array and a results-wrapped array, with explicit keys only', () => {
    const items = [{ cname: '錦上路站', caddress: '錦上路', x: 824588, y: 832830 }, { nameStatus: 'x', x: 824600, y: 832700 }];
    expect(parseNearby(items, kam).map(v => v.name)).toEqual(['錦上路站']);
    expect(parseNearby({ results: items }, kam)).toHaveLength(1);
    expect(parseNearby('oops', kam)).toEqual([]);
  });
  it('with a 1000-item junk-heavy list, still picks the real place', () => {
    const junk = Array.from({ length: 900 }, (_, i) => ({ cname: `WiFi.HK 熱點 ${i}`, x: 824648 + (i % 30), y: 832746 + (i % 20) }));
    const list = parseNearby([...junk, { cname: '路旁泊車位', x: 824650, y: 832750 }, { cname: '錦田南花園', x: 824700, y: 832760 }], kam);
    expect(pickTitle(list)?.name).toBe('錦田南花園');
  });
});

describe('Kam Sheung Road station exit D (real captures, ±2 m fix)', () => {
  it('classifies station exits, estates (addressType S) and shops', () => {
    expect(classifyName('港鐵錦上路站-D進出口')).toBe('transport');
    expect(classifyName('柏瓏', 'S')).toBe('estate');
    expect(classifyName('7-11便利店-元朗')).toBe('shop');
    expect(classifyName('天福路', 'ST')).toBe('street');
    expect(classifyName('興輝樓', 'B')).toBe('building');
    expect(classifyName('興輝樓')).toBe('building');
    expect(classifyName('大興邨', 'B')).toBe('estate');
    expect(classifyName('大埔道公園')).toBe('estate');
  });

  it('treats lifts and escalators as junk (they showed up as "附近還有：升降機")', () => {
    for (const n of ['升降機', '扶手電梯', '樓梯', '通道']) {
      expect(isTitleEligible(n), n).toBe(false);
    }
    expect(pickLandmarks([c('興輝樓', 0, 'building'), c('升降機', 70), c('OK便利店', 45, 'shop')], c('興輝樓', 0, 'building'))
      .map(x => x.name)).toEqual(['OK便利店']);
  });

  it('parseNearby drops the street-named parking records and street-kind items, keeps exits and shops', () => {
    const names = parseNearby(nearbyExitD, exitD).map(c => c.name);
    expect(names).not.toContain('東匯路');
    expect(names).not.toContain('錦上路');
    expect(names).toContain('港鐵錦上路站-D進出口');
    expect(names).toContain('7-11便利店-元朗');
    expect(names).toContain('惠康超級市場-錦田');
  });

  it('identify alone would say 柏瓏 (79 m); with searchNearby the title is the exit you stand at (23 m)', () => {
    const identified = parseIdentify(identifyGrandMayfair, exitD);
    expect(identified).toHaveLength(1); // the LOT result and nested facilities are ignored
    expect(identified[0]).toMatchObject({ name: '柏瓏', kind: 'estate', address: '錦河路29號' });
    expect(Math.round(identified[0].distanceM)).toBe(79);
    const all = [...identified, ...parseNearby(nearbyExitD, exitD)];
    const title = pickTitle(all)!;
    expect(title.name).toBe('港鐵錦上路站-D進出口');
    expect(Math.round(title.distanceM)).toBe(23);
    expect(pickLandmarks(all, title).map(l => l.name)).toEqual(['港鐵錦上路站-C進出口', '7-11便利店-元朗', '柏瓏']);
  });

  it('at the settled position the exit is 「就喺度」 (about 5 m), the stale coarse point said 23 m', () => {
    const all = [...parseIdentify(identifyGrandMayfair, exitDSettled), ...parseNearby(nearbyExitD, exitDSettled)];
    const title = pickTitle(all)!;
    expect(title.name).toBe('港鐵錦上路站-D進出口');
    expect(Math.round(title.distanceM)).toBeLessThan(10);
    expect(pickLandmarks(all, title).map(l => l.name)[0]).toBe('港鐵錦上路站-C進出口');
  });

  it('end to end: first 柏瓏 (identify), then the exit (searchNearby), no junk, address from identify', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/identify')) return new Response(JSON.stringify(identifyGrandMayfair));
      if (url.includes('/searchNearby')) return new Response(JSON.stringify(nearbyExitD));
      if (url.includes('als.gov.hk')) return new Response(JSON.stringify(alsGrandMayfair)); // English only, as captured
      throw new TypeError('Failed to fetch');
    }));
    const partials: string[] = [];
    const r = await reverseGeocode({ x: exitD.x, y: exitD.y, source: 'local' }, exitD, undefined, pl => partials.push(pl.name));
    expect(partials).toEqual(['柏瓏', '港鐵錦上路站-D進出口']);
    expect([r?.name, r?.kind, r?.proximity]).toEqual(['港鐵錦上路站-D進出口', 'transport', 'at']);
    expect(r?.address).toBe('新界元朗錦田香港鐵路錦上路站'); // searchNearby 嘅 address
  });

  it('asks ALS for Chinese via Accept-Language, and uses a Chinese address when it comes back', async () => {
    const chi = {
      SuggestedAddress: [{ Address: { PremisesAddress: {
        ChiPremisesAddress: { Region: '新界', ChiDistrict: { DcDistrict: '元朗區' }, ChiStreet: { StreetName: '錦河路', BuildingNoFrom: '29' }, ChiEstate: { EstateName: '柏瓏' } },
        GeospatialInformation: { Northing: '832769', Easting: '824521' } } } }],
    };
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/identify')) return new Response(JSON.stringify(identifyGrandMayfair));
      if (url.includes('als.gov.hk')) return new Response(JSON.stringify(chi));
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchFn);
    const r = await reverseGeocode({ x: exitD.x, y: exitD.y, source: 'local' }, exitD);
    expect(r?.address).toBe('新界元朗區錦河路29號柏瓏');
    const alsCall = fetchFn.mock.calls.find(c => String(c[0]).includes('als.gov.hk'))!;
    expect((alsCall[1]?.headers as Record<string, string>)['Accept-Language']).toBe('en,zh-Hant');
  });
});

describe('Kam Sheung Road station exit A (real captures, ±3 m fix)', () => {
  it('identify answers with the exit itself (type FACI / addressType F), 10 m away', () => {
    const list = parseIdentify(identifyAAccess, exitA);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '港鐵錦上路站-A進出口', kind: 'transport', address: '新界元朗錦田香港鐵路錦上路站', x: 824533, y: 832894 });
    expect(Math.round(list[0].distanceM)).toBe(10);
    const title = pickTitle(list)!;
    expect(title.name).toBe('港鐵錦上路站-A進出口');
  });

  it('searchNearby (exit A capture) agrees: the exit itself is the closest eligible place', () => {
    const all = [...parseIdentify(identifyAAccess, exitA), ...parseNearby(nearbyExitD, exitA)];
    expect(pickTitle(all)?.name).toBe('港鐵錦上路站-A進出口');
  });

  // ALS 嘅第一個結果係 165 m 外嘅「MTR KAM TIN BUILDING」（真實回應）。原回應只有英文，
  // 所以呢度用真實回應嘅座標，加一個合成嘅中文地址區塊，只係為咗測試「距離核對」。
  const withChinese = {
    SuggestedAddress: [
      { ...alsAAccess.SuggestedAddress[0], Address: { PremisesAddress: {
        ...alsAAccess.SuggestedAddress[0].Address.PremisesAddress,
        ChiPremisesAddress: { Region: '新界', ChiDistrict: { DcDistrict: '元朗區' }, ChiStreet: { StreetName: '錦河路', BuildingNoFrom: '23' }, BuildingName: '港鐵錦田大廈' },
      } } },
    ],
  };

  it('the ALS match is 165 m from the exit: rejected against the place, but the old check (250 m from you) accepted it', () => {
    expect(pickAlsAddress(withChinese, { x: exitA.x, y: exitA.y }, 250)).toBe('新界元朗區錦河路23號港鐵錦田大廈'); // 以前會當成呢個出口嘅地址
    expect(pickAlsAddress(withChinese, { x: 824533, y: 832894 }, 60)).toBeUndefined();
  });

  it('end to end: the exit keeps identify’s own address instead of the wrong building', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/identify')) return new Response(JSON.stringify(identifyAAccess));
      if (url.includes('als.gov.hk')) return new Response(JSON.stringify(withChinese));
      throw new TypeError('Failed to fetch');
    }));
    const r = await reverseGeocode({ x: exitA.x, y: exitA.y, source: 'landsd-api' }, exitA);
    expect([r?.name, r?.address]).toEqual(['港鐵錦上路站-A進出口', '新界元朗錦田香港鐵路錦上路站']);
  });
});

describe('ALS with Accept-Language: real Chinese response (exit D capture, build d24be73)', () => {
  it('formats the real Chinese address blocks (street + building, and street + estate + block)', () => {
    const [mtr, placid] = alsDAccess.SuggestedAddress.map(a => a.Address.PremisesAddress.ChiPremisesAddress);
    expect(formatAlsChinese(mtr)).toBe('新界元朗區錦河路23號港鐵錦田大樓');
    expect(formatAlsChinese(placid)).toBe('新界元朗區錦上路9號芊逸居1座');
  });
  it('picks the block next to the place (0 m / 27 m) and rejects the same query from 300 m away', () => {
    expect(pickAlsAddress(alsDAccess, { x: 824613, y: 833255 }, 60)).toBe('新界元朗區錦上路9號芊逸居1座');
    expect(pickAlsAddress(alsDAccess, { x: 824620, y: 832757 }, 60)).toBeUndefined(); // D 出口：最近嘅 ALS 結果係 300 m 外
  });
  it('the exit D title keeps the address from searchNearby, because no ALS match is near the exit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/identify')) return new Response(JSON.stringify(identifyKamSheung));
      if (url.includes('/searchNearby')) return new Response(JSON.stringify(nearbyExitD));
      if (url.includes('als.gov.hk')) return new Response(JSON.stringify(alsDAccess));
      throw new TypeError('Failed to fetch');
    }));
    const r = await reverseGeocode({ x: 824620.691, y: 832756.056, source: 'landsd-api' }, { lat: 22.4341571, lng: 114.0637333 });
    expect([r?.name, r?.source, r?.address]).toEqual(['港鐵錦上路站-D進出口', 'nearby', '新界元朗錦田香港鐵路錦上路站']);
  });
});

describe('identify addressType P (real capture at the coarse first fix of exit D)', () => {
  const coarse = { x: 824603.84, y: 832744.298, lat: 22.4340508, lng: 114.0635697 };
  it('treats a podium as an estate', () => {
    expect(classifyName('柏瓏', 'P')).toBe('estate');
    const [c] = parseIdentify(identifyPodium, coarse);
    expect(c).toMatchObject({ name: '柏瓏', kind: 'estate', address: '錦河路29號', x: 824521, y: 832769 });
    expect(Math.round(c.distanceM)).toBe(86);
  });
  it('even at the coarse fix (±16 m, ~21 m off) the exit (21 m) already beats the estate (86 m)', () => {
    const all = [...parseIdentify(identifyPodium, coarse), ...parseNearby(nearbyExitD, coarse)];
    const title = pickTitle(all)!;
    expect(title.name).toBe('港鐵錦上路站-D進出口');
    expect(Math.round(title.distanceM)).toBe(21);
  });
});

describe('ALS (real capture)', () => {
  it('ignores suggestions far from you, and ones without a Chinese address block', () => {
    expect(pickAlsAddress(alsStreet, { x: tsw.x, y: tsw.y })).toBeUndefined();
    // 就算近，只有英文地址都唔會出錯
    expect(pickAlsAddress(alsStreet, { x: 836410, y: 827547 })).toBeUndefined();
  });
});

describe('ALS', () => {
  const chi = {
    Region: '新界', ChiDistrict: { DcDistrict: '屯門區' }, ChiStreet: { StreetName: '大興街', BuildingNoFrom: '1' },
    ChiEstate: { EstateName: '大興邨' }, BuildingName: '興輝樓',
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

describe('parseNominatim (real captured response)', () => {
  it('still parses, but shows why OSM is off by default: it named a subway-entrance node', () => {
    const r = parseNominatim(nominatimKamSheung, kam);
    expect(r?.name).toBe('錦莆路');
    expect(Math.round(r?.distanceM ?? 0)).toBe(27); // 節點離你 ~27 m，而且係出入口，唔係你所在嘅地方
  });
  it('rejects error bodies', () => {
    expect(parseNominatim({ error: 'Unable to geocode' }, origin)).toBeNull();
  });
});

describe('reverseGeocode', () => {
  afterEach(() => vi.unstubAllGlobals());
  const p80 = { x: kam.x, y: kam.y, source: 'local' as const };
  const stub = (handler: (url: string) => Promise<Response> | Response) => {
    const fn = vi.fn(async (url: string) => handler(url));
    vi.stubGlobal('fetch', fn);
    return fn;
  };
  const json = (v: unknown) => new Response(JSON.stringify(v));

  it('uses the real identify capture: 「錦上路站」 as a nearby (not at) place, and reports it before ALS finishes', async () => {
    let releaseAls!: () => void;
    const gate = new Promise<void>(r => { releaseAls = r; });
    const fetchFn = stub(async url => {
      if (url.includes('www.map.gov.hk/gs/api/v1.0.0/identify')) return json(identifyKamSheung);
      if (url.includes('als.gov.hk')) { await gate; return json({ SuggestedAddress: [] }); }
      throw new TypeError('Failed to fetch');
    });
    const partials: string[] = [];
    const done = reverseGeocode(p80, kam, undefined, pl => partials.push(`${pl.name}|${pl.proximity}`));
    await vi.waitFor(() => expect(partials).toEqual(['錦上路站|near']));
    releaseAls();
    const r = await done;
    expect([r?.name, r?.kind, r?.source]).toEqual(['錦上路站', 'transport', 'identify']);
    expect(fetchFn.mock.calls.map(c => c[0] as string).some(u => u.includes('geodata.gov.hk/gs/api'))).toBe(false);
  });

  it('on a street: titles it 「天福路」 at the point, and does not waste an ALS call on a street name', async () => {
    const fetchFn = stub(url => {
      if (url.includes('/identify')) return json(identifyTinFuk);
      throw new TypeError('Failed to fetch');
    });
    const r = await reverseGeocode({ x: tsw.x, y: tsw.y, source: 'local' }, tsw);
    expect([r?.name, r?.kind, r?.proximity]).toEqual(['天福路', 'street', 'at']);
    expect(fetchFn.mock.calls.map(c => String(c[0])).some(u => u.includes('als.gov.hk'))).toBe(false);
  });

  it('at a junction, the second street becomes a landmark without a distance', async () => {
    stub(url => {
      if (url.includes('/identify')) return json(identifyWangTat);
      throw new TypeError('Failed to fetch');
    });
    const r = await reverseGeocode({ x: tsw.x, y: tsw.y, source: 'local' }, tsw);
    expect([r?.name, r?.landmarks.map(l => l.name)]).toEqual(['宏達路', ['媽橫路']]);
  });

  it('never calls OpenStreetMap by default, and returns null (coordinates only) when government APIs fail', async () => {
    const fetchFn = stub(() => { throw new TypeError('Failed to fetch'); });
    expect(await reverseGeocode(p80, kam)).toBeNull();
    expect(fetchFn.mock.calls.some(c => String(c[0]).includes('nominatim'))).toBe(false);
  });

  it('falls back to searchNearby when identify has nothing usable, ignoring junk', async () => {
    stub(url => {
      if (url.includes('/identify')) return json({ results: [] });
      if (url.includes('/searchNearby')) return json([{ cname: 'WiFi.HK 熱點', x: 824648, y: 832746 }, { cname: '錦田南花園', x: 824660, y: 832750 }]);
      throw new TypeError('Failed to fetch');
    });
    const r = await reverseGeocode(p80, kam);
    expect([r?.name, r?.source, r?.proximity]).toEqual(['錦田南花園', 'nearby', 'at']);
  });

  it('a clearly closer place from searchNearby replaces the identify title (and is reported as a second partial)', async () => {
    stub(url => {
      if (url.includes('/identify')) return json(identifyKamSheung);
      if (url.includes('/searchNearby')) return json([{ cname: '大埔道公園', x: 824600, y: 832700 }, { cname: '郵箱 PB9', x: 824648, y: 832746 }]);
      throw new TypeError('Failed to fetch');
    });
    const partials: string[] = [];
    const r = await reverseGeocode(p80, kam, undefined, pl => partials.push(`${pl.name}|${pl.source}`));
    expect(partials).toEqual(['錦上路站|identify', '大埔道公園|nearby']);
    expect([r?.name, r?.source]).toEqual(['大埔道公園', 'nearby']);
    expect(r?.landmarks.map(l => l.name)).toEqual(['錦上路站']);
  });
});
