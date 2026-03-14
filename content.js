const DEFAULT_SETTINGS = {
  focusMode: false,
  highContrast: false,
  highlightInteractive: false,
  largeText: false,
  readableSpacing: false,
  reduceMotion: false,
}

let currentSettings = { ...DEFAULT_SETTINGS }
const actionCleanup = new Map()

function getInteractiveLabel(element) {
  return (
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.getAttribute('placeholder') ||
    element.textContent?.trim() ||
    element.querySelector('img')?.getAttribute('alt') ||
    ''
  )
}

function countMissingLabels() {
  const controls = document.querySelectorAll('button, a, input, textarea, select')
  let missing = 0

  controls.forEach((control) => {
    if (!getInteractiveLabel(control)) {
      missing += 1
    }
  })

  return missing
}

function ensureNodeAnnotations() {
  const candidates = document.querySelectorAll(
    'header, nav, main, aside, section, article, form, button, a, input, textarea, select, img, video, h1, h2, h3',
  )

  let counter = 1

  candidates.forEach((element) => {
    if (element instanceof HTMLElement && !element.dataset.voiceNodeId) {
      element.dataset.voiceNodeId = `node-${counter}`
      counter += 1
    }
  })
}

function buildNodeMap() {
  ensureNodeAnnotations()

  return [...document.querySelectorAll('[data-voice-node-id]')]
    .slice(0, 60)
    .map((element) => ({
      ariaLabel: element.getAttribute('aria-label') || '',
      nodeId: element.getAttribute('data-voice-node-id') || '',
      role: element.getAttribute('role') || '',
      tag: element.tagName.toLowerCase(),
      text: (getInteractiveLabel(element) || element.textContent || '').trim().slice(0, 120),
    }))
}

function buildPageSnapshot() {
  const headings = [...document.querySelectorAll('h1, h2, h3')]
    .map((element) => element.textContent?.trim())
    .filter(Boolean)
    .slice(0, 10)

  const interactive = [...document.querySelectorAll('button, a, input, textarea, select')]
    .map((element) => ({
      label: getInteractiveLabel(element),
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || '',
    }))
    .filter((item) => item.label)
    .slice(0, 16)

  const paragraphs = [...document.querySelectorAll('main p, article p, p')]
    .map((element) => element.textContent?.trim())
    .filter(Boolean)
    .slice(0, 10)

  return {
    forms: document.forms.length,
    headings,
    interactive,
    issues: {
      missingLabels: countMissingLabels(),
      missingPageLanguage: !document.documentElement.lang,
    },
    lang: document.documentElement.lang || '',
    nodes: buildNodeMap(),
    pageText: paragraphs.join(' ').slice(0, 2200),
    title: document.title,
    url: location.href,
  }
}

function applySettings(settings) {
  currentSettings = { ...DEFAULT_SETTINGS, ...settings }
  const root = document.documentElement

  root.classList.toggle('voice-restyler-high-contrast', currentSettings.highContrast)
  root.classList.toggle('voice-restyler-large-text', currentSettings.largeText)
  root.classList.toggle('voice-restyler-readable-spacing', currentSettings.readableSpacing)
  root.classList.toggle(
    'voice-restyler-highlight-interactive',
    currentSettings.highlightInteractive,
  )
  root.classList.toggle('voice-restyler-focus-mode', currentSettings.focusMode)
  root.classList.toggle('voice-restyler-reduce-motion', currentSettings.reduceMotion)

  chrome.storage.sync.set({ restylerSettings: currentSettings })
}

function applyHeuristicLabels() {
  document
    .querySelectorAll('button, a, input, textarea, select, [role="button"]')
    .forEach((element) => {
      if (element.getAttribute('aria-label')) {
        return
      }

      const label = getInteractiveLabel(element)

      if (label) {
        element.setAttribute('aria-label', label)
        element.setAttribute('data-voice-restyler-generated-label', 'true')
      }
    })
}

function applyGeneratedCss(cssText) {
  const styleId = 'voice-restyler-generated-style'
  let styleElement = document.getElementById(styleId)

  if (!styleElement) {
    styleElement = document.createElement('style')
    styleElement.id = styleId
    document.documentElement.appendChild(styleElement)
  }

  styleElement.textContent = cssText || ''
}

