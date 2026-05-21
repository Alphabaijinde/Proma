const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const APPDATA = process.env.APPDATA || app.getPath('appData')
const DEV_USER_DATA = path.join(APPDATA, '@proma', 'electron-dev')
const DEV_CHANNELS = path.join(os.homedir(), '.proma-dev', 'channels.json')
const LOCAL_PROXY_BASE_URL = 'http://127.0.0.1:8787/v1'
const GPT54_CHANNEL_ID = 'f939377f-a788-45e6-944b-b9be56cc7d51'

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function encryptKey(plainKey) {
  if (!plainKey) throw new Error('Missing Azure API key environment variable')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage is not available')
  return safeStorage.encryptString(plainKey).toString('base64')
}

function upsertChannel(config, target) {
  let channel = config.channels.find((item) => item.id === target.id || item.name === target.name)
  const now = Date.now()
  if (!channel) {
    channel = { id: target.id || randomUUID(), createdAt: now }
    config.channels.push(channel)
  }

  Object.assign(channel, {
    name: target.name,
    provider: 'anthropic',
    baseUrl: LOCAL_PROXY_BASE_URL,
    apiKey: target.encryptedApiKey,
    models: target.models,
    enabled: true,
    updatedAt: now,
  })
}

async function main() {
  app.setPath('userData', DEV_USER_DATA)
  await app.whenReady()

  const config = readJson(DEV_CHANNELS)
  if (!Array.isArray(config.channels)) config.channels = []

  const backupPath = `${DEV_CHANNELS}.bak.azure-channels-${Date.now()}`
  fs.copyFileSync(DEV_CHANNELS, backupPath)

  upsertChannel(config, {
    id: GPT54_CHANNEL_ID,
    name: 'azure-openai-gpt-5.4',
    encryptedApiKey: encryptKey(process.env.AZURE_GPT54_KEY),
    models: [{ id: 'claude-sonnet-4-6', name: 'Azure OpenAI GPT-5.4', enabled: true }],
  })

  upsertChannel(config, {
    name: 'azure-openai-gpt-5.4-pro',
    encryptedApiKey: encryptKey(process.env.AZURE_GPT54_PRO_KEY),
    models: [{ id: 'claude-opus-4-6', name: 'Azure OpenAI GPT-5.4 Pro', enabled: true }],
  })

  writeJson(DEV_CHANNELS, config)
  console.log(JSON.stringify({
    ok: true,
    backupPath,
    configuredChannels: ['azure-openai-gpt-5.4', 'azure-openai-gpt-5.4-pro'],
  }, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    app.quit()
  })
