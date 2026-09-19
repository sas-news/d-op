import { defineUnlistedScript } from "wxt/utils/define-unlisted-script"
import { installIsolatedBridge } from "../src/adapter/isolated-runtime"

export default defineUnlistedScript(() => {
  void installIsolatedBridge(window, async () => undefined)
})
