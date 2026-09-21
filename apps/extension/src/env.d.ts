// WXT's generated ImportMetaEnv (see .wxt/types/globals.d.ts) omits Vite's
// built-in env keys. The share import code uses MODE to keep localhost dev
// origins out of release bundles — statically replaced at build time.
interface ImportMetaEnv {
  readonly MODE: string
  readonly DEV: boolean
  readonly PROD: boolean
}
