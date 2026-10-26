/// <reference types="vite/client" />

// The only env value the web reads (spec web-shell, rules 7 and 20). Non-secret: it ships in the bundle.
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
