import { randomUUID } from 'node:crypto'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter, AgentQueryInput, SDKMessage, SDKToolUseBlock } from '@proma/shared'
import { resolveCodexCliLaunch } from '../codex-cli'

export interface CodexAgentQueryOptions extends AgentQueryInput {
  additionalDirectories?: string[]
  sdkPermissionMode?: string
  resumeSessionId?: string
  onStderr?: (data: string) => void
  onSessionId?: (sdkSessionId: string) => void
  onModelResolved?: (model: string) => void
}

const activeProcesses = new Map<string, ChildProcessWithoutNullStreams>()

interface CodexExecEvent {
  type?: string
  thread_id?: string
  item?: CodexItem
  error?: { message?: string } | string
  message?: string
  usage?: CodexUsage
  [key: string]: unknown
}

interface CodexItem {
  id?: string
  type?: string
  item_type?: string
  text?: string
  message?: string
  reasoning?: string
  command?: string
  aggregated_output?: string
  output?: string
  exit_code?: number
  status?: string
  query?: string
  url?: string
  path?: string
  file_path?: string
  changes?: unknown
  todos?: unknown
  items?: unknown
  server?: string
  tool?: string
  name?: string
  input?: unknown
  arguments?: unknown
  result?: unknown
  error?: unknown
  [key: string]: unknown
}

interface CodexUsage {
  input_tokens?: number
  output_tokens?: number
  cached_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

interface QueueWaiter<T> {
  resolve: (result: IteratorResult<T>) => void
  reject: (error: unknown) => void
}

interface AsyncQueue<T> extends AsyncIterable<T> {
  push: (value: T) => void
  close: () => void
  fail: (error: unknown) => void
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = []
  const waiters: QueueWaiter<T>[] = []
  let closed = false
  let failure: unknown

  const next = (): Promise<IteratorResult<T>> => {
    if (values.length > 0) {
      return Promise.resolve({ value: values.shift()!, done: false })
    }
    if (failure) return Promise.reject(failure)
    if (closed) {
      return Promise.resolve({ value: undefined as T, done: true })
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      waiters.push({ resolve, reject })
    })
  }

  return {
    push(value: T) {
      if (closed || failure) return
      const waiter = waiters.shift()
      if (waiter) {
        waiter.resolve({ value, done: false })
      } else {
        values.push(value)
      }
    },
    close() {
      if (closed || failure) return
      closed = true
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as T, done: true })
      }
    },
    fail(error: unknown) {
      if (closed || failure) return
      failure = error
      while (waiters.length > 0) {
        waiters.shift()!.reject(error)
      }
    },
    [Symbol.asyncIterator]() {
      return { next }
    },
  }
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function sanitizeMcpToolName(server?: string, tool?: string): string {
  const clean = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')
  if (server && tool) return `mcp__${clean(server)}__${clean(tool)}`
  if (tool) return clean(tool)
  return 'mcp_tool_call'
}

function resultTextForItem(item: CodexItem): string {
  const candidates = [
    item.aggregated_output,
    item.output,
    item.result,
    item.error,
    item.changes,
    item.todos,
    item.items,
  ]
  for (const candidate of candidates) {
    const text = stringifyValue(candidate).trim()
    if (text) return text
  }
  return ''
}

function isErrorStatus(item: CodexItem): boolean {
  if (typeof item.exit_code === 'number' && item.exit_code !== 0) return true
  const status = asString(item.status)?.toLowerCase()
  return status === 'failed' || status === 'error' || status === 'cancelled'
}

function codexItemType(item: CodexItem): string | undefined {
  return asString(item.type) || asString(item.item_type)
}

function usageFromCodex(usage?: CodexUsage): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? usage?.cached_input_tokens,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens,
    },
  } as SDKMessage
}

