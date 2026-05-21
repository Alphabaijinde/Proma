/**
 * File-based handoff for Codex image generation.
 *
 * Proma cannot call Codex's built-in image tool directly. This creates a
 * stable request/output contract so a Codex session can consume requests and
 * place generated files where Proma can pick them up.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'

export interface CodexImageHandoffInput {
  prompt: string
  aspectRatio?: string
  imageSize?: string
  numberOfImages?: number
  referenceImagePaths?: string[]
  cwd?: string
  source: 'chat' | 'agent'
}

export interface CodexImageHandoffResult {
  requestId: string
  requestPath: string
  latestRequestPath: string
  outputDir: string
  expectedOutputPaths: string[]
  message: string
}

function clampImageCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(Math.round(value as number), 1), 4)
}

export function getCodexImageDropDir(): string {
  return join(getConfigDir(), 'codex-image-drop')
}

export function createCodexImageHandoffRequest(input: CodexImageHandoffInput): CodexImageHandoffResult {
  const dropDir = getCodexImageDropDir()
  const requestDir = join(dropDir, 'requests')
  const outputDir = join(dropDir, 'outputs')
  mkdirSync(requestDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })

  const requestId = randomUUID()
  const count = clampImageCount(input.numberOfImages)
  const expectedOutputPaths = Array.from({ length: count }, (_, index) =>
    join(outputDir, count === 1 ? `${requestId}.png` : `${requestId}-${index + 1}.png`),
  )
  const requestPath = join(requestDir, `${requestId}.json`)
  const latestRequestPath = join(dropDir, 'latest-request.json')
  const createdAt = new Date().toISOString()

  const request = {
    version: 1,
    status: 'pending',
    requestId,
    createdAt,
    source: input.source,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    imageSize: input.imageSize,
    numberOfImages: count,
    referenceImagePaths: input.referenceImagePaths ?? [],
    cwd: input.cwd,
    outputDir,
    expectedOutputPaths,
    instructions: [
      'Codex should generate the requested image(s) and write PNG files to expectedOutputPaths.',
      'After writing files, update this request status to completed if possible.',
    ],
  }

  const serialized = JSON.stringify(request, null, 2)
  writeFileSync(requestPath, serialized, 'utf-8')
  writeFileSync(latestRequestPath, serialized, 'utf-8')

  return {
    requestId,
    requestPath,
    latestRequestPath,
    outputDir,
    expectedOutputPaths,
    message: [
      '已创建 Codex 生图交接请求。',
      `requestId: ${requestId}`,
      `requestPath: ${requestPath}`,
      `expectedOutputPaths:\n${expectedOutputPaths.map((p) => `- ${p}`).join('\n')}`,
      '当前状态: pending。等 Codex 把图片写入 expectedOutputPaths 后，再继续使用这些文件。',
    ].join('\n'),
  }
}
