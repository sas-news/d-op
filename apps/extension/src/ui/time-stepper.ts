// Shared ±0.1 s / ±1 s stepper used by every range edit surface (custom bar,
// add-modal picker, options edit row). One implementation keeps the step size,
// clamping and accessibility labels identical everywhere — a null value
// disables the controls instead of inventing a start position.

export const TIME_STEP_FINE_MS = 100
export const TIME_STEP_COARSE_MS = 1000

export type TimeStepperOptions = {
  /** Field name used in the accessible labels ("開始", "終了", …). */
  readonly label: string
  /** Current value; null means "not set" and disables every button. */
  readonly getValue: () => number | null
  readonly onChange: (nextMs: number) => void
}

export type TimeStepper = {
  readonly element: HTMLSpanElement
  /** Re-evaluate enabled state (call after an external input edit). */
  readonly sync: () => void
}

type StepSpec = {
  readonly delta: number
  readonly text: string
  readonly action: string
}

const STEPS: readonly StepSpec[] = [
  { delta: -TIME_STEP_COARSE_MS, text: "-1", action: "1秒戻す" },
  { delta: -TIME_STEP_FINE_MS, text: "-0.1", action: "0.1秒戻す" },
  { delta: TIME_STEP_FINE_MS, text: "+0.1", action: "0.1秒進める" },
  { delta: TIME_STEP_COARSE_MS, text: "+1", action: "1秒進める" },
]

export function createTimeStepper(doc: Document, options: TimeStepperOptions): TimeStepper {
  const group = doc.createElement("span")
  group.className = "d-op-time-stepper"
  group.setAttribute("role", "group")
  group.setAttribute("aria-label", `${options.label}の微調整`)

  const buttons: { readonly button: HTMLButtonElement; readonly delta: number }[] = []

  for (const step of STEPS) {
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "d-op-time-step"
    button.textContent = step.text
    button.title = `${options.label}を${step.action}`
    button.setAttribute("aria-label", `${options.label}を${step.action}`)
    button.addEventListener("click", () => {
      const current = options.getValue()
      if (current === null) return
      const next = Math.max(0, current + step.delta)
      options.onChange(next)
      sync()
    })
    buttons.push({ button, delta: step.delta })
    group.appendChild(button)
  }

  function sync(): void {
    const current = options.getValue()
    for (const { button, delta } of buttons) {
      button.disabled = current === null || (delta < 0 && current + delta < 0)
    }
  }

  sync()
  return { element: group, sync }
}
