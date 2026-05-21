const { app, safeStorage } = require('electron')
const { spawnSync } = require('node:child_process')
const { createDecipheriv } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHANNEL_ID = 'f939377f-a788-45e6-944b-b9be56cc7d51'
const APPDATA = process.env.APPDATA || app.getPath('appData')
const COMMERCIAL_USER_DATA = path.join(APPDATA, '@proma', 'electron')
const DEV_USER_DATA = path.join(APPDATA, '@proma', 'electron-dev')
const COMMERCIAL_CHANNELS = path.join(os.homedir(), '.proma', 'channels.json')
const DEV_CHANNELS = path.join(os.homedir(), '.proma-dev', 'channels.json')
const PLACEHOLDER_KEY = 'reenter-azure-api-key'

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function findChannel(config, channelId) {
  return config.channels.find((channel) => channel.id === channelId)
}

function decryptDpapiBlob(blob) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$inputText = [Console]::In.ReadToEnd()',
    '$blob = [Convert]::FromBase64String($inputText)',
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($plain))',
  ].join('; ')

  const child = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    input: blob.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (child.status !== 0) {
    throw new Error(`DPAPI decrypt failed: ${child.stderr || child.stdout}`)
  }

  return Buffer.from(child.stdout.trim(), 'base64')
}

function readChromiumMasterKey(userDataPath) {
  const localStatePath = path.join(userDataPath, 'Local State')
  const localState = readJson(localStatePath)
  const encryptedKey = localState.os_crypt && localState.os_crypt.encrypted_key
  if (!encryptedKey) {
    throw new Error(`Local State has no os_crypt.encrypted_key: ${localStatePath}`)
  }

  const raw = Buffer.from(encryptedKey, 'base64')
  if (raw.subarray(0, 5).toString('utf8') !== 'DPAPI') {
    throw new Error(`Unsupported Chromium key prefix in ${localStatePath}`)
  }

  return decryptDpapiBlob(raw.subarray(5))
}

function decryptChromiumString(encryptedBase64, userDataPath) {
  const raw = Buffer.from(encryptedBase64, 'base64')

  if (raw.subarray(0, 3).toString('utf8') !== 'v10') {
    return decryptDpapiBlob(raw).toString('utf8')
  }

  const key = readChromiumMasterKey(userDataPath)
  const iv = raw.subarray(3, 15)
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(15, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

async function runChild() {
  app.setPath('userData', DEV_USER_DATA)
  await app.whenReady()

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is not available in dev profile')
  }

  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const plainKey = process.argv.includes('--placeholder')
    ? PLACEHOLDER_KEY
    : Buffer.concat(chunks).toString('utf8')
  if (!plainKey) throw new Error('No API key received on stdin')

  const encryptedKey = safeStorage.encryptString(plainKey).toString('base64')
  const config = readJson(DEV_CHANNELS)
  const channel = findChannel(config, CHANNEL_ID)
  if (!channel) throw new Error(`Dev channel not found: ${CHANNEL_ID}`)

  const backupPath = `${DEV_CHANNELS}.bak.api-key-migrate`
  fs.copyFileSync(DEV_CHANNELS, backupPath)
  channel.apiKey = encryptedKey
  channel.updatedAt = Date.now()
  writeJson(DEV_CHANNELS, config)

  console.log(JSON.stringify({
    ok: true,
    channelId: CHANNEL_ID,
    encryptedLength: encryptedKey.length,
    userData: app.getPath('userData'),
    backupPath,
  }))
}

async function runParent() {
  app.setPath('userData', COMMERCIAL_USER_DATA)
  await app.whenReady()

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is not available in commercial profile')
  }

  const config = readJson(COMMERCIAL_CHANNELS)
  const channel = findChannel(config, CHANNEL_ID)
  if (!channel) throw new Error(`Commercial channel not found: ${CHANNEL_ID}`)

  const plainKey = decryptChromiumString(channel.apiKey, COMMERCIAL_USER_DATA)
  if (!plainKey) throw new Error('Commercial channel API key decrypted to empty string')

  const child = spawnSync(process.execPath, [__filename, '--child'], {
    input: plainKey,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (child.status !== 0) {
    throw new Error(`Child re-encryption failed: ${child.stderr || child.stdout}`)
  }

  const result = JSON.parse(child.stdout)
  console.log(JSON.stringify({
    ok: true,
    sourceUserData: app.getPath('userData'),
    targetUserData: result.userData,
    channelId: result.channelId,
    encryptedLength: result.encryptedLength,
    backupPath: result.backupPath,
  }, null, 2))
}

const main = process.argv.includes('--child') ? runChild : runParent

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    app.quit()
  })
