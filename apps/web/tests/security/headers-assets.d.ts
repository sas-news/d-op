// Type surface for the `?raw` import of public/_headers used by the header
// parity test (same pattern as src/server/repositories/sql-raw.d.ts).
declare module "*_headers?raw" {
  const content: string
  // biome-ignore lint/style/noDefaultExport: `?raw` imports are default exports by Vite convention.
  export default content
}
