import type { Map as MlMap } from 'maplibre-gl';

/**
 * 地政總署 3D 視覺化地圖（Tile-based models，OGC 3D Tiles）。
 * deck.gl + loaders.gl 加埋約 1 MB+，所以只喺用戶開立體圖、而且有設定 tileset URL 時先 lazy import。
 * 回傳 cleanup function。
 */
export async function addLandsD3DTiles(map: MlMap, url: string, onError: (e: unknown) => void): Promise<() => void> {
  const [{ MapboxOverlay }, { Tile3DLayer }, { Tiles3DLoader }] = await Promise.all([
    import('@deck.gl/mapbox'),
    import('@deck.gl/geo-layers'),
    import('@loaders.gl/3d-tiles'),
  ]);
  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: [
      new Tile3DLayer({
        id: 'landsd-3dtiles',
        data: url,
        loader: Tiles3DLoader,
        // 手機 GPU / 記憶體有限：限制同時載入嘅 tile 數量同屏幕誤差
        loadOptions: { tileset: { maximumMemoryUsage: 128, viewDistanceScale: 0.75 } },
        onTileError: onError,
      }),
    ],
  });
  map.addControl(overlay);
  return () => {
    try { map.removeControl(overlay); } catch { /* map 已經 remove */ }
  };
}
