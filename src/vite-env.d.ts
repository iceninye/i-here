/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_PROXY?: string;
  readonly VITE_LANDSD_3DTILES_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
