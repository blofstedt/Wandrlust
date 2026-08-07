/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly MODE: string;
  readonly VITE_MAPBOX_TOKEN?: string;
  readonly VITE_CROWN_LAND_TILESET?: string;
  readonly VITE_CROWN_LAND_LAYER?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_ROUTING_PROVIDER?: string;
  readonly VITE_ORS_API_KEY?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}