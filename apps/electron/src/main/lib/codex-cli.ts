import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CodexCliLaunch {
  command: string
  argsPrefix: string[]
  displayCommand: string
}

function npmGlobalDir(): string | null {
  const appData = process.env.APPDATA
  if (process.platform === 'win32' && appData) {
    return join(appData, 'npm')
  }
  return null
}

function nodeCommand(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

export function resolveCodexCliLaunch(): CodexCliLaunch {
  const configured = process.env.PROMA_CODEX_CLI_PATH?.trim()
  if (configured) {
    if (configured.endsWith('.js')) {
      return {
        command: nodeCommand(),
        argsPrefix: [configured],
        displayCommand: `node ${configured}`,
      }
    }
    if (process.platform === 'win32' && configured.endsWith('.cmd')) {
      return {
        command: 'cmd.exe',
        argsPrefix: ['/d', '/s', '/c', configured],
        displayCommand: configured,
      }
    }
    return {
      command: configured,
      argsPrefix: [],
      displayCommand: configured,
    }
  }

  const npmDir = npmGlobalDir()
  if (npmDir) {
    const codexJs = join(npmDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (existsSync(codexJs)) {
      return {
        command: nodeCommand(),
        argsPrefix: [codexJs],
        displayCommand: `node ${codexJs}`,
      }
    }

    const codexCmd = join(npmDir, 'codex.cmd')
    if (existsSync(codexCmd)) {
      return {
        command: 'cmd.exe',
        argsPrefix: ['/d', '/s', '/c', codexCmd],
        displayCommand: codexCmd,
      }
    }
  }

  return process.platform === 'win32'
    ? { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', 'codex.cmd'], displayCommand: 'codex.cmd' }
    : { command: 'codex', argsPrefix: [], displayCommand: 'codex' }
}
