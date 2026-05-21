/**
 * Nano Banana credential resolution shared by Chat, Agent MCP and settings tests.
 */

import { getToolCredentials } from '../chat-tool-config'

export const NANO_BANANA_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
export const NANO_BANANA_DEFAULT_MODEL = 'gemini-3.1-flash-image-preview'

const API_KEY_ENV_NAMES = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
] as const

const BASE_URL_ENV_NAMES = [
  'GEMINI_BASE_URL',
  'GOOGLE_GENERATIVE_AI_BASE_URL',
] as const

const MODEL_ENV_NAMES = [
  'GEMINI_IMAGE_MODEL',
  'NANO_BANANA_MODEL',
] as const

export interface NanoBananaCredentials {
  apiKey: string
  baseUrl: string
  model: string
  apiKeySource: 'config' | 'env' | 'missing'
  apiKeyEnvName?: string
  cloudModeRequested: boolean
}

function firstEnvValue(names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return { name, value }
  }
  return undefined
}

function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes'
}

export function resolveNanoBananaCredentials(): NanoBananaCredentials {
  const credentials = getToolCredentials('nano-banana')
  const configuredApiKey = credentials.apiKey?.trim()
  const envApiKey = firstEnvValue(API_KEY_ENV_NAMES)
  const envBaseUrl = firstEnvValue(BASE_URL_ENV_NAMES)
  const envModel = firstEnvValue(MODEL_ENV_NAMES)

  const apiKey = configuredApiKey || envApiKey?.value || ''

  return {
    apiKey,
    baseUrl: credentials.baseUrl?.trim() || envBaseUrl?.value || NANO_BANANA_DEFAULT_BASE_URL,
    model: credentials.model?.trim() || envModel?.value || NANO_BANANA_DEFAULT_MODEL,
    apiKeySource: configuredApiKey ? 'config' : envApiKey ? 'env' : 'missing',
    apiKeyEnvName: configuredApiKey ? undefined : envApiKey?.name,
    cloudModeRequested: isTruthy(credentials.cloudMode) || isTruthy(credentials.useCloud),
  }
}

export function isNanoBananaConfigured(): boolean {
  return !!resolveNanoBananaCredentials().apiKey
}

export function getNanoBananaMissingKeyMessage(credentials = resolveNanoBananaCredentials()): string {
  const envNames = API_KEY_ENV_NAMES.join(' / ')
  const cloudNote = credentials.cloudModeRequested
    ? '\n检测到 cloudMode/useCloud 配置，但源码本地运行没有内置云端生图代理，需要本地 API Key。'
    : ''

  return [
    'Nano Banana 生图工具未配置 API Key，暂时不能生成图片。',
    cloudNote,
    `请在「设置 -> 工具 -> Nano Banana」填写 Gemini API Key，或设置环境变量 ${envNames} 后重启 Proma。`,
  ].filter(Boolean).join('\n')
}
