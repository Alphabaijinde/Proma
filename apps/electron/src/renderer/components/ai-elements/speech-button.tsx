/**
 * AI Elements - 语音输入按钮
 *
 * Windows 下沿用早期 Proma 的 Electron/Chromium Web Speech API。
 * 注意：recognition.start() 必须直接在点击调用栈内执行，避免异步 IPC 或定时器打断 Chromium 的用户手势判断。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { MicIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { VoiceDictationSettings } from '../../../types'

const MISSING_CREDENTIALS_MESSAGE = '请先在设置 > 语音输入中填写 APP ID、Access Token 和 Resource ID'
const VOICE_DICTATION_INSERT_EVENT = 'proma:insert-voice-dictation-text'
const VOICE_DICTATION_SETTINGS_UPDATED_EVENT = 'proma:voice-dictation-settings-updated'
const CHROME_WEB_SPEECH_BRIDGE_ERRORS = new Set(['network', 'service-not-allowed'])

interface SpeechRecognitionInstance extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives?: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionResultEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionResultList {
  length: number
  item: (index: number) => SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  length: number
  item: (index: number) => SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

function getSpeechRecognition(): (new () => SpeechRecognitionInstance) | null {
  const win = window as unknown as Record<string, unknown>
  return (win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionInstance)
    | null
}

function hasVoiceDictationCredentials(settings: VoiceDictationSettings): boolean {
  return Boolean(settings.appId && settings.accessToken && settings.resourceId)
}

function getRecognitionLanguage(settings: VoiceDictationSettings): string {
  return settings.language && settings.language !== 'auto' ? settings.language : 'zh-CN'
}

function focusPromaInput(): void {
  window.dispatchEvent(new CustomEvent('proma:focus-input'))
}

function getChromiumSpeechErrorMessage(error: string): string {
  switch (error) {
    case 'not-allowed':
      return '麦克风权限被拒绝，请在 Windows 隐私设置中允许 Proma 访问麦克风'
    case 'no-speech':
      return '没有识别到语音，请再试一次'
    case 'audio-capture':
      return '没有可用的麦克风输入，请检查系统录音设备'
    case 'network':
      return 'Electron 内置 Chromium 语音服务网络不可用'
    case 'service-not-allowed':
      return 'Electron 内置 Chromium 无法使用当前语音识别服务'
    case 'language-not-supported':
      return '当前识别语言不受 Electron 内置 Chromium 支持'
    default:
      return `Electron 内置 Chromium 语音识别失败：${error || '未知错误'}`
  }
}

function shouldUseChromeWebSpeechBridge(error: string): boolean {
  return CHROME_WEB_SPEECH_BRIDGE_ERRORS.has(error)
}

async function startChromeWebSpeechBridge(settings: VoiceDictationSettings): Promise<void> {
  const result = await window.electronAPI.startChromeWebSpeech({
    language: getRecognitionLanguage(settings),
    targetIsProma: true,
  })

  if (result.success) {
    toast.info('已启动 Chrome 语音桥接')
  } else {
    toast.error(result.message)
  }
}

async function insertTranscript(text: string, onTranscript?: (text: string) => void): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return

  if (onTranscript) {
    onTranscript(trimmed)
    return
  }

  const insertedByFocusedEditor = !window.dispatchEvent(new CustomEvent(VOICE_DICTATION_INSERT_EVENT, {
    cancelable: true,
    detail: { text: trimmed },
  }))
  if (insertedByFocusedEditor) return

  await window.electronAPI.commitVoiceDictation({ text: trimmed })
}

interface SpeechButtonProps {
  /** 识别结果回调；未传入时写回当前 Proma 输入框 */
  onTranscript?: (text: string) => void
  /** 是否禁用 */
  disabled?: boolean
  className?: string
}

