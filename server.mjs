import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { query } from '@anthropic-ai/claude-agent-sdk'

for (const envFile of ['.env.local', '.env']) {
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile)
  }
}

const PORT = Number(process.env.PORT ?? 8787)
const DEFAULT_SETTINGS = {
  focusMode: false,
  highContrast: false,
  highlightInteractive: false,
  largeText: false,
  readableSpacing: false,
  reduceMotion: false,
}
const CLAUDE_MODEL = 'sonnet'
const CLAUDE_TIMEOUT_MS = 8000
const CLAUDE_RETRY_TIMEOUT_MS = 12000
const MAX_GENERATED_CSS_CHARS = 3500
const ALLOWED_SETTINGS = new Set(Object.keys(DEFAULT_SETTINGS))
const ALLOWED_MODES = new Set(['transform', 'answer', 'both'])
const ALLOWED_ACTIONS = new Set(['setAttribute', 'hide', 'emphasize', 'focus'])
const warmupState = {
  completed: false,
  error: '',
  started: false,
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  })
  response.end(JSON.stringify(payload))
}

function sendAudio(response, buffer) {
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Length': buffer.length,
    'Content-Type': 'audio/wav',
  })
  response.end(buffer)
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []

    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function readJsonBody(request) {
  const buffer = await readRawBody(request)

  if (!buffer.length) {
    return {}
  }

  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON.')
  }
}

function getRequiredEnv(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} is not configured.`)
  }

  return value
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withRetry(label, operation, attempts = 3) {
  let lastError = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error

      if (attempt === attempts) {
        break
      }

      await sleep(300 * attempt)
    }
  }

  throw new Error(
    `${label} failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : 'unknown error'
    }`,
  )
}

async function transcribeWithSmallest(audioBuffer, language = 'en') {
  return withRetry('Smallest STT', async () => {
    const apiKey = getRequiredEnv('SMALLEST_API_KEY')
    const response = await fetch(
      `https://waves-api.smallest.ai/api/v1/pulse/get_text?language=${encodeURIComponent(language)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/octet-stream',
        },
        body: audioBuffer,
      },
    )

    if (!response.ok) {
      throw new Error(await response.text())
    }

    return response.json()
  })
}

async function speakWithSmallest({
  accent = 'general american',
  emotion = 'confident',
  pitch = 'mid-range',
  prosody = 'measured',
  text,
  voiceId = 'natalie',
  volume = 'normal',
}) {
  return withRetry('Smallest TTS', async () => {
    const apiKey = getRequiredEnv('SMALLEST_API_KEY')
    const response = await fetch(
      'https://waves-api.smallest.ai/api/v1/lightning-v3.2/get_speech',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accent,
          emotion,
          output_format: 'wav',
          pitch,
          prosody,
          sample_rate: 44100,
          text,
          voice_id: voiceId,
          volume,
        }),
      },
    )

    if (!response.ok) {
      throw new Error(await response.text())
    }

    return Buffer.from(await response.arrayBuffer())
  })
}

function extractJsonObject(text) {
  const codeFenceMatch = text.match(/```json\s*([\s\S]*?)```/i)

  if (codeFenceMatch) {
    return JSON.parse(codeFenceMatch[1])
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found in agent output.')
  }

  return JSON.parse(text.slice(firstBrace, lastBrace + 1))
}

function sanitizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function sanitizeStringList(value, limit = 8) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim())
        .slice(0, limit)
    : []
}

function sanitizeSettings(value) {
  const settings = { ...DEFAULT_SETTINGS }

  if (!value || typeof value !== 'object') {
    return settings
  }

  for (const key of ALLOWED_SETTINGS) {
    if (typeof value[key] === 'boolean') {
      settings[key] = value[key]
    }
  }

  return settings
}

function constrainSettings(settings, transcript, mode) {
  const input = transcript.toLowerCase()
  const looksLikeVisualTransform =
    input.includes('look like') ||
    input.includes('feel like') ||
    input.includes('youtube') ||
    input.includes('spotify') ||
    input.includes('redesign')

  if (looksLikeVisualTransform && mode !== 'answer') {
    settings.highlightInteractive = input.includes('highlight')
    settings.highContrast =
      input.includes('contrast') || input.includes('accessible contrast')
    settings.focusMode = input.includes('focus') || input.includes('simplify')
    settings.largeText = input.includes('large text') || input.includes('bigger text')
  }

  return settings
}

