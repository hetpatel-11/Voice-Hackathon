const BACKEND_URL = 'http://127.0.0.1:8787'

const chatFeed = document.getElementById('chatFeed')
const commandInput = document.getElementById('commandInput')
const healthPill = document.getElementById('healthPill')
const recordButton = document.getElementById('recordButton')
const testVoiceButton = document.getElementById('testVoiceButton')
const sendButton = document.getElementById('sendButton')
const statusText = document.getElementById('statusText')
const traceList = document.getElementById('traceList')
const traceSummary = document.getElementById('traceSummary')

let mediaRecorder = null
let recordedChunks = []
let activeAudio = null

function setStatus(text) {
  statusText.textContent = text
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

function renderTrace(trace, plan) {
  if (!trace) {
    traceSummary.textContent = 'No trace returned for this run.'
    traceList.replaceChildren()
    return
  }

  traceSummary.textContent = `Page: ${trace.pageSummary.title} • mode: ${plan?.mode || 'unknown'} • CSS: ${plan?.generatedCss?.length || 0} chars • DOM actions: ${plan?.domActions?.length || 0} • fallback: ${trace.usedFallback ? 'yes' : 'no'}`
  traceList.replaceChildren()

  for (const event of trace.events || []) {
    const item = document.createElement('li')
    item.textContent = event
    traceList.appendChild(item)
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
  return chrome.tabs.sendMessage(tab.id, message)
}

async function fetchPageSnapshot() {
  return sendToTab({ type: 'GET_PAGE_SNAPSHOT' })
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

async function requestAgentPlan(transcript) {
  const page = await fetchPageSnapshot()
  const response = await fetch(`${BACKEND_URL}/api/agent/page-plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ page, transcript }),
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

async function testVoice() {
  setStatus('Testing Smallest voice...')

  try {
    await playVoice('Voice is connected and ready. Claude can analyze the current page when you send a request.')
    appendMessage('assistant', 'Voice test succeeded.')
    setStatus('Voice is working.')
  } catch (error) {
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
  setStatus('Claude is analyzing the page...')
  const payload = await requestAgentPlan(trimmed)
  const { plan, trace } = payload

  await sendToTab({ type: 'APPLY_AGENT_PLAN', plan })
  renderTrace(trace, plan)

  const assistantText = [plan.pageAnswer, plan.summary]
    .filter(Boolean)
    .join('\n\n')

  appendMessage('assistant', assistantText || 'Plan applied.')

  if (plan.voiceResponse) {
    setStatus('Smallest is speaking the response...')
    try {
      await playVoice(plan.voiceResponse)
    } catch (error) {
      appendMessage(
        'assistant',
        `Voice playback failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
    }
  }

  setStatus('Done.')
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not expose microphone capture to the extension popup.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  recordedChunks = []
  mediaRecorder = new MediaRecorder(stream)

  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data)
    }
  })

  mediaRecorder.addEventListener('stop', async () => {
    try {
      setStatus('Smallest is transcribing your voice...')
      const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' })
      const transcript = await transcribeAudio(audioBlob)
      commandInput.value = transcript

      if (transcript) {
        await runCommand(transcript)
      } else {
        setStatus('No speech detected.')
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Voice command failed.')
    } finally {
      recordButton.classList.remove('is-recording')
      recordButton.textContent = 'Voice'
      stream.getTracks().forEach((track) => track.stop())
      mediaRecorder = null
    }
  })

  mediaRecorder.start()
  recordButton.classList.add('is-recording')
  recordButton.textContent = 'Stop'
  setStatus('Recording...')
}

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop()
    return
  }

  try {
    await startRecording()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Unable to start recording.')
  }
}

async function checkHealth() {
  try {
    const response = await fetch(`${BACKEND_URL}/health`)
    const payload = await response.json()

    if (!response.ok || !payload.ok) {
      throw new Error('Backend unavailable')
    }

    const micState = navigator.mediaDevices?.getUserMedia ? 'browser mic ready' : 'no mic API'
    const claudeState = payload.agentSdkConfigured
      ? payload.agentWarm
        ? 'ready'
        : 'warming'
      : 'missing key'
    healthPill.textContent = `Claude: ${claudeState} • Smallest: ${payload.smallestConfigured ? 'ready' : 'missing key'} • ${micState}`
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

commandInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    void runCommand(commandInput.value).catch((error) => {
      setStatus(error instanceof Error ? error.message : 'Command failed.')
    })
  }
})

void checkHealth()
