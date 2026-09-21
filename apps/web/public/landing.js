// Progressive enhancement for the landing page (task 21, ported from the
// legacy gh-pages script.js). Served same-origin under `script-src 'self'` —
// no inline handlers anywhere. Everything here is an enhancement only: the
// page renders and every link works with JavaScript disabled.
//
//   1. Gallery carousel: prev/next buttons, thumbnail tabs, ArrowLeft/Right
//      keys and a 4s auto-advance that pauses on hover/focus and is disabled
//      entirely under prefers-reduced-motion.
//   2. Lightbox: clicking a slide opens a modal-style overlay viewer with
//      prev/next, a position counter, Escape/overlay-click close, and arrow
//      key navigation.
;(() => {
  const GALLERY_INTERVAL_MS = 4000

  const CHEVRON_PREV =
    '<svg viewBox="0 0 24 24" width="20" height="20" focusable="false" aria-hidden="true"><path d="M15 4 L7 12 L15 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const CHEVRON_NEXT =
    '<svg viewBox="0 0 24 24" width="20" height="20" focusable="false" aria-hidden="true"><path d="M9 4 L17 12 L9 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const CLOSE_MARK =
    '<svg viewBox="0 0 24 24" width="22" height="22" focusable="false" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'

  let activeLightbox = null

  function initGallery(root) {
    const slides = Array.from(root.querySelectorAll("[data-slide]"))
    const thumbs = Array.from(root.querySelectorAll("[data-gallery-thumb]"))
    const prevBtn = root.querySelector("[data-gallery-prev]")
    const nextBtn = root.querySelector("[data-gallery-next]")
    if (slides.length === 0) return

    let activeIndex = slides.findIndex((slide) => slide.classList.contains("is-active"))
    if (activeIndex < 0) activeIndex = 0
    let timerId = null
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    function show(next) {
      const count = slides.length
      activeIndex = ((next % count) + count) % count
      slides.forEach((slide, i) => {
        slide.classList.toggle("is-active", i === activeIndex)
      })
      thumbs.forEach((thumb, i) => {
        const on = i === activeIndex
        thumb.classList.toggle("is-active", on)
        thumb.setAttribute("aria-selected", on ? "true" : "false")
      })
    }

    function startAuto() {
      stopAuto()
      if (reduceMotion || slides.length < 2) return
      timerId = window.setInterval(() => show(activeIndex + 1), GALLERY_INTERVAL_MS)
    }

    function stopAuto() {
      if (timerId !== null) {
        window.clearInterval(timerId)
        timerId = null
      }
    }

    if (prevBtn instanceof HTMLElement) {
      prevBtn.addEventListener("click", () => {
        show(activeIndex - 1)
        startAuto()
      })
    }
    if (nextBtn instanceof HTMLElement) {
      nextBtn.addEventListener("click", () => {
        show(activeIndex + 1)
        startAuto()
      })
    }
    thumbs.forEach((thumb, i) => {
      thumb.addEventListener("click", () => {
        show(i)
        startAuto()
      })
    })
    root.addEventListener("mouseenter", stopAuto)
    root.addEventListener("mouseleave", startAuto)
    root.addEventListener("focusin", stopAuto)
    root.addEventListener("focusout", startAuto)
    root.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        show(activeIndex - 1)
        startAuto()
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        show(activeIndex + 1)
        startAuto()
      }
    })
    root.querySelectorAll("[data-lightbox-trigger]").forEach((trigger) => {
      trigger.addEventListener("click", () => openLightbox(root, activeIndex, trigger))
    })
    show(activeIndex)
    startAuto()
  }

  function openLightbox(galleryRoot, startIndex, trigger) {
    if (activeLightbox !== null) return
    const slides = Array.from(galleryRoot.querySelectorAll("[data-slide]"))
    if (slides.length === 0) return
    // Task 24: remember the opener so closing returns focus to it.
    const focusOrigin = trigger instanceof HTMLElement ? trigger : document.activeElement

    const overlay = document.createElement("div")
    overlay.className = "lightbox"
    overlay.setAttribute("role", "dialog")
    overlay.setAttribute("aria-modal", "true")
    overlay.setAttribute("aria-label", "画像ビューア")

    const img = document.createElement("img")
    img.className = "lightbox-img"
    img.alt = ""
    overlay.appendChild(img)

    const counter = document.createElement("div")
    counter.className = "lightbox-counter"
    overlay.appendChild(counter)

    const closeBtn = document.createElement("button")
    closeBtn.className = "lightbox-close"
    closeBtn.type = "button"
    closeBtn.setAttribute("aria-label", "閉じる")
    closeBtn.innerHTML = CLOSE_MARK
    overlay.appendChild(closeBtn)

    const prevBtn = document.createElement("button")
    prevBtn.className = "lightbox-prev"
    prevBtn.type = "button"
    prevBtn.setAttribute("aria-label", "前の画像")
    prevBtn.innerHTML = CHEVRON_PREV
    overlay.appendChild(prevBtn)

    const nextBtn = document.createElement("button")
    nextBtn.className = "lightbox-next"
    nextBtn.type = "button"
    nextBtn.setAttribute("aria-label", "次の画像")
    nextBtn.innerHTML = CHEVRON_NEXT
    overlay.appendChild(nextBtn)

    document.body.appendChild(overlay)
    document.body.classList.add("has-lightbox")

    let index = ((startIndex % slides.length) + slides.length) % slides.length
    const slideImage = (i) => {
      const slide = slides[i]
      return slide instanceof HTMLElement ? slide.querySelector("img") : null
    }
    const render = () => {
      const source = slideImage(index)
      img.src = source === null ? "" : source.getAttribute("src") || ""
      img.alt = source === null ? "" : source.getAttribute("alt") || ""
      counter.textContent = `${index + 1} / ${slides.length}`
    }
    const close = () => {
      document.body.classList.remove("has-lightbox")
      overlay.remove()
      document.removeEventListener("keydown", onKey)
      activeLightbox = null
      // Return focus to the control that opened the viewer (task 24).
      if (focusOrigin instanceof HTMLElement && focusOrigin.isConnected) {
        focusOrigin.focus()
      }
    }
    // Tab/Shift+Tab cycle inside the dialog so focus never escapes behind
    // the modal overlay (task 24).
    const trapTab = (event) => {
      if (event.key !== "Tab") return
      const focusables = Array.from(
        overlay.querySelectorAll("button:not([disabled]), [href], [tabindex]"),
      ).filter((el) => !el.hasAttribute("disabled"))
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const inside = active instanceof HTMLElement && overlay.contains(active)
      if (!inside) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const onKey = (event) => {
      if (event.key === "Escape") {
        close()
      } else if (event.key === "ArrowLeft") {
        index = (index - 1 + slides.length) % slides.length
        render()
      } else if (event.key === "ArrowRight") {
        index = (index + 1) % slides.length
        render()
      } else if (event.key === "Tab") {
        trapTab(event)
      }
    }
    closeBtn.addEventListener("click", close)
    prevBtn.addEventListener("click", () => {
      index = (index - 1 + slides.length) % slides.length
      render()
    })
    nextBtn.addEventListener("click", () => {
      index = (index + 1) % slides.length
      render()
    })
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close()
    })
    document.addEventListener("keydown", onKey)
    activeLightbox = { close }
    render()
    requestAnimationFrame(() => overlay.classList.add("is-open"))
    // Focus lands on the close control so screen-reader and keyboard users
    // start inside the dialog, not behind it (task 24).
    closeBtn.focus()
  }

  const bindGallery = () => {
    document.querySelectorAll("[data-gallery]").forEach(initGallery)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindGallery, { once: true })
  } else {
    bindGallery()
  }
})()
