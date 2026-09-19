import { defineContentScript } from "wxt/utils/define-content-script"
import { injectScript } from "#imports"
import { installIsolatedBridge } from "../src/adapter/isolated-runtime"

export default defineContentScript({
  matches: [
    "https://animestore.docomo.ne.jp/animestore/sc_d_pc*",
    "https://anime.dmkt-sp.jp/animestore/sc_d_pc*",
  ],
  runAt: "document_start",
  async main() {
    await installIsolatedBridge(window, async () => {
      await injectScript("/danime-main.js", { keepInDom: true })
    })
  },
})