function rememberCleanup(target, cleanup) {
  const nodeId = target.getAttribute('data-voice-node-id')

  if (!nodeId) {
    return
  }

  const existing = actionCleanup.get(nodeId) ?? []
  existing.push(cleanup)
  actionCleanup.set(nodeId, existing)
}

function resetDomActions() {
  for (const [nodeId, cleanups] of actionCleanup.entries()) {
    const target = document.querySelector(`[data-voice-node-id="${CSS.escape(nodeId)}"]`)

    if (!(target instanceof HTMLElement)) {
      continue
    }

    cleanups.forEach((cleanup) => {
      try {
        cleanup(target)
      } catch {
        // Ignore stale cleanup handlers after page mutations.
      }
    })
  }

  actionCleanup.clear()
}

function applyDomActions(actions = []) {
  resetDomActions()

  actions.forEach((action) => {
    const nodeId = typeof action?.nodeId === 'string' ? action.nodeId : ''

    if (!nodeId) {
      return
    }

    const target = document.querySelector(`[data-voice-node-id="${CSS.escape(nodeId)}"]`)

    if (!(target instanceof HTMLElement)) {
      return
    }

    switch (action.action) {
      case 'setAttribute': {
        if (typeof action.name === 'string' && typeof action.value === 'string') {
          const previousValue = target.getAttribute(action.name)
          target.setAttribute(action.name, action.value)
          rememberCleanup(target, (element) => {
            if (previousValue === null) {
              element.removeAttribute(action.name)
            } else {
              element.setAttribute(action.name, previousValue)
            }
          })
        }
        break
      }
      case 'hide': {
        const previousDisplay = target.style.getPropertyValue('display')
        const previousPriority = target.style.getPropertyPriority('display')
        target.style.setProperty('display', 'none', 'important')
        rememberCleanup(target, (element) => {
          if (previousDisplay) {
            element.style.setProperty('display', previousDisplay, previousPriority)
          } else {
            element.style.removeProperty('display')
          }
        })
        break
      }
      case 'emphasize': {
        const previousOutline = target.style.getPropertyValue('outline')
        const previousOutlinePriority = target.style.getPropertyPriority('outline')
        const previousOutlineOffset = target.style.getPropertyValue('outline-offset')
        const previousOutlineOffsetPriority =
          target.style.getPropertyPriority('outline-offset')
        const previousScrollMargin = target.style.getPropertyValue('scroll-margin-top')
        const previousScrollMarginPriority =
          target.style.getPropertyPriority('scroll-margin-top')
        target.style.setProperty('outline', '3px solid #1fd476', 'important')
        target.style.setProperty('outline-offset', '3px', 'important')
        target.style.setProperty('scroll-margin-top', '24px', 'important')
        rememberCleanup(target, (element) => {
          if (previousOutline) {
            element.style.setProperty('outline', previousOutline, previousOutlinePriority)
          } else {
            element.style.removeProperty('outline')
          }

          if (previousOutlineOffset) {
            element.style.setProperty(
              'outline-offset',
              previousOutlineOffset,
              previousOutlineOffsetPriority,
            )
          } else {
            element.style.removeProperty('outline-offset')
          }

          if (previousScrollMargin) {
            element.style.setProperty(
              'scroll-margin-top',
              previousScrollMargin,
              previousScrollMarginPriority,
            )
          } else {
            element.style.removeProperty('scroll-margin-top')
          }
        })
        break
      }
      case 'focus':
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.focus?.()
        break
      default:
        break
    }
  })
}

chrome.storage.sync.get({ restylerSettings: DEFAULT_SETTINGS }, (data) => {
  applySettings(data.restylerSettings)
  applyHeuristicLabels()
  ensureNodeAnnotations()
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_SNAPSHOT') {
    sendResponse(buildPageSnapshot())
    return true
  }

  if (message.type === 'APPLY_AGENT_PLAN') {
    applySettings(message.plan?.settings ?? DEFAULT_SETTINGS)
    applyHeuristicLabels()
    applyGeneratedCss(message.plan?.generatedCss ?? '')
    applyDomActions(message.plan?.domActions ?? [])
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'STOP_AUDIO_GUIDE') {
    sendResponse({ ok: true })
    return true
  }

  return false
})
