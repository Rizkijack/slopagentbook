/// <reference types="vite/client" />

// The wallet stack is the first thing in this app that reads a build-time
// variable (VITE_REOWN_PROJECT_ID). Declared here so tsc knows the shape
// without pulling `vite/client` into every file.
interface ImportMetaEnv {
  readonly VITE_REOWN_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
