const BACKEND_URL = 'http://127.0.0.1:8787'

const chatFeed = document.getElementById('chatFeed')
const commandInput = document.getElementById('commandInput')
const healthPill = document.getElementById('healthPill')
const fixMicButton = document.getElementById('fixMicButton')
const persistToggle = document.getElementById('persistToggle')
const recordButton = document.getElementById('recordButton')
const testVoiceButton = document.getElementById('testVoiceButton')
const sendButton = document.getElementById('sendButton')
const statusText = document.getElementById('statusText')
const traceDetails = document.getElementById('traceDetails')
const traceList = document.getElementById('traceList')
const traceSummary = document.getElementById('traceSummary')

let mediaRecorder = null
let recordedChunks = []
let activeAudio = null
let microphonePermissionState = 'unknown'
let liveTraceEvents = []
let conversationHistory = []
let recordingMode = 'manual'

function setStatus(text) {
  statusText.textContent = text
}

function setMicRecoveryVisible(visible) {
  fixMicButton.classList.toggle('hidden', !visible)
}

function appendMessage(role, text) {
  const article = document.createElement('article')
  article.className = `message ${role}`

  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text

  article.appendChild(bubble)
  chatFeed.appendChild(article)
  chatFeed.scrollTop = chatFeed.scrollHeight
}

function rememberConversation(role, text) {
  conversationHistory.push({ role, text })
  conversationHistory = conversationHistory.slice(-8)
}

function resetLiveTrace(summary) {
  liveTraceEvents = []
  traceSummary.textContent = summary
  traceList.replaceChildren()
  traceDetails.open = true
}

function appendTraceEvent(text) {
  liveTraceEvents.push(text)
  traceList.replaceChildren()

  for (const event of liveTraceEvents) {
    const item = document.createElement('li')
    item.textContent = event
    traceList.appendChild(item)
  }

  traceDetails.open = true
}

function renderTrace(trace, plan) {
  if (!trace) {
    appendTraceEvent('Backend did not return a structured trace.')
    return
  }

  traceSummary.textContent = `Page: ${trace.pageSummary.title} • mode: ${plan?.mode || 'unknown'} • CSS: ${plan?.generatedCss?.length || 0} chars • DOM actions: ${plan?.domActions?.length || 0} • fallback: ${trace.usedFallback ? 'yes' : 'no'}`

  for (const event of trace.events || []) {
    appendTraceEvent(event)
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

  if (!tab?.id) {
    throw new Error('No active tab found.')
  }

  return tab
}

async function sendToTab(message) {
  const tab = await getActiveTab()

  try {
    return await chrome.tabs.sendMessage(tab.id, message)
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)

    if (!messageText.includes('Receiving end does not exist')) {
      throw error
    }

    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content.css'],
      })
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      })

      return chrome.tabs.sendMessage(tab.id, message)
    } catch {
      throw new Error(
        'The extension could not attach to this tab. Refresh the page or open a normal website instead of a Chrome internal page.',
      )
    }
  }
}

async function fetchPageSnapshot() {
  return sendToTab({ type: 'GET_PAGE_SNAPSHOT' })
}

async function fetchPersistenceState() {
  return sendToTab({ type: 'GET_PERSISTENCE_STATE' })
}

async function setPersistenceEnabled(enabled) {
  return sendToTab({ type: 'SET_PERSISTENCE_ENABLED', enabled })
}

async function transcribeAudio(audioBlob) {
  const response = await fetch(`${BACKEND_URL}/api/voice/transcribe?language=en`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: audioBlob,
  })

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error ?? 'Unable to transcribe voice input.')
  }

  return payload.transcription || ''
}

