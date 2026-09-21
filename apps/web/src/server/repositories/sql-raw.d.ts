// Type surface for Vite-style `?raw` imports of ordered SQL migration files.
// Astro's client types only pull vite/types/import-meta, so declare the narrow
// *.sql?raw pattern here instead of widening the whole tsconfig types list.
declare module "*.sql?raw" {
  const content: string
  // biome-ignore lint/style/noDefaultExport: `?raw` imports are default exports by Vite convention.
  export default content
}