function classifyCodexError(rawMessage: string, previousErrors: string[]): {
  errorType: string
  title: string
  message: string
  details: string[]
} {
  const combined = `${previousErrors.join('\n')}\n${rawMessage}`.trim()
  if (/401 Unauthorized|Missing bearer|Not logged in|authentication/i.test(combined)) {
    return {
      errorType: 'authentication_failed',
      title: 'Codex CLI 未登录',
      message: 'Codex CLI 当前未登录或凭证无效。请先运行 codex login --device-auth，或用 codex login --with-api-key 写入有效 API Key。',
      details: [rawMessage],
    }
  }
  if (/stream disconnected|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket/i.test(combined)) {
    return {
      errorType: 'unknown_error',
      title: 'Codex CLI 网络异常',
      message: rawMessage || 'Codex CLI 与 OpenAI 服务连接中断。',
      details: previousErrors.slice(-5),
    }
  }
  return {
    errorType: 'unknown_error',
    title: 'Codex CLI 执行失败',
    message: rawMessage || 'Codex CLI 执行失败。',
    details: previousErrors.slice(-5),
  }
}

function codexItemToToolUse(item: CodexItem): SDKToolUseBlock | null {
  const id = item.id || randomUUID()
  const itemType = codexItemType(item)
  switch (itemType) {
    case 'command_execution': {
      return {
        type: 'tool_use',
        id,
        name: 'Bash',
        input: {
          command: asString(item.command) || '',
          codexItemType: itemType,
        },
      }
    }
    case 'web_search': {
      return {
        type: 'tool_use',
        id,
        name: 'WebSearch',
        input: {
          query: asString(item.query) || asString(item.text) || '',
          codexItemType: itemType,
        },
      }
    }
    case 'file_change': {
      const filePath = asString(item.file_path) || asString(item.path) || 'unknown'
      return {
        type: 'tool_use',
        id,
        name: 'Edit',
        input: {
          file_path: filePath,
          changes: item.changes,
          codexItemType: itemType,
        },
      }
    }
    case 'plan_update':
    case 'todo_list': {
      return {
        type: 'tool_use',
        id,
        name: 'TodoWrite',
        input: {
          todos: Array.isArray(item.todos) ? item.todos : item.items,
          codexItemType: itemType,
        },
      }
    }
    case 'collab_tool_call':
    case 'mcp_tool_call': {
      const server = asString(item.server)
      const tool = asString(item.tool) || asString(item.name)
      return {
        type: 'tool_use',
        id,
        name: sanitizeMcpToolName(server, tool),
        input: {
          server,
          tool,
          input: item.input ?? item.arguments,
          codexItemType: itemType,
        },
      }
    }
    default:
      return null
  }
}

function forceKillProcess(pid: number): void {
  try {
    process.kill(pid, 0)
  } catch {
    return
  }

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // Process may already have exited.
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}

export class CodexAgentAdapter implements AgentProviderAdapter {
  abort(sessionId: string): void {
    const child = activeProcesses.get(sessionId)
    if (!child) return

    activeProcesses.delete(sessionId)
    if (child.pid) {
      forceKillProcess(child.pid)
    } else {
      child.kill()
    }
  }

  dispose(): void {
    for (const [sessionId] of activeProcesses) {
      this.abort(sessionId)
    }
    activeProcesses.clear()
  }

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as CodexAgentQueryOptions
    const model = options.model || 'gpt-5.5'
    let codexSessionId = options.resumeSessionId?.startsWith('019')
      ? options.resumeSessionId
      : `codex-${options.sessionId}`
    const outputFile = join(tmpdir(), `proma-codex-${options.sessionId}-${Date.now()}.txt`)
    const launch = resolveCodexCliLaunch()
    const sandboxMode = options.sdkPermissionMode === 'plan'
      ? 'read-only'
      : options.sdkPermissionMode === 'bypassPermissions'
        ? 'danger-full-access'
        : 'workspace-write'
    const isRealCodexSessionId = (value: string | undefined): value is string =>
      typeof value === 'string' && /^019[0-9a-f-]+$/i.test(value)
    const resumeSessionId = isRealCodexSessionId(options.resumeSessionId)
      ? options.resumeSessionId
      : undefined

