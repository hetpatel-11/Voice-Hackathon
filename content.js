const DEFAULT_SETTINGS = {
  focusMode: false,
  highContrast: false,
  highlightInteractive: false,
  largeText: false,
  readableSpacing: false,
  reduceMotion: false,
}
const PERSIST_ENABLED_KEY = 'voiceRestylerPersistEnabled'

let currentSettings = { ...DEFAULT_SETTINGS }
let currentPlan = {
  domActions: [],
  generatedCss: '',
  settings: { ...DEFAULT_SETTINGS },
}
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

function getPageStorageKey() {
  return `voiceRestylerPageState:${location.origin}${location.pathname}`
}

function buildStoryItems() {
  const hackerNewsRows = [...document.querySelectorAll('tr.athing')].slice(0, 20)

  if (hackerNewsRows.length) {
    return hackerNewsRows.map((row, index) => {
      const titleLink = row.querySelector('.titleline a') || row.querySelector('.title a')
      const rankText = row.querySelector('.rank')?.textContent?.trim() || `${index + 1}.`
      const metadataRow = row.nextElementSibling
      const metaText = metadataRow?.querySelector('.subtext')?.textContent?.trim() || ''

      return {
        href: titleLink?.href || '',
        meta: metaText,
        rank: rankText.replace(/\.$/, ''),
        title: titleLink?.textContent?.trim() || '',
      }
    })
  }

  return [...document.querySelectorAll('article, main li, [role="article"]')]
    .map((element, index) => {
      const headingLink =
        element.querySelector('h1 a, h2 a, h3 a, h4 a, a[href]') || element.querySelector('a[href]')

      return {
        href: headingLink?.href || '',
        meta: '',
        rank: String(index + 1),
        title: headingLink?.textContent?.trim() || '',
      }
    })
    .filter((item) => item.title)
    .slice(0, 20)
}

function buildPageSnapshot() {
  const generatedStyle = document.getElementById('voice-restyler-generated-style')
  const storyItems = buildStoryItems()
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
    activeSettings: currentSettings,
    forms: document.forms.length,
    generatedCss: generatedStyle?.textContent || '',
    headings,
    interactive,
    issues: {
      missingLabels: countMissingLabels(),
      missingPageLanguage: !document.documentElement.lang,
    },
    lang: document.documentElement.lang || '',
    nodes: buildNodeMap(),
    pageText: paragraphs.join(' ').slice(0, 2200),
    storyItems,
    title: document.title,
    url: location.href,
  }
}

function applySettings(settings) {
  currentSettings = { ...DEFAULT_SETTINGS, ...settings }
  currentPlan.settings = { ...currentSettings }
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
  currentPlan.generatedCss = cssText || ''
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
  currentPlan.domActions = Array.isArray(actions) ? actions : []

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

function setCurrentPlan(plan) {
  currentPlan = {
    domActions: Array.isArray(plan?.domActions) ? plan.domActions : [],
    generatedCss: typeof plan?.generatedCss === 'string' ? plan.generatedCss : '',
    settings:
      plan?.settings && typeof plan.settings === 'object'
        ? { ...DEFAULT_SETTINGS, ...plan.settings }
        : { ...DEFAULT_SETTINGS },
  }
}

function loadPagePersistence(callback) {
  const pageKey = getPageStorageKey()

  chrome.storage.local.get(
    {
      [PERSIST_ENABLED_KEY]: false,
      [pageKey]: null,
    },
    (data) => {
      callback({
        enabled: Boolean(data[PERSIST_ENABLED_KEY]),
        pageKey,
        pageState: data[pageKey],
      })
    },
  )
}

function persistCurrentPageState() {
  loadPagePersistence(({ enabled, pageKey }) => {
    if (!enabled) {
      return
    }

    chrome.storage.local.set({
      [pageKey]: {
        domActions: currentPlan.domActions,
        generatedCss: currentPlan.generatedCss,
        settings: currentPlan.settings,
      },
    })
  })
}

function clearPersistedPageState() {
  chrome.storage.local.remove(getPageStorageKey())
}

function restorePersistedPageState(pageState) {
  if (!pageState || typeof pageState !== 'object') {
    return
  }

  applySettings(pageState.settings ?? DEFAULT_SETTINGS)
  applyHeuristicLabels()
  applyGeneratedCss(pageState.generatedCss ?? '')
  applyDomActions(pageState.domActions ?? [])
  setCurrentPlan({
    domActions: pageState.domActions ?? [],
    generatedCss: pageState.generatedCss ?? '',
    settings: pageState.settings ?? DEFAULT_SETTINGS,
  })
}

applySettings(DEFAULT_SETTINGS)
applyHeuristicLabels()
ensureNodeAnnotations()
loadPagePersistence(({ enabled, pageState }) => {
  if (enabled && pageState) {
    restorePersistedPageState(pageState)
  }
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
    setCurrentPlan(message.plan ?? {})
    persistCurrentPageState()
    sendResponse({ ok: true })
    return true
  }

  if (message.type === 'GET_PERSISTENCE_STATE') {
    loadPagePersistence(({ enabled, pageState }) => {
      sendResponse({
        enabled,
        hasPersistedState: Boolean(pageState?.generatedCss),
      })
    })
    return true
  }

  if (message.type === 'SET_PERSISTENCE_ENABLED') {
    const enabled = Boolean(message.enabled)

    chrome.storage.local.set({ [PERSIST_ENABLED_KEY]: enabled }, () => {
      if (enabled) {
        persistCurrentPageState()
      } else {
        clearPersistedPageState()
      }

      sendResponse({ enabled, ok: true })
    })
    return true
  }

  if (message.type === 'STOP_AUDIO_GUIDE') {
    sendResponse({ ok: true })
    return true
  }

  return false
})
