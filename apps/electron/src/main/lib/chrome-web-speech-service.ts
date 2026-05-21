/**
 * Chrome Web Speech bridge.
 *
 * Electron's bundled Chromium can expose SpeechRecognition but still fail with
 * "network" because the remote Google speech service is unavailable to Electron.
 * This bridge opens the same Web Speech API inside installed Google Chrome and
 * posts the transcript back to Proma over localhost.
 */

import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { VOICE_DICTATION_IPC_CHANNELS } from '../../types'
import type { ChromeWebSpeechStartInput, ChromeWebSpeechStartResult } from '../../types'
import { getMainWindow } from '../index'

interface ChromeSpeechSession {
  token: string
  language: string
  createdAt: number
  child?: ChildProcess
}

let server: Server | null = null
let serverPort = 0
const sessions = new Map<string, ChromeSpeechSession>()

const SESSION_TTL_MS = 10 * 60 * 1000
const SHOW_BRIDGE_WINDOW = process.env.PROMA_CHROME_WEB_SPEECH_SHOW_WINDOW === '1'

export async function startChromeWebSpeech(
  input: ChromeWebSpeechStartInput = {},
): Promise<ChromeWebSpeechStartResult> {
  const chromePath = findChromeExecutable()
  if (!chromePath) {
    throw new Error('Google Chrome was not found, so the Chrome Web Speech bridge cannot start')
  }

  await ensureServer()
  cleanupExpiredSessions()

  const token = randomBytes(18).toString('hex')
  const language = input.language || 'zh-CN'
  const url = `http://127.0.0.1:${serverPort}/?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(language)}&quiet=${SHOW_BRIDGE_WINDOW ? '0' : '1'}`
  const userDataDir = join(app.getPath('userData'), 'chrome-web-speech-profile')
  mkdirSync(userDataDir, { recursive: true })

  const args = [
    `--app=${url}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--disable-translate',
    '--use-fake-ui-for-media-stream',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ]

  if (SHOW_BRIDGE_WINDOW) {
    args.push('--window-size=520,300')
  } else {
    args.push(
      '--start-minimized',
      '--window-size=360,220',
      '--window-position=-32000,-32000',
    )
  }

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: !SHOW_BRIDGE_WINDOW,
  })
  child.unref()

  sessions.set(token, {
    token,
    language,
    createdAt: Date.now(),
    child,
  })

  return {
    success: true,
    message: 'Electron speech recognition is unavailable; Chrome Web Speech bridge was opened',
  }
}

function findChromeExecutable(): string | null {
  const candidates = [
    process.env.PROMA_CHROME_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean) as string[]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

async function ensureServer(): Promise<void> {
  if (server && serverPort > 0) return

  server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error('[Voice input] Chrome Web Speech bridge request failed:', error)
      writeJson(response, 500, { success: false, message: 'internal error' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject)
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Chrome Web Speech bridge failed to bind localhost'))
        return
      }
      serverPort = address.port
      resolve()
    })
  })
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)

  if (request.method === 'GET' && url.pathname === '/') {
    writeHtml(response, renderChromeSpeechPage(
      url.searchParams.get('token') ?? '',
      url.searchParams.get('lang') || 'zh-CN',
      url.searchParams.get('quiet') === '1',
    ))
    return
  }

  if (request.method === 'POST' && url.pathname === '/result') {
    const body = await readJsonBody(request)
    const token = typeof body.token === 'string' ? body.token : ''
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const session = sessions.get(token)
    if (!session) {
      writeJson(response, 404, { success: false, message: 'session not found' })
      return
    }

    if (text) {
      insertTextIntoProma(text)
    }
    sessions.delete(token)
    writeJson(response, 200, { success: true })
    return
  }

  if (request.method === 'POST' && url.pathname === '/error') {
    const body = await readJsonBody(request)
    const token = typeof body.token === 'string' ? body.token : ''
    const error = typeof body.error === 'string' ? body.error : 'unknown'
    const message = typeof body.message === 'string' ? body.message : ''
    if (sessions.has(token)) {
      console.error('[Voice input] Chrome Web Speech recognition failed:', error, message)
    }
    writeJson(response, 200, { success: true })
    return
  }

  writeJson(response, 404, { success: false, message: 'not found' })
}

function insertTextIntoProma(text: string): void {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return

  mainWindow.webContents.send(VOICE_DICTATION_IPC_CHANNELS.INSERT_TEXT, { text })
  mainWindow.show()
  mainWindow.focus()
}

function cleanupExpiredSessions(): void {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token)
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) return {}

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

function writeHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

function renderChromeSpeechPage(token: string, language: string, quiet: boolean): string {
  const tokenJson = JSON.stringify(token)
  const languageJson = JSON.stringify(language)
  const quietJson = JSON.stringify(quiet)

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Proma Chrome Web Speech</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #111;
      color: #f5f5f5;
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    main {
      width: min(440px, calc(100vw - 36px));
      display: grid;
      gap: 18px;
      text-align: center;
    }
    .mic {
      width: 82px;
      height: 82px;
      margin: 0 auto;
      border-radius: 50%;
      border: 0;
      display: grid;
      place-items: center;
      background: #dc2626;
      color: white;
      cursor: pointer;
      box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.35);
      transition: transform 160ms ease, background 160ms ease;
    }
    .mic:hover { transform: scale(1.04); background: #ef4444; }
    .mic.recording { animation: pulse 1.1s ease-in-out infinite; }
    .mic:disabled { cursor: default; opacity: 0.72; }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.42); }
      70% { box-shadow: 0 0 0 22px rgba(220, 38, 38, 0); }
      100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); }
    }
    h1 { margin: 0; font-size: 20px; font-weight: 650; }
    p { margin: 0; color: #b7b7b7; line-height: 1.55; }
    .status {
      min-height: 46px;
      padding: 12px 14px;
      border-radius: 10px;
      background: #1d1d1d;
      color: #d8d8d8;
      text-align: left;
      word-break: break-word;
    }
    svg { width: 34px; height: 34px; }
  </style>
</head>
<body>
  <main>
    <button id="start" class="mic" type="button" aria-label="Start voice input">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        <path d="M12 19v3"></path>
      </svg>
    </button>
    <div>
      <h1>Proma Voice Input</h1>
      <p>Using Google Chrome Web Speech API. The transcript will be inserted back into Proma.</p>
    </div>
    <div id="status" class="status">Starting speech recognition. If Chrome blocks autoplay, click the microphone above.</div>
  </main>
  <script>
    const token = ${tokenJson};
    const language = ${languageJson};
    const quiet = ${quietJson};
    const button = document.getElementById('start');
    const statusEl = document.getElementById('status');
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let started = false;
    let quietTimeout = quiet ? setTimeout(() => {
      post('/error', { error: 'timeout', message: 'Chrome Web Speech bridge timed out' });
      window.close();
    }, 120000) : null;

    function setStatus(text) {
      statusEl.textContent = text;
    }

    async function post(path, payload) {
      try {
        await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, ...payload }),
        });
      } catch {}
    }

    function resetButton() {
      button.disabled = false;
      button.classList.remove('recording');
    }

    function closeIfQuiet(delay = 700) {
      if (quietTimeout) {
        clearTimeout(quietTimeout);
        quietTimeout = null;
      }
      if (quiet) {
        setTimeout(() => window.close(), delay);
      }
    }

    function begin() {
      if (started) return;
      if (!Recognition) {
        setStatus('Current Chrome does not support Web Speech API.');
        closeIfQuiet();
        return;
      }

      started = true;
      button.disabled = true;
      button.classList.add('recording');
      setStatus('Listening...');

      recognition = new Recognition();
      recognition.lang = language || 'zh-CN';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = async (event) => {
        let text = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result && result.isFinal) {
            text += (result[0] && result[0].transcript) || '';
          }
        }
        text = text.trim();
        if (!text) {
          setStatus('No speech was recognized. Try again.');
          started = false;
          resetButton();
          closeIfQuiet();
          return;
        }
        setStatus('Recognized: ' + text);
        await post('/result', { text });
        setTimeout(() => window.close(), 700);
      };

      recognition.onerror = async (event) => {
        started = false;
        resetButton();
        const error = event && event.error ? event.error : 'unknown';
        const message = event && event.message ? event.message : '';
        setStatus('Chrome speech recognition failed: ' + error + (message ? ', ' + message : '') + '. Click the microphone to retry.');
        await post('/error', { error, message });
        closeIfQuiet();
      };

      recognition.onend = () => {
        if (!started) return;
        started = false;
        resetButton();
      };

      try {
        recognition.start();
      } catch (error) {
        started = false;
        resetButton();
        setStatus('Failed to start. Click the microphone to retry.');
        post('/error', { error: 'start-failed', message: String(error && error.message ? error.message : error) });
        closeIfQuiet();
      }
    }

    button.addEventListener('click', begin);
    setTimeout(begin, 250);
  </script>
</body>
</html>`
}