    options.onModelResolved?.(model)

    const args = [
      ...launch.argsPrefix,
      '-a',
      'never',
      'exec',
      ...(resumeSessionId ? ['resume'] : []),
      '--json',
      '--skip-git-repo-check',
      '-m',
      model,
      '--output-last-message',
      outputFile,
    ]

    if (resumeSessionId) {
      args.push(resumeSessionId)
    } else {
      args.push('--color', 'never')
      args.push('--sandbox', sandboxMode)
      args.push('-C', options.cwd || process.cwd())

      for (const dir of options.additionalDirectories ?? []) {
        args.push('--add-dir', dir)
      }
    }

    args.push('-')

    const queue = createAsyncQueue<SDKMessage>()
    const child = spawn(launch.command, args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    activeProcesses.set(options.sessionId, child)

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const plainStdoutLines: string[] = []
    const previousErrors: string[] = []
    const emittedToolIds = new Set<string>()
    let stdoutBuffer = ''
    let initEmitted = false
    let sawTextAssistantContent = false
    let sawResult = false
    let failed = false

    const ensureInit = () => {
      if (initEmitted) return
      initEmitted = true
      options.onSessionId?.(codexSessionId)
      queue.push({
        type: 'system',
        subtype: 'init',
        session_id: codexSessionId,
        model,
        provider: 'codex-cli',
      } as SDKMessage)
    }

    const emitAssistant = (content: Array<Record<string, unknown>>, options?: { textContent?: boolean }) => {
      ensureInit()
      if (options?.textContent) sawTextAssistantContent = true
      queue.push({
        type: 'assistant',
        message: {
          content,
          model,
        },
        parent_tool_use_id: null,
        session_id: codexSessionId,
        uuid: randomUUID(),
      } as SDKMessage)
    }

    const emitToolUse = (toolUse: SDKToolUseBlock) => {
      if (emittedToolIds.has(toolUse.id)) return
      emittedToolIds.add(toolUse.id)
      emitAssistant([toolUse as unknown as Record<string, unknown>])
    }

    const emitToolResult = (item: CodexItem) => {
      if (!item.id || !emittedToolIds.has(item.id)) return
      const result = resultTextForItem(item)
      queue.push({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: item.id,
            content: result || (isErrorStatus(item) ? 'Codex tool failed.' : 'Codex tool completed.'),
            is_error: isErrorStatus(item),
          }],
        },
        parent_tool_use_id: null,
        session_id: codexSessionId,
        uuid: randomUUID(),
      } as SDKMessage)
    }

    const emitError = (rawMessage: string) => {
      if (failed) return
      failed = true
      const classified = classifyCodexError(stripAnsi(rawMessage).trim(), previousErrors)
      ensureInit()
      queue.push({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `${classified.title}: ${classified.message}` }],
          model,
        },
        parent_tool_use_id: null,
        session_id: codexSessionId,
        uuid: randomUUID(),
        error: { message: classified.message, errorType: classified.errorType },
        _errorTitle: classified.title,
        _errorDetails: classified.details.filter(Boolean),
        _errorCanRetry: classified.errorType !== 'authentication_failed',
        _errorActions: classified.errorType === 'authentication_failed'
          ? [{ key: 's', label: '打开设置', action: 'settings' }]
          : [{ key: 'r', label: '重试', action: 'retry' }],
      } as unknown as SDKMessage)
    }

    const handleCodexItem = (item: CodexItem, completed: boolean) => {
      const itemType = codexItemType(item)
      if (itemType === 'agent_message' || itemType === 'assistant_message') {
        const text = asString(item.text) || resultTextForItem(item)
        if (text) emitAssistant([{ type: 'text', text }], { textContent: true })
        return
      }

      if (itemType === 'reasoning') {
        const thinking = asString(item.reasoning) || asString(item.text) || resultTextForItem(item)
        if (thinking) emitAssistant([{ type: 'thinking', thinking }])
        return
      }

      if (itemType === 'error') {
        const message = asString(item.message) || resultTextForItem(item)
        if (message) previousErrors.push(message)
        return
      }

      const toolUse = codexItemToToolUse(item)
      if (toolUse) {
        emitToolUse(toolUse)
        if (completed) emitToolResult(item)
      }
    }

    const handleCodexEvent = (event: CodexExecEvent) => {
      switch (event.type) {
        case 'thread.started': {
          if (event.thread_id) {
            codexSessionId = event.thread_id
          }
          ensureInit()
          break
        }
        case 'turn.started': {
          ensureInit()
          break
        }
        case 'item.started':
        case 'item.updated': {
          if (event.item) handleCodexItem(event.item, false)
          break
        }
        case 'item.completed': {
          if (event.item) handleCodexItem(event.item, true)
          break
        }
        case 'error': {
          const message = asString(event.message) || stringifyValue(event.error)
          if (message) previousErrors.push(message)
          break
        }
        case 'turn.failed': {
          const message = typeof event.error === 'string'
            ? event.error
            : event.error?.message || asString(event.message) || 'Codex CLI turn failed.'
          emitError(message)
          break
        }
        case 'turn.completed': {
          ensureInit()
          sawResult = true
          const resultMessage = usageFromCodex(event.usage)
          queue.push({
            ...resultMessage,
            session_id: codexSessionId,
          } as SDKMessage)
          break
        }
        default:
          break
      }
    }

    const handleStdoutLine = (rawLine: string) => {
      const line = stripAnsi(rawLine).trim()
      if (!line) return
      try {
        handleCodexEvent(JSON.parse(line) as CodexExecEvent)
      } catch {
        plainStdoutLines.push(line)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const data = chunk.toString('utf8')
      stdoutChunks.push(data)
      stdoutBuffer += data
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex)
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        handleStdoutLine(line)
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })
    child.stdout.on('end', () => {
      if (stdoutBuffer.trim()) {
        handleStdoutLine(stdoutBuffer)
        stdoutBuffer = ''
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const data = chunk.toString('utf8')
      stderrChunks.push(data)
      options.onStderr?.(data)
    })

    try {
      child.stdin.end(options.prompt)
    } catch {
      // The process may have exited before stdin was writable.
    }

    const exitPromise = waitForExit(child)
      .then((code) => {
        if (stdoutBuffer.trim()) {
          handleStdoutLine(stdoutBuffer)
          stdoutBuffer = ''
        }
      const stdout = stripAnsi(stdoutChunks.join('')).trim()
      const stderr = stripAnsi(stderrChunks.join('')).trim()
      const lastMessage = existsSync(outputFile)
        ? readFileSync(outputFile, 'utf8').trim()
        : ''
        const text = lastMessage || plainStdoutLines.join('\n').trim()
      const combinedOutput = `${stderr}\n${stdout}`.trim()

        if (code !== 0 || (!lastMessage && /(401 Unauthorized|Not logged in|ERROR:|stream disconnected before completion)/i.test(combinedOutput))) {
          emitError(combinedOutput || `Codex CLI exited with code ${code}`)
        } else {
          if (!sawTextAssistantContent && text) {
            emitAssistant([{ type: 'text', text }], { textContent: true })
          }
          if (!sawResult && !failed) {
            queue.push({
              type: 'result',
              subtype: 'success',
              usage: {
                input_tokens: 0,
                output_tokens: 0,
              },
              session_id: codexSessionId,
            } as SDKMessage)
          }
      }
        queue.close()
      })
      .catch((error) => queue.fail(error))
      .finally(() => {
      activeProcesses.delete(options.sessionId)
      try {
        if (existsSync(outputFile)) unlinkSync(outputFile)
      } catch {
        // Best-effort cleanup of the temp output file.
      }
      })

    try {
      for await (const message of queue) {
        yield message
      }
      await exitPromise
    } finally {
      this.abort(options.sessionId)
      await exitPromise.catch(() => {})
    }
  }
}
