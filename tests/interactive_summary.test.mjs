import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractInteractiveElements,
  formatWindowStateBody,
} from '../src/tool.js'

test('extractInteractiveElements extracts interactive roles with names and indices', () => {
  const tree = `
Window: "Sample App", App: sample.exe.
\t0 窗格 Root
\t\t1 菜单项 (collapsed) 文件(F) Secondary Actions: Expand
\t\t2 按钮 确定 Secondary Actions: Raise
\t\t3 文本 说明文字
\t\t4 编辑 (settable) 输入框 Value: test
\t\t5 复选框 (off) 记住密码
\t\t6 链接 帮助中心
\t\t7 按钮 关闭 Secondary Actions: Raise ID: close-btn
`
  const elems = extractInteractiveElements(tree)
  assert.equal(elems.length, 6)
  assert.deepEqual(elems.map(e => e.index), [1, 2, 4, 5, 6, 7])
  assert.equal(elems[1].role, '按钮')
  assert.equal(elems[1].name, '确定 Secondary Actions: Raise')
  assert.equal(elems[2].role, '编辑')
  assert.equal(elems[3].role, '复选框')
  assert.equal(elems[4].role, '链接')
})

test('formatWindowStateBody generates summary and trims excessive document_text', () => {
  const longDocText = 'A'.repeat(5000)
  const tree = `Window: "Sample", App: s.exe.\n\t0 窗格\n\t\t1 按钮 提交`
  const body = {
    accessibility: {
      tree,
      focused_element: 'The focused UI element is 1 按钮 提交.',
      document_text: longDocText,
    },
    cacheDiagnostics: { revision: 1 },
    screenshots: [],
    window: { app: 's.exe', id: 100 },
  }

  const formatted = formatWindowStateBody(body)
  // Verify summary header is present
  assert.match(formatted, /=== Interactive Elements \(1 found; use element_index with click\/set_value\) ===/)
  assert.match(formatted, /\[1\] 按钮 "提交"/)
  // Verify cacheDiagnostics is still present in JSON
  assert.match(formatted, /"cacheDiagnostics"/)
  // Verify document_text was trimmed and did not blow up payload
  assert.match(formatted, /document_text trimmed: 5000 total characters/)
  assert.ok(formatted.length < 2000, `formatted length ${formatted.length} should be compact (< 2000)`)
})

test('formatWindowStateBody passes non-accessibility payloads untouched', () => {
  const plain = { ok: true, count: 42 }
  const formatted = formatWindowStateBody(plain)
  assert.deepEqual(JSON.parse(formatted), plain)
})

test('click tool auto-resolves element_index by target text', async () => {
  const calls = []
  const registered = new Map()
  const fakeCtx = {
    dshComputerUse: {
      config: {},
      approved: new Set(),
      lastConversationId: null,
      tools: async () => ({
        tools: [
          { name: 'get_window_state', description: 'get_window_state', parameters: { type: 'object', properties: {} } },
          { name: 'click', description: 'click', parameters: { type: 'object', properties: {} } },
        ],
      }),
      call: async (name, args) => {
        calls.push({ name, args: { ...args } })
        if (name === 'get_window_state') {
          return {
            ok: true,
            value: {
              accessibility: {
                tree: 'Window: "WorkBuddy", App: WorkBuddy.exe.\n\t0 窗格\n\t\t99 按钮 成长计划 Secondary Actions: Raise\n\t\t100 按钮 立即前往 Secondary Actions: Raise',
              },
            },
          }
        }
        return { ok: true, value: {} }
      },
      currentTurnIdFor: () => 'turn-1',
      health: async () => ({ ok: true }),
    },
    on() { return () => {} },
    effect(fn) { fn() },
    get: () => undefined,
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
      },
    },
    systemPrompt: { section() {} },
  }

  const { apply: applyTools, Config: ToolConfig } = await import('../src/tool.js')
  await applyTools(fakeCtx, ToolConfig({ surfaces: ['computer'] }))

  // 1. Observe state
  const getStateTool = registered.get('get_window_state')
  assert.ok(getStateTool)
  await getStateTool.execute({ window: { app: 'WorkBuddy.exe', id: 1 }, include_text: true }, { agent: { id: 's' } })

  // 2. Click with text: "立即前往"
  const clickTool = registered.get('click')
  assert.ok(clickTool)
  await clickTool.execute({ window: { app: 'WorkBuddy.exe', id: 1 }, text: '立即前往' }, { agent: { id: 's' } })

  // Verify that the call dispatched to helper had element_index = 100 and no text property
  const lastCall = calls[calls.length - 1]
  assert.equal(lastCall.name, 'click')
  assert.equal(lastCall.args.element_index, 100)
  assert.equal(lastCall.args.text, undefined)
})