function validateGeneratedCss(cssText) {
  if (!cssText) {
    return
  }

  if (cssText.length > MAX_GENERATED_CSS_CHARS) {
    throw new Error(`Generated CSS is too long (${cssText.length} chars).`)
  }

  if (/@import/i.test(cssText)) {
    throw new Error('Generated CSS may not use @import.')
  }

  if (/(^|[,{]\s*)\*/.test(cssText)) {
    throw new Error('Generated CSS may not use the universal selector.')
  }

  if (!/^(\s*html[\s>.:#[\]-]|[\s\S]*\n\s*html[\s>.:#[\]-])/i.test(cssText)) {
    throw new Error('Generated CSS must scope selectors from html to avoid page-wide collisions.')
  }

  const bannedPatterns = [
    { pattern: /\bposition\s*:\s*(fixed|sticky)\b/i, reason: 'Generated CSS may not pin layout with fixed or sticky positioning.' },
    { pattern: /\bz-index\s*:/i, reason: 'Generated CSS may not set z-index.' },
    { pattern: /\bbackdrop-filter\s*:/i, reason: 'Generated CSS may not use backdrop-filter.' },
    { pattern: /\bmix-blend-mode\s*:/i, reason: 'Generated CSS may not use mix-blend-mode.' },
    { pattern: /\bcontent\s*:/i, reason: 'Generated CSS may not create pseudo-content.' },
    { pattern: /\bpointer-events\s*:\s*none\b/i, reason: 'Generated CSS may not disable pointer events.' },
    { pattern: /\boutline\s*:/i, reason: 'Generated CSS may not add outlines globally.' },
  ]

  for (const rule of bannedPatterns) {
    if (rule.pattern.test(cssText)) {
      throw new Error(rule.reason)
    }
  }
}

function sanitizeDomActions(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((action) => ({
      action: sanitizeString(action?.action),
      name: sanitizeString(action?.name),
      nodeId: sanitizeString(action?.nodeId),
      value: sanitizeString(action?.value),
    }))
    .filter((action) => action.nodeId && ALLOWED_ACTIONS.has(action.action))
    .slice(0, 12)
}

function compactPageForPrompt(page = {}) {
  const compactInteractive = Array.isArray(page.interactive)
    ? page.interactive
        .map((item) => ({
          label: sanitizeString(item?.label).slice(0, 60),
          tag: sanitizeString(item?.tag).slice(0, 20),
        }))
        .filter((item) => item.label)
        .slice(0, 10)
    : []

  const compactNodes = Array.isArray(page.nodes)
    ? page.nodes
        .map((item) => ({
          nodeId: sanitizeString(item?.nodeId),
          role: sanitizeString(item?.role).slice(0, 30),
          tag: sanitizeString(item?.tag).slice(0, 20),
          text: sanitizeString(item?.text).slice(0, 90),
        }))
        .filter((item) => item.nodeId)
        .slice(0, 14)
    : []

  return {
    forms: Number(page.forms ?? 0),
    headings: sanitizeStringList(page.headings, 6),
    interactive: compactInteractive,
    issues: {
      missingLabels: Number(page.issues?.missingLabels ?? 0),
      missingPageLanguage: Boolean(page.issues?.missingPageLanguage),
    },
    lang: sanitizeString(page.lang).slice(0, 20),
    nodes: compactNodes,
    pageText: sanitizeString(page.pageText).replace(/\s+/g, ' ').slice(0, 900),
    title: sanitizeString(page.title).slice(0, 120),
    url: sanitizeString(page.url).slice(0, 240),
  }
}

function validatePlanShape(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Agent response is not an object.')
  }

  const mode = sanitizeString(value.mode, 'transform').toLowerCase()
  const summary = sanitizeString(value.summary)
  const pageAnswer = sanitizeString(value.pageAnswer)
  const generatedCss = sanitizeString(value.generatedCss).slice(0, MAX_GENERATED_CSS_CHARS)
  const voiceResponse = sanitizeString(
    value.voiceResponse,
    pageAnswer || summary || 'Accessibility changes applied.',
  )

  if (!summary) {
    throw new Error('Agent response is missing summary.')
  }

  validateGeneratedCss(generatedCss)

  return {
    confidence: sanitizeString(value.confidence, 'medium'),
    domActions: sanitizeDomActions(value.domActions),
    focusTargets: sanitizeStringList(value.focusTargets),
    generatedCss,
    issues: sanitizeStringList(value.issues),
    mode: ALLOWED_MODES.has(mode) ? mode : 'transform',
    pageAnswer,
    settings: sanitizeSettings(value.settings),
    summary,
    voiceResponse,
  }
}

function buildFallbackPlan({ page, transcript, reason }) {
  const input = transcript.toLowerCase()
  const asksQuestion =
    input.includes('?') ||
    /^(what|where|why|how|who|which|can|does|is|are)\b/.test(input)
  const settings = {
    ...DEFAULT_SETTINGS,
    focusMode: input.includes('focus') || input.includes('simplify'),
    highContrast: input.includes('contrast') || input.includes('easier to read'),
    highlightInteractive:
      input.includes('button') || input.includes('action') || input.includes('highlight'),
    largeText: input.includes('large text') || input.includes('bigger text'),
    readableSpacing: true,
    reduceMotion: input.includes('reduce motion'),
  }

  const cssParts = [`
html body {
  color: #f5f7fb !important;
  line-height: 1.65 !important;
}

html main,
html article,
html [role="main"] {
  max-width: 1100px !important;
  margin-inline: auto !important;
}

html header,
html nav,
html aside,
html section,
html article {
  border-radius: 16px !important;
}
`]

  const mainActions = sanitizeStringList(page?.interactive?.map((item) => item.label), 3)
  const answer = asksQuestion
    ? `This page is ${sanitizeString(page?.title, 'the current page')}. Main actions include ${mainActions.join(', ') || 'the visible controls on screen'}.`
    : ''

  return {
    confidence: 'fallback',
    domActions: [],
    focusTargets: mainActions,
    generatedCss: cssParts.join('\n'),
    issues: [
      ...(typeof page?.issues?.missingLabels === 'number' && page.issues.missingLabels > 0
        ? [`${page.issues.missingLabels} interactive elements may need accessible labels.`]
        : []),
      ...(reason ? [`Fallback applied after retries: ${reason}`] : []),
    ].slice(0, 6),
    mode: asksQuestion ? 'answer' : 'transform',
    pageAnswer: answer,
    settings,
    summary: 'Applied generated accessibility-oriented styling changes.',
    voiceResponse:
      answer || 'I applied accessibility-focused styling changes to this page.',
  }
}

async function runAgentJsonTask({ fallback, prompt }) {
  getRequiredEnv('ANTHROPIC_API_KEY')
  let lastError = null
  const trace = []

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let finalResult = ''
    const timeoutMs = attempt === 1 ? CLAUDE_TIMEOUT_MS : CLAUDE_RETRY_TIMEOUT_MS
    const attemptPrompt =
      attempt === 1
        ? prompt
        : `${prompt}\n\nPrevious output failed validation: ${
            lastError instanceof Error ? lastError.message : 'unknown error'
          }\nReturn corrected JSON only.`

    try {
      trace.push(`Claude attempt ${attempt}: generating JSON plan with Claude Agent SDK (${CLAUDE_MODEL})`)
      const agentQuery = query({
        prompt: attemptPrompt,
        options: {
          allowedTools: [],
          maxTurns: 2,
          model: CLAUDE_MODEL,
          permissionMode: 'plan',
          stderr: (data) => {
            const line = data.trim()

            if (line && trace.length < 16) {
              trace.push(`Claude SDK: ${line.slice(0, 180)}`)
            }
          },
          systemPrompt:
            'You are a precise accessibility and UI transformation agent. Output only valid JSON and no commentary.',
        },
      })
      let timeoutId = null
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          trace.push(`Claude attempt ${attempt}: timed out after ${timeoutMs}ms`)
          agentQuery.close()
          reject(new Error(`Claude Agent SDK timed out after ${timeoutMs}ms.`))
        }, timeoutMs)
      })

      await Promise.race([
        (async () => {
          for await (const message of agentQuery) {
            if (message && typeof message === 'object' && 'result' in message) {
              finalResult = message.result
            }
          }
        })(),
        timeout,
      ])
      clearTimeout(timeoutId)

      if (!finalResult) {
        throw new Error('Claude Agent SDK did not return a final result.')
      }

      const plan = validatePlanShape(extractJsonObject(finalResult))
      trace.push(
        `Claude attempt ${attempt}: valid JSON with ${plan.domActions.length} DOM actions and ${plan.generatedCss.length} CSS chars`,
      )
      return { plan, trace, usedFallback: false }
    } catch (error) {
      lastError = error
      trace.push(
        `Claude attempt ${attempt}: failed validation - ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
    }
  }

  const plan = fallback(lastError)
  trace.push('Fallback plan applied after validation retries.')
  return { plan, trace, usedFallback: true }
}

async function buildAgentPlan({ page, transcript }) {
  const promptPage = compactPageForPrompt(page)
  const prompt = `
You are an accessibility UI restyling agent for a browser extension.

User request:
${transcript}

Page snapshot:
${JSON.stringify(promptPage, null, 2)}

Return valid JSON only with this shape:
{
  "summary": "short summary",
  "voiceResponse": "short spoken response for the user",
  "pageAnswer": "direct answer if the user asked a page question, otherwise empty string",
  "mode": "transform|answer|both",
  "confidence": "high|medium|low",
  "settings": {
    "highContrast": true,
    "largeText": false,
    "readableSpacing": true,
    "highlightInteractive": true,
    "focusMode": false,
    "reduceMotion": false
  },
  "generatedCss": "raw css string to inject on this page",
  "domActions": [
    {
      "nodeId": "node-12",
      "action": "setAttribute|hide|emphasize|focus",
      "name": "aria-label",
      "value": "Search Wikipedia articles"
    }
  ],
  "focusTargets": ["short phrase", "short phrase"],
  "issues": ["short issue", "short issue"]
}

Rules:
- The UI must be generated by your reasoning, not by selecting a preset.
- If the user says "make it look like YouTube" or "Spotify", generate CSS that approximates that visual language on this specific page.
- Use nodeIds from the snapshot when you need element-specific actions.
- generatedCss must be reversible, page-local, and CSS-only.
- Every selector in generatedCss must start with html.
- Do not use @import.
- Do not use the universal selector (*).
- Do not use fixed or sticky positioning, z-index, outlines, or pseudo-element content.
- Do not put rings, pills, or boxes around every link or button unless the user explicitly asked for highlighting.
- Prefer 6 to 14 CSS rules total, focused on layout density, surfaces, spacing, and typography.
- Prefer safe HTML/CSS changes over destructive DOM rewrites.
- If the user asks a question about the page, answer it in pageAnswer.
- Keep voiceResponse under 35 words.
`.trim()

  const result = await runAgentJsonTask({
    fallback: (error) => buildFallbackPlan({ page, reason: error?.message, transcript }),
    prompt,
  })

  result.plan.settings = constrainSettings(
    result.plan.settings,
    transcript,
    result.plan.mode,
  )

  return result
}

async function warmAgentSdk() {
  if (warmupState.started || !process.env.ANTHROPIC_API_KEY) {
    return
  }

  warmupState.started = true
  const agentQuery = query({
    prompt: 'Return exactly {"ok":true} and nothing else.',
    options: {
      allowedTools: [],
      maxTurns: 1,
      model: CLAUDE_MODEL,
      permissionMode: 'plan',
    },
  })

  try {
    await Promise.race([
      (async () => {
        for await (const message of agentQuery) {
          if (message && typeof message === 'object' && 'result' in message) {
            warmupState.completed = true
            warmupState.error = ''
            break
          }
        }
      })(),
      new Promise((_, reject) => {
        setTimeout(() => {
          agentQuery.close()
          reject(new Error('Claude warmup timed out.'))
        }, 15000)
      }),
    ])
  } catch (error) {
    warmupState.error = error instanceof Error ? error.message : 'Claude warmup failed.'
  }
}

const server = createServer(async (request, response) => {
  if (!request.url || !request.method) {
    sendJson(response, 400, { error: 'Invalid request.' })
    return
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Origin': '*',
    })
    response.end()
    return
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host}`)

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        agentSdkConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
        agentWarm: warmupState.completed,
        agentWarmupError: warmupState.error,
        ok: true,
        smallestConfigured: Boolean(process.env.SMALLEST_API_KEY),
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/voice/transcribe') {
      const language = url.searchParams.get('language') ?? 'en'
      const audioBuffer = await readRawBody(request)

      if (!audioBuffer.length) {
        sendJson(response, 400, { error: 'Audio body is required.' })
        return
      }

      const transcription = await transcribeWithSmallest(audioBuffer, language)
      sendJson(response, 200, transcription)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/voice/speak') {
      const payload = await readJsonBody(request)

      if (typeof payload.text !== 'string' || !payload.text.trim()) {
        sendJson(response, 400, { error: 'text is required.' })
        return
      }

      const audioBuffer = await speakWithSmallest(payload)
      sendAudio(response, audioBuffer)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/page-plan') {
      const payload = await readJsonBody(request)

      if (typeof payload.transcript !== 'string' || !payload.transcript.trim()) {
        sendJson(response, 400, { error: 'transcript is required.' })
        return
      }

      if (!payload.page || typeof payload.page !== 'object') {
        sendJson(response, 400, { error: 'page snapshot is required.' })
        return
      }

      const result = await buildAgentPlan({
        page: payload.page,
        transcript: payload.transcript.trim(),
      })

      sendJson(response, 200, {
        plan: result.plan,
        trace: {
          events: result.trace,
          pageSummary: {
            forms: payload.page.forms ?? 0,
            interactiveCount: Array.isArray(payload.page.interactive)
              ? payload.page.interactive.length
              : 0,
            missingLabels: payload.page.issues?.missingLabels ?? 0,
            title: payload.page.title ?? '',
          },
          usedFallback: result.usedFallback,
        },
      })
      return
    }

    sendJson(response, 404, { error: 'Route not found.' })
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unexpected server failure.',
    })
  }
})

server.listen(PORT, () => {
  console.log(`Voice Access Restyler server listening on http://127.0.0.1:${PORT}`)
  void warmAgentSdk()
})
