// wrangler bundles *.wasm imports as CompiledWasm modules — the imported value
// is a WebAssembly.Module inside workerd. Declared ambiently for tsc; the
// OGP renderer (src/pages/p/[shareId]/og.png.ts) uses it for resvg.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module
  // biome-ignore lint/style/noDefaultExport: the bundler's wasm contract is a default export.
  export default wasmModule
}