async function requestAgentPlan(transcript, page) {
  const response = await fetch(`${BACKEND_URL}/api/agent/page-plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      history: conversationHistory,
      page,
      transcript,
    }),
  })

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error ?? 'Unable to generate page plan.')
  }

  return payload
}

async function playVoice(text) {
  if (activeAudio) {
    activeAudio.pause()
    activeAudio.currentTime = 0
  }

  const response = await fetch(`${BACKEND_URL}/api/voice/speak`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      accent: 'general american',
      emotion: 'confident',
      pitch: 'mid-range',
      prosody: 'measured',
      text,
      voiceId: 'natalie',
      volume: 'normal',
    }),
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  const audioBlob = await response.blob()
  const audioUrl = URL.createObjectURL(audioBlob)
  activeAudio = new Audio(audioUrl)
  await activeAudio.play()
}

async function getMicrophonePermissionState() {
  if (!navigator.permissions?.query) {
    return 'unknown'
  }

  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    microphonePermissionState = status.state
    status.onchange = () => {
      microphonePermissionState = status.state
      void checkHealth()
    }
    return status.state
  } catch {
    return 'unknown'
  }
}

function describeMicrophoneError(error) {
  if (!(error instanceof Error)) {
    return 'Unable to start voice recording.'
  }

  const message = error.message.toLowerCase()

  if (error.name === 'NotAllowedError' || message.includes('permission')) {
    setMicRecoveryVisible(true)
    return 'Microphone permission was dismissed or blocked. Open microphone settings, allow access, then reopen the popup.'
  }

  if (error.name === 'NotFoundError') {
    return 'No microphone was found on this device.'
  }

  if (error.name === 'NotReadableError') {
    return 'The microphone is already in use by another app.'
  }

  return error.message
}

async function testVoice() {
  setStatus('Testing Smallest voice...')
  resetLiveTrace('Running a direct Smallest voice test.')

  try {
    appendTraceEvent('Sending a direct text sample to Smallest TTS.')
    await playVoice('Voice is connected and ready. Claude can analyze the current page when you send a request.')
    appendTraceEvent('Smallest returned audio and playback started.')
    appendMessage('assistant', 'Voice test succeeded.')
    setStatus('Voice is working.')
  } catch (error) {
    appendTraceEvent(
      `Voice test failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    appendMessage(
      'assistant',
      `Voice test failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    setStatus('Voice test failed.')
  }
}

async function runCommand(command) {
  const trimmed = command.trim()

  if (!trimmed) {
    throw new Error('Enter or speak a command first.')
  }

  appendMessage('user', trimmed)
  rememberConversation('user', trimmed)
  resetLiveTrace('Starting a new run.')
  setStatus('Claude is analyzing the page...')
  appendTraceEvent('Collecting a page snapshot from the active tab.')
  const page = await fetchPageSnapshot()
  appendTraceEvent(
    `Captured page snapshot for "${page.title || 'Untitled page'}" with ${
      Array.isArray(page.interactive) ? page.interactive.length : 0
    } interactive elements.`,
  )
  appendTraceEvent('Sending the user request and page snapshot to Claude Agent SDK.')
  const payload = await requestAgentPlan(trimmed, page)
  const { plan, trace } = payload

  appendTraceEvent('Received a structured plan from the backend.')
  appendTraceEvent('Applying generated CSS and DOM actions to the current page.')
  await sendToTab({ type: 'APPLY_AGENT_PLAN', plan })
  renderTrace(trace, plan)

  const assistantText = [plan.pageAnswer, plan.summary]
    .filter(Boolean)
    .join('\n\n')

  appendMessage('assistant', assistantText || 'Plan applied.')
  rememberConversation('assistant', assistantText || 'Plan applied.')

  if (plan.voiceResponse) {
    setStatus('Smallest is speaking the response...')
    try {
      appendTraceEvent('Requesting Smallest TTS for the spoken response.')
      await playVoice(plan.voiceResponse)
      appendTraceEvent('Smallest voice playback started.')
    } catch (error) {
      appendTraceEvent(
        `Voice playback failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
      appendMessage(
        'assistant',
        `Voice playback failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
    }
  }

  appendTraceEvent('Run completed.')
  setStatus('Done.')
}

async function startRecording({ autoStopOnSilence = false, mode = 'manual' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not expose microphone capture to the extension popup.')
  }

  recordingMode = mode
  setMicRecoveryVisible(false)
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  const samples = new Uint8Array(analyser.fftSize)
  let heardVoice = false
  let silenceSince = 0
  let animationFrameId = 0
  recordedChunks = []
  mediaRecorder = new MediaRecorder(stream)
  source.connect(analyser)

  const monitorSilence = () => {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      return
    }

    analyser.getByteTimeDomainData(samples)

    let peak = 0

    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample - 128))
    }

    if (peak > 10) {
      heardVoice = true
      silenceSince = 0
    } else if (autoStopOnSilence && heardVoice) {
      silenceSince = silenceSince || performance.now()

      if (performance.now() - silenceSince > 1200) {
        appendTraceEvent('Silence detected. Stopping recording and sending the command.')
        mediaRecorder.stop()
        return
      }
    }

    animationFrameId = requestAnimationFrame(monitorSilence)
  }

  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data)
    }
  })

  mediaRecorder.addEventListener('stop', async () => {
    try {
      setStatus('Smallest is transcribing your voice...')
      appendTraceEvent('Uploading recorded audio to Smallest STT.')
      const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' })
      const transcript = await transcribeAudio(audioBlob)
      appendTraceEvent(`Smallest transcription: "${transcript || 'no speech detected'}".`)
      commandInput.value = transcript

      if (transcript) {
        await runCommand(transcript)
      } else {
        setStatus('No speech detected.')
      }
    } catch (error) {
      setStatus(describeMicrophoneError(error))
    } finally {
      recordButton.classList.remove('is-recording')
      recordButton.textContent = 'Voice'
      cancelAnimationFrame(animationFrameId)
      source.disconnect()
      void audioContext.close()
      stream.getTracks().forEach((track) => track.stop())
      mediaRecorder = null
    }
  })

  mediaRecorder.start()
  if (autoStopOnSilence) {
    animationFrameId = requestAnimationFrame(monitorSilence)
  }
  recordButton.classList.add('is-recording')
  recordButton.textContent = 'Stop'
  setStatus(
    autoStopOnSilence
      ? 'Recording from shortcut... I will send automatically when you stop speaking.'
      : 'Recording... press Stop when you are done speaking.',
  )
}

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    appendTraceEvent('Stopping microphone capture and sending audio for transcription.')
    mediaRecorder.stop()
    return
  }

  try {
    resetLiveTrace('Starting microphone capture.')
    appendTraceEvent('Requesting microphone access from Chrome.')
    await startRecording({ autoStopOnSilence: false, mode: 'manual' })
    appendTraceEvent('Microphone access granted. Recording started.')
  } catch (error) {
    appendTraceEvent(
      `Microphone start failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
    setStatus(describeMicrophoneError(error))
  }
}

async function maybeAutoStartVoiceFromShortcut() {
  const sessionState = await chrome.storage.session.get({ autoStartVoice: false })

  if (!sessionState.autoStartVoice) {
    return
  }

  await chrome.storage.session.set({ autoStartVoice: false })
  resetLiveTrace('Voice shortcut triggered from the keyboard.')
  appendTraceEvent('Popup opened from the extension shortcut. Starting microphone capture.')
  try {
    await startRecording({ autoStopOnSilence: true, mode: 'shortcut' })
    appendTraceEvent('Shortcut voice capture started. I will send when you stop speaking.')
  } catch (error) {
    appendTraceEvent(
      `Shortcut voice start failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    )
    setStatus(describeMicrophoneError(error))
  }
}

async function loadPersistenceToggle() {
  try {
    const state = await fetchPersistenceState()
    persistToggle.checked = Boolean(state.enabled)
  } catch {
    persistToggle.checked = false
  }
}

async function checkHealth() {
  try {
    const micPermission = await getMicrophonePermissionState()
    const response = await fetch(`${BACKEND_URL}/health`)
    const payload = await response.json()

    if (!response.ok || !payload.ok) {
      throw new Error('Backend unavailable')
    }

    const micState =
      micPermission === 'denied'
        ? 'mic blocked'
        : micPermission === 'prompt'
          ? 'mic needs approval'
          : navigator.mediaDevices?.getUserMedia
            ? 'browser mic ready'
            : 'no mic API'
    const claudeState = payload.agentSdkConfigured
      ? payload.agentWarm
        ? 'ready'
        : 'warming'
      : 'missing key'
    healthPill.textContent = `Claude: ${claudeState} • Smallest: ${payload.smallestConfigured ? 'ready' : 'missing key'} • ${micState}`
    setMicRecoveryVisible(micPermission === 'denied')
  } catch {
    healthPill.textContent = 'Backend offline'
  }
}

recordButton.addEventListener('click', () => {
  void toggleRecording()
})

sendButton.addEventListener('click', () => {
  void runCommand(commandInput.value).catch((error) => {
    setStatus(error instanceof Error ? error.message : 'Command failed.')
  })
})

testVoiceButton.addEventListener('click', () => {
  void testVoice()
})

persistToggle.addEventListener('change', () => {
  void setPersistenceEnabled(persistToggle.checked).catch((error) => {
    persistToggle.checked = !persistToggle.checked
    setStatus(error instanceof Error ? error.message : 'Unable to update persistence.')
  })
})

fixMicButton.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://settings/content/microphone' })
})

commandInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void runCommand(commandInput.value).catch((error) => {
      setStatus(error instanceof Error ? error.message : 'Command failed.')
    })
  }
})

void checkHealth()
void loadPersistenceToggle()
void maybeAutoStartVoiceFromShortcut()
