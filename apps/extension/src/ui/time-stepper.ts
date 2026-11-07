// Shared compact range nudger used by every edit surface (custom bar, add
// modal, options edit row). Each edge gets a small −/+ pair; one shared step
// select chooses 0.1 s or 1 s so two edges do not repeat four buttons each.

export const TIME_STEP_FINE_MS = 100
export const TIME_STEP_COARSE_MS = 1000
export type TimeStepMs = typeof TIME_STEP_FINE_MS | typeof TIME_STEP_COARSE_MS

export type TimeStepperOptions = {
  /** Field name used in the accessible labels ("開始", "終了", …). */
  readonly label: string
  /** Current value; null means "not set" and disables both buttons. */
  readonly getValue: () => number | null
  /** Active step size, owned by the surface's shared step control. */
  readonly getStep: () => TimeStepMs
  readonly onChange: (nextMs: number) => void
}

export type TimeStepper = {
  readonly element: HTMLSpanElement
  /** Re-evaluate enabled state and step-dependent labels. */
  readonly sync: () => void
}

export type TimeStepControlOptions = {
  readonly getStep: () => TimeStepMs
  readonly onChange: (step: TimeStepMs) => void
  readonly label?: string
}

export type TimeStepControl = {
  readonly element: HTMLSelectElement
  readonly sync: () => void
}

function stepLabel(step: TimeStepMs): string {
  return step === TIME_STEP_COARSE_MS ? "1秒" : "0.1秒"
}

export function createTimeStepper(doc: Document, options: TimeStepperOptions): TimeStepper {
  const group = doc.createElement("span")
  group.className = "d-op-time-stepper"
  group.setAttribute("role", "group")
  group.setAttribute("aria-label", `${options.label}の微調整`)

  const makeButton = (direction: -1 | 1): HTMLButtonElement => {
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "d-op-time-step"
    button.textContent = direction < 0 ? "−" : "+"
    button.addEventListener("click", () => {
      const current = options.getValue()
      if (current === null) return
      options.onChange(Math.max(0, current + direction * options.getStep()))
      sync()
    })
    return button
  }

  const minus = makeButton(-1)
  const plus = makeButton(1)
  group.append(minus, plus)

  function sync(): void {
    const current = options.getValue()
    const step = options.getStep()
    minus.disabled = current === null || current < step
    plus.disabled = current === null
    minus.title = `${options.label}を${stepLabel(step)}戻す`
    minus.setAttribute("aria-label", `${options.label}を${stepLabel(step)}戻す`)
    plus.title = `${options.label}を${stepLabel(step)}進める`
    plus.setAttribute("aria-label", `${options.label}を${stepLabel(step)}進める`)
  }

  sync()
  return { element: group, sync }
}

/** Share one 0.1 s / 1 s choice between the start and end nudgers. */
export function createTimeStepControl(
  doc: Document,
  options: TimeStepControlOptions,
): TimeStepControl {
  const select = doc.createElement("select")
  select.className = "d-op-step-select"
  select.setAttribute("aria-label", options.label ?? "刻み")
  select.title = "ステッパーの刻み"
  for (const [value, label] of [
    [TIME_STEP_FINE_MS, "0.1秒刻み"],
    [TIME_STEP_COARSE_MS, "1秒刻み"],
  ] as const) {
    const option = doc.createElement("option")
    option.value = String(value)
    option.textContent = label
    select.appendChild(option)
  }
  const read = (): TimeStepMs =>
    select.value === String(TIME_STEP_COARSE_MS) ? TIME_STEP_COARSE_MS : TIME_STEP_FINE_MS
  select.addEventListener("change", () => options.onChange(read()))
  function sync(): void {
    select.value = String(options.getStep())
  }
  sync()
  return { element: select, sync }
}
