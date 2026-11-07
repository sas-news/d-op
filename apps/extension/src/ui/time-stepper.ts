// Shared compact range nudger used by every edit surface (custom bar, add
// modal, options edit row). The buttons always move 0.1 s: coarse adjustment
// is the text input's job, and detected ranges already start at a sane value.

export const TIME_STEP_FINE_MS = 100

export type TimeStepperOptions = {
  /** Field name used in the accessible labels ("開始", "終了", …). */
  readonly label: string
  /** Current value; null means "not set" and disables both buttons. */
  readonly getValue: () => number | null
  readonly onChange: (nextMs: number) => void
}

export type TimeStepper = {
  readonly element: HTMLSpanElement
  /** Re-evaluate enabled state (call after an external input edit). */
  readonly sync: () => void
}

export function createTimeStepper(doc: Document, options: TimeStepperOptions): TimeStepper {
  const group = doc.createElement("span")
  group.className = "d-op-time-stepper"
  group.setAttribute("role", "group")
  group.setAttribute("aria-label", `${options.label}の微調整（0.1秒刻み）`)

  const makeButton = (direction: -1 | 1): HTMLButtonElement => {
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "d-op-time-step"
    button.textContent = direction < 0 ? "−" : "+"
    const action = direction < 0 ? "戻す" : "進める"
    button.title = `${options.label}を0.1秒${action}`
    button.setAttribute("aria-label", `${options.label}を0.1秒${action}`)
    button.addEventListener("click", () => {
      const current = options.getValue()
      if (current === null) return
      options.onChange(Math.max(0, current + direction * TIME_STEP_FINE_MS))
      sync()
    })
    return button
  }

  const minus = makeButton(-1)
  const plus = makeButton(1)
  group.append(minus, plus)

  function sync(): void {
    const current = options.getValue()
    minus.disabled = current === null || current < TIME_STEP_FINE_MS
    plus.disabled = current === null
  }

  sync()
  return { element: group, sync }
}