export function SpeechButton({
  onTranscript,
  disabled = false,
  className,
}: SpeechButtonProps): React.ReactElement {
  const [isRecording, setIsRecording] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const settingsRef = useRef<VoiceDictationSettings | null>(null)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  useEffect(() => {
    let disposed = false

    window.electronAPI.getVoiceDictationSettings()
      .then((settings) => {
        if (disposed) return
        settingsRef.current = settings
        setSettingsLoaded(true)
      })
      .catch((error) => {
        console.error('[语音输入] 加载语音输入设置失败:', error)
        if (!disposed) setSettingsLoaded(true)
      })

    const handleSettingsUpdated = (event: Event): void => {
      const settings = (event as CustomEvent<VoiceDictationSettings>).detail
      if (!settings) return
      settingsRef.current = settings
      setSettingsLoaded(true)
    }

    window.addEventListener(VOICE_DICTATION_SETTINGS_UPDATED_EVENT, handleSettingsUpdated)

    return () => {
      disposed = true
      window.removeEventListener(VOICE_DICTATION_SETTINGS_UPDATED_EVENT, handleSettingsUpdated)
      recognitionRef.current?.abort()
      recognitionRef.current = null
    }
  }, [])

  const startChromiumWebSpeech = useCallback((settings: VoiceDictationSettings): void => {
    focusPromaInput()

    const SpeechRecognitionCtor = getSpeechRecognition()
    if (!SpeechRecognitionCtor) {
      void startChromeWebSpeechBridge(settings).catch((error) => {
        console.error('[语音输入] 启动 Chrome Web Speech 桥接失败:', error)
        toast.error('启动 Chrome Web Speech 桥接失败')
      })
      return
    }

    const recognition = new SpeechRecognitionCtor()
    recognition.lang = getRecognitionLanguage(settings)
    recognition.continuous = false
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      let transcript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result?.isFinal) {
          transcript += result[0]?.transcript ?? ''
        }
      }
      insertTranscript(transcript, onTranscriptRef.current).catch((error) => {
        console.error('[语音输入] 写入 Chromium 语音识别结果失败:', error)
        toast.error('写入语音识别结果失败')
      })
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('[语音输入] Chromium Web Speech 识别错误:', event.error, event.message)
      setIsRecording(false)
      recognitionRef.current = null

      if (shouldUseChromeWebSpeechBridge(event.error)) {
        void startChromeWebSpeechBridge(settings)
          .catch((error) => {
            console.error('[语音输入] 启动 Chrome Web Speech 桥接失败:', error)
            toast.error('启动 Chrome Web Speech 桥接失败')
          })
        return
      }

      toast.error(getChromiumSpeechErrorMessage(event.error))
    }

    recognition.onend = () => {
      setIsRecording(false)
      recognitionRef.current = null
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
      setIsRecording(true)
    } catch (error) {
      recognitionRef.current = null
      setIsRecording(false)
      console.error('[语音输入] 启动 Chromium Web Speech 失败:', error)
      toast.error('启动 Chromium 语音识别失败')
    }
  }, [])

  const handleClick = useCallback((): void => {
    const settings = settingsRef.current
    if (!settingsLoaded || !settings) {
      toast.info('语音输入设置仍在加载，请稍后再试')
      return
    }

    if (!settings.enabled) {
      toast.info('请先在设置中打开语音输入开关')
      return
    }

    if (settings.provider === 'chromium-web-speech') {
      if (isRecording) {
        recognitionRef.current?.stop()
        setIsRecording(false)
        return
      }
      startChromiumWebSpeech(settings)
      return
    }

    if (settings.provider === 'doubao' && !hasVoiceDictationCredentials(settings)) {
      toast.info(MISSING_CREDENTIALS_MESSAGE)
      return
    }

    void window.electronAPI.toggleVoiceDictation().catch((error) => {
      console.error('[语音输入] 唤起语音输入失败:', error)
      toast.error('唤起语音输入失败')
      setIsRecording(false)
    })
  }, [isRecording, settingsLoaded, startChromiumWebSpeech])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'relative size-8 transition-all duration-200 text-foreground/60 hover:text-foreground',
            isRecording && 'animate-pulse bg-red-500 text-white hover:bg-red-600',
            className
          )}
          onClick={handleClick}
          disabled={disabled}
        >
          <MicIcon className="size-4" />
          {isRecording && (
            <span className="absolute -right-1 -top-1 flex size-3">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-red-500" />
            </span>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{isRecording ? '停止录音' : '语音输入'}</p>
      </TooltipContent>
    </Tooltip>
  )
}
