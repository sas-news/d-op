import type { PageCommand } from "../../../../packages/shared/src/index"
import { PAGE_MESSAGE_SOURCE } from "../../../../packages/shared/src/index"
import { PAGE_ENVELOPE_VERSION } from "./bridge"

export function sendPageCommand(command: PageCommand, pageWindow: Window = window): void {
  pageWindow.postMessage(
    {
      source: PAGE_MESSAGE_SOURCE,
      version: PAGE_ENVELOPE_VERSION,
      type: "COMMAND",
      payload: command,
    },
    pageWindow.location.origin,
  )
}
