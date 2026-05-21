import type { AgentProviderAdapter, AgentQueryInput, SDKMessage, SDKUserMessageInput } from '@proma/shared'
import { ClaudeAgentAdapter } from './claude-agent-adapter'
import { CodexAgentAdapter } from './codex-agent-adapter'

export class RoutingAgentAdapter implements AgentProviderAdapter {
  private readonly claude = new ClaudeAgentAdapter()
  private readonly codex = new CodexAgentAdapter()
  private readonly activeAdapters = new Map<string, AgentProviderAdapter>()

  private adapterFor(input: AgentQueryInput): AgentProviderAdapter {
    return input.provider === 'codex-cli' ? this.codex : this.claude
  }

  private activeAdapter(sessionId: string): AgentProviderAdapter | undefined {
    return this.activeAdapters.get(sessionId)
  }

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const adapter = this.adapterFor(input)
    this.activeAdapters.set(input.sessionId, adapter)
    try {
      yield* adapter.query(input)
    } finally {
      this.activeAdapters.delete(input.sessionId)
    }
  }

  abort(sessionId: string): void {
    const adapter = this.activeAdapter(sessionId)
    if (adapter) {
      adapter.abort(sessionId)
      this.activeAdapters.delete(sessionId)
      return
    }

    this.claude.abort(sessionId)
    this.codex.abort(sessionId)
  }

  async interruptQuery(sessionId: string): Promise<void> {
    const adapter = this.activeAdapter(sessionId)
    if (adapter?.interruptQuery) {
      await adapter.interruptQuery(sessionId)
    }
  }

  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const adapter = this.activeAdapter(sessionId)
    if (!adapter?.sendQueuedMessage) {
      throw new Error('[Agent adapter] Current provider does not support queued messages')
    }
    await adapter.sendQueuedMessage(sessionId, message)
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    const adapter = this.activeAdapter(sessionId)
    if (adapter?.cancelQueuedMessage) {
      await adapter.cancelQueuedMessage(sessionId, messageUuid)
    }
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const adapter = this.activeAdapter(sessionId)
    if (adapter?.setPermissionMode) {
      await adapter.setPermissionMode(sessionId, mode)
    }
  }

  dispose(): void {
    this.claude.dispose()
    this.codex.dispose()
    this.activeAdapters.clear()
  }
}
