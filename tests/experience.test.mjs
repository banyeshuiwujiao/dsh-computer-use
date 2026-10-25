// Derived paths only: no machine-specific absolute path belongs in a tracked script.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const codexApp = path.join(localAppData, 'OpenAI', 'Codex')

/**
 * Experience-layer gates (P0 + P1 + P2).
 *
 * Domain-level and desktop-free: the layer is pure JavaScript, so these run from the
 * harness checkout like the plugin contract tests:
 *
 *   cd <harness-checkout>
 *   node --import tsx/esm --test tests/experience.test.mjs
 *
 * Deliberately NOT part of parity/verify-all.ps1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ComputerUseService from '../src/index.js'
import { Config as ToolConfig, apply as applyTools, EXPERIENCE_TOOL_NAME } from '../src/tool.js'
import { ExperienceStore, formatDigest, observationFor } from '../src/experience.js'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DESKTOP_13 = [
  'list_windows', 'get_window', 'list_apps', 'launch_app', 'get_window_state', 'click',
  'press_key', 'type_text', 'scroll', 'set_value', 'drag', 'perform_secondary_action', 'activate_window',
].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }))

const WINDOW = {
  window: { app: 'blender.exe', id: 1, title: 'Blender' },
  screenshots: [{ id: 's1', originX: -11, originY: -11, width: 1707, height: 919 }],
  accessibility: null,
  cacheDiagnostics: { accessibilityRevision: 1, accessibilitySnapshotCount: 1, captureCachedSessionCount: 1 },
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cu-exp-'))
}

/** A store isolated in a temp directory, with the shipped seed explicitly absent. */
function tempStore(config = {}) {
  const dir = tempDir()
  const store = new ExperienceStore({ ...config }, { dir, seedPath: path.join(dir, 'no-seed.jsonl') })
  return { dir, store }
}

/** The preset-plane row over a mock host service, exactly like contracts.test.mjs. */
function makeHarness(options = {}) {
  const registered = new Map()
  const calls = []
  const dshComputerUse = {
    config: {},
    approved: new Set(),
    lastConversationId: null,
    experience: options.experience,
    tools: async surface => {
      if (surface === 'browser') return { tools: options.browserTools || [] }
      if (surface === 'computer') return { tools: options.desktopTools || DESKTOP_13 }
      return { tools: DESKTOP_13.concat([{ name: 'batch_actions', description: 'batch', parameters: {} }]) }
    },
    call: async (name, args, signal, meta) => {
      calls.push({ name, args, meta })
      if (options.onCall) return options.onCall(name, args, meta)
      return { ok: true, value: WINDOW }
    },
    health: async () => ({ ok: true, codexRequired: false, backend: 'fake', surface: 'computer' }),
    releaseOverlay: async () => ({ ok: true }),
    shutdownSidecar: async () => {},
  }
  const ctx = {
    dshComputerUse,
    on() { return () => {} },
    effect(fn) { fn() },
    get() { return undefined },
    tools: { register(tool) { registered.set(tool.name, tool) } },
    systemPrompt: { section() {} },
  }
  return { ctx, dshComputerUse, registered, calls }
}

const EXEC = { agent: { id: 'session-exp' }, callId: 'call-1' }

test('EXP-1 a recorded note lands in lessons.jsonl and in a readable lessons.md', () => {
  const { dir, store } = tempStore()
  try {
    const result = store.record({
      app: 'blender.exe',
      symptom: 'accessibility was null in 11 of 13 observations',
      context: 'maximized window, 150% scaling',
      cause: 'the viewport is self-drawn, so UIA exposes no control tree',
      workaround: 'use the app scripting interface instead of pixel clicking',
      outcome: 'partial',
      tags: ['ax-empty', 'dpi-150'],
    })
    assert.equal(result.created, true)
    assert.match(result.entry.date, /^\d{4}-\d{2}-\d{2}$/, 'the note carries the date it happened')
    const lines = fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, 'one JSONL record per note')
    const md = fs.readFileSync(path.join(dir, 'lessons.md'), 'utf8')
    assert.match(md, /accessibility was null in 11 of 13 observations/)
    assert.match(md, /workaround: use the app scripting interface instead of pixel clicking/)
    assert.match(md, /Reference only/, 'the human-readable view states the advisory contract')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-2 the same symptom merges instead of piling up, whatever the tags say', () => {
  const { dir, store } = tempStore()
  try {
    store.record({ app: 'blender.exe', symptom: 'no accessibility tree', cause: 'self-drawn UI', outcome: 'partial', tags: ['ax-empty'] })
    const second = store.record({ app: 'Blender', symptom: 'no accessibility tree', workaround: 'script it', outcome: 'partial', tags: ['dpi-150'] })
    assert.equal(second.created, false)
    assert.equal(second.merged, true)
    assert.equal(second.entry.seenCount, 2)
    assert.deepEqual(second.entry.tags.sort(), ['ax-empty', 'dpi-150'])
    assert.equal(fs.readFileSync(path.join(dir, 'lessons.jsonl'), 'utf8').trim().split('\n').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-3 a note without a statement is refused; a statement alone is enough (V3)', () => {
  const { dir, store } = tempStore()
  try {
    assert.throws(() => store.record({ app: 'blender.exe', cause: 'because' }), /"statement" is required/)
    assert.throws(() => store.record({ symptom: 'no app', cause: 'c' }), /"app" is required/)
    assert.throws(
      () => store.record({ app: 'blender.exe', statement: 's', volatility: 'until-date' }),
      /until-date" needs an "expiresAt"/,
    )
    assert.equal(fs.existsSync(path.join(dir, 'lessons.jsonl')), false, 'a refused record writes nothing')
    const ok = store.record({ app: 'blender.exe', statement: 'self-drawn viewports expose no UIA tree' })
    assert.equal(ok.created, true, 'a statement alone is a valid note - cause/workaround are optional now')
    assert.equal(ok.entry.kind, 'pitfall', 'kind defaults to pitfall')
    assert.equal(ok.entry.volatility, 'durable', 'volatility defaults to durable')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-4 a stale or superseded note leaves the digest, and can be verified back in', () => {
  const { dir, store } = tempStore()
  try {
    const first = store.record({ app: 'blender.exe', symptom: 'clicks land 32px off', workaround: 'use element indexes', outcome: 'partial' })
    assert.equal(store.digest('blender', 'blender.exe').notes.length, 1)
    store.update(first.entry.id, { stale: true, outcome: 'failed' })
    const stale = store.digest('blender', 'blender.exe')
    assert.equal(stale.notes[0].stale, true, 'a stale note stays visible but labelled')
    const relaxed = new ExperienceStore({ includeStale: false }, { dir, seedPath: path.join(dir, 'no-seed.jsonl') })
    assert.equal(relaxed.digest('blender', 'blender.exe'), null, 'includeStale=false drops it entirely')
    store.update(first.entry.id, { verified: true })
    const verified = store.list({ app: 'blender.exe' }).entries[0]
    assert.equal(verified.stale, undefined)
    assert.equal(verified.seen, 2)
    store.update(first.entry.id, { supersededBy: 'some-other-note' })
    assert.equal(store.digest('blender', 'blender.exe'), null, 'a superseded note never injects again')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-5 the digest is app-scoped, bounded and explicitly advisory', () => {
  const { dir, store } = tempStore({ maxEntries: 3, maxChars: 900 })
  try {
    for (let index = 0; index < 5; index += 1) {
      store.record({
        app: 'blender.exe',
        symptom: 'symptom number ' + index + ' with a fairly long explanation of what was seen on screen',
        workaround: 'workaround number ' + index + ' which is also not short at all and keeps going for a while',
        outcome: 'partial',
        tags: ['tag-' + index],
      })
    }
    store.record({ app: 'notepad.exe', symptom: 'unrelated app problem', cause: 'unrelated', outcome: 'failed' })
    const digest = store.digest('blender', 'blender.exe')
    assert.equal(digest.advisory, true)
    assert.equal(digest.app, 'blender.exe')
    assert.ok(digest.notes.length <= 3, 'at most maxEntries notes')
    assert.ok(formatDigest(digest).length <= 900, 'the injected block respects maxChars')
    assert.match(formatDigest(digest), /ADVISORY ONLY/)
    assert.equal(store.digest('notepad', 'notepad.exe').app, 'notepad.exe')
    assert.equal(store.digest('unknown-app', 'unknown.exe'), null, 'no note and no pending means no digest')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-6 the tool plane injects the digest as its own block and never touches the payload', async () => {
  const { dir, store } = tempStore()
  try {
    const harness = makeHarness({
      experience: store,
      // Echo the app the call asked for, so an app without notes can be exercised too.
      onCall: (name, args) => {
        const app = String((args && args.window && args.window.app) || 'blender.exe')
        return { ok: true, value: { ...WINDOW, window: { app, id: 1 } } }
      },
    })
    await applyTools(harness.ctx, ToolConfig({}))
    const tool = harness.registered.get('get_window_state')
    store.record({ app: 'blender.exe', symptom: 'accessibility came back empty', workaround: 'use the scripting interface', outcome: 'partial' })

    const clean = await tool.execute({ window: { app: 'notepad.exe', id: 2 }, include_text: true }, EXEC)
    assert.deepEqual(Object.keys(clean).sort(), ['images', 'value'], 'no digest without a matching note')
    assert.deepEqual(
      Object.keys(clean.value).sort(),
      ['accessibility', 'cacheDiagnostics', 'screenshots', 'window'],
      'the official key set is untouched',
    )

    const args = { window: { app: 'blender.exe', id: 1 }, include_text: true }
    const annotated = await tool.execute(args, EXEC)
    assert.deepEqual(annotated.value, { ...WINDOW, window: { app: 'blender.exe', id: 1 } }, 'the official payload is byte-identical')
    assert.equal(annotated.experience, undefined, 'digest injection is retired and never injected')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-7 a disabled layer writes nothing and injects nothing', async () => {
  const { dir, store } = tempStore({ enabled: false })
  try {
    const harness = makeHarness({ experience: store })
    await applyTools(harness.ctx, ToolConfig({}))
    const tool = harness.registered.get('get_window_state')
    const result = await tool.execute({ window: { app: 'blender.exe', id: 1 } }, EXEC)
    assert.equal(result.experience, undefined)
    assert.equal(harness.registered.has(EXPERIENCE_TOOL_NAME), false, 'experience tool is retired and never registered')
    assert.deepEqual(fs.readdirSync(dir), [], 'a disabled layer leaves the store empty')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-8 observations keep facts and redact paths, and never store typed text', () => {
  const { dir, store } = tempStore()
  try {
    const secret = 'correct-horse-battery-staple'
    const turn = 'session-exp' + String.fromCharCode(0) + 'turn'
    store.observe(turn, observationFor({
      method: 'type_text',
      args: { text: secret },
      value: { window: { app: 'notepad.exe' } },
    }))
    store.observe(turn, observationFor({
      method: 'get_window_state',
      args: { include_text: true },
      value: WINDOW,
    }))
    store.observe(turn, observationFor({
      method: 'click',
      args: { window: { app: 'blender.exe' } },
      error: new Error('failed to read ' + (process.env.USERPROFILE || 'C:/Users/someone') + '/secret/plan.txt'),
    }))
    const text = fs.readFileSync(path.join(dir, 'observations.jsonl'), 'utf8')
    assert.equal(text.includes(secret), false, 'typed text never reaches the store')
    assert.equal(text.includes((process.env.USERPROFILE || 'C:/Users/someone') + '/secret'), false, 'the profile path is redacted')
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    const typed = records.find(record => record.method === 'type_text')
    assert.equal(typed.args.textChars, secret.length, 'only the length is kept')
    assert.equal(typed.args.text, undefined)
    const observed = records.find(record => record.method === 'get_window_state')
    assert.equal(observed.app, 'blender.exe')
    assert.equal(observed.axRequested, true)
    assert.equal(observed.axPresent, false, 'an empty tree is a fact worth keeping')
    assert.deepEqual(observed.window, { originX: -11, originY: -11, width: 1707, height: 919 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-9 repeated failures are queued as pending and reported by the next digest', () => {
  const { dir, store } = tempStore()
  try {
    const turn = 'session-exp' + String.fromCharCode(0) + '7'
    for (let index = 0; index < 2; index += 1) {
      store.observe(turn, observationFor({
        method: 'click',
        args: { window: { app: 'blender.exe' } },
        value: { window: { app: 'blender.exe' } },
        error: new Error('coordinate input target is unavailable'),
      }))
    }
    assert.deepEqual(store.settleTurn('session-exp', '7'), { settled: 1, pending: 1 })
    const pending = JSON.parse(fs.readFileSync(path.join(dir, 'pending.jsonl'), 'utf8').trim().split('\n')[0])
    assert.equal(pending.app, 'blender')
    assert.equal(pending.kind, 'failure')
    assert.equal(pending.counts.hits, 2)
    const digest = store.digest('blender', 'blender.exe')
    assert.equal(digest.pending, 1)
    assert.match(formatDigest(digest), /never written up/)
    const second = store.settleTurn('session-exp', '7')
    assert.deepEqual(second, { settled: 0, pending: 0 }, 'settling twice is a no-op')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-10 the host service settles the turn and reports the layer in health', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const dir = tempDir()
  try {
    const ctx = new Context()
    await ctx.plugin(ComputerUseService, { experience: { store: dir } })
    const service = ctx.dshComputerUse
    assert.equal(service.experience.dir, path.resolve(dir))
    service.endTurn = () => Promise.resolve({ ok: true })
    service.releaseOverlay = () => Promise.resolve({ ok: true })
    service.lastConversationId = 'session-exp'
    const turn = 'session-exp' + String.fromCharCode(0) + '5'
    for (let index = 0; index < 2; index += 1) {
      service.experience.observe(turn, observationFor({
        method: 'get_window_state',
        args: { include_text: true },
        value: WINDOW,
      }))
    }
    ctx.emit('session/event', { id: 'session-exp' }, { type: 'turn/end', data: { turn: 5 } })
    await Promise.resolve()
    const pending = fs.readFileSync(path.join(dir, 'pending.jsonl'), 'utf8').trim().split('\n')
    assert.equal(pending.length, 1, 'an empty AX tree with no write-up is queued at turn end')
    assert.equal(JSON.parse(pending[0]).kind, 'ax-empty')
    // The host health payload asks the sidecar; stub it so this gate never spawns a helper.
    service.sidecar.request = async () => ({ ok: true, backend: 'fake' })
    const health = await service.health()
    assert.equal(health.experience.dir, path.resolve(dir))
    assert.equal(health.experience.enabled, true)
    assert.equal(service.experience.turns.size, 0, 'the turn buffer is released')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-11 the always-on header and its skill copy stay byte-identical', () => {
  const assets = fs.readFileSync(path.join(pluginRoot, 'helper-rs', 'assets', 'prompts', 'dsh-header.md'), 'utf8')
  const reference = fs.readFileSync(path.join(pluginRoot, 'skills', 'computer-use', 'references', 'dsh-header.md'), 'utf8')
  assert.equal(reference, assets)
  assert.equal(assets.includes('computer_use_experience'), false, 'experience tool is retired from always-on header')
  assert.equal(fs.readFileSync(path.join(pluginRoot, 'skills', 'computer-use', 'SKILL.md'), 'utf8').includes('computer_use_experience'), false, 'experience tool is retired from skill')
})

test('EXP-12 the experience tool is retired and never registered in the tool plane', async () => {
  const { dir, store } = tempStore()
  try {
    const harness = makeHarness({ experience: store })
    await applyTools(harness.ctx, ToolConfig({}))
    assert.equal(harness.registered.has(EXPERIENCE_TOOL_NAME), false, 'computer_use_experience is completely retired from tools')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-13 hand-written notes in manual.jsonl are read, and never rewritten', () => {
  const { dir, store } = tempStore()
  try {
    const manual = {
      id: 'manual-blender-note',
      date: '2026-09-01',
      lastSeenAt: '2026-09-01T10:00:00.000Z',
      seenCount: 1,
      app: { id: 'blender.exe', name: 'Blender' },
      symptom: 'written by hand after the first attempt',
      workaround: 'start the app scripting console first',
      outcome: 'worked',
      tags: ['ax-empty'],
      source: 'user',
    }
    fs.writeFileSync(path.join(dir, 'manual.jsonl'), JSON.stringify(manual) + '\n')
    const listed = store.list({ app: 'blender.exe' })
    assert.equal(listed.count, 1)
    assert.equal(listed.entries[0].source, 'user')
    assert.equal(store.digest('blender', 'blender.exe').notes[0].source, 'user')
    store.record({ app: 'blender.exe', symptom: 'a note the model adds', cause: 'because', outcome: 'partial', tags: ['ax-empty'] })
    assert.equal(fs.readFileSync(path.join(dir, 'manual.jsonl'), 'utf8'), JSON.stringify(manual) + '\n', 'the hand-written file is never rewritten')
    assert.equal(store.list({ app: 'blender.exe' }).count, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-14 a scoped note never injects into another preset (V2)', () => {
  const { dir, store } = tempStore()
  try {
    store.record({ app: 'blender.exe', statement: 'CU-only pitfall', preset: 'computer-use', workaround: 'w' })
    store.record({ app: 'blender.exe', statement: 'machine-wide truth', scopePresets: 'all', kind: 'fact' })
    const cu = store.digest('blender', 'blender.exe', { preset: 'computer-use' })
    assert.equal(cu.notes.length, 2, 'CU sees its own note plus the machine-wide one')
    const rev = store.digest('blender', 'blender.exe', { preset: 'reverse' })
    assert.equal(rev.notes.length, 1, 'reverse only sees the machine-wide one')
    assert.equal(rev.notes[0].statement, 'machine-wide truth')
    const anonymous = store.digest('blender', 'blender.exe', { preset: '' })
    assert.equal(anonymous.notes.length, 1, 'without a preset identity, scoped notes fail closed')
    const text = formatDigest(cu)
    assert.match(text, /scope: presets=computer-use/, 'the injected block shows the note audience')
    assert.match(text, /written 0d ago/, 'the injected block shows the note age')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-15 volatility: until-date expires, until-config-change is labelled for recheck', () => {
  const { dir, store } = tempStore()
  try {
    store.record({
      app: 'blender.exe', statement: 'temporary workaround', workaround: 'w',
      volatility: 'until-date', expiresAt: '2026-01-01', preset: 'computer-use',
    })
    store.record({
      app: 'blender.exe', statement: 'row layout may change after a config edit',
      volatility: 'until-config-change', preset: 'computer-use',
    })
    const digest = store.digest('blender', 'blender.exe', { preset: 'computer-use' })
    assert.equal(digest.notes.length, 2)
    const expired = digest.notes.find(note => note.expired)
    assert.ok(expired, 'an until-date note past its date stays visible but labelled expired')
    assert.equal(expired.expiresAt, '2026-01-01T00:00:00.000Z')
    const flagged = digest.notes.find(note => note.recheckAfterConfigChange)
    assert.ok(flagged, 'an until-config-change note carries the recheck label')
    assert.match(formatDigest(digest), /recheck after config changes/)
    const strict = new ExperienceStore({ includeStale: false }, { dir, seedPath: path.join(dir, 'no-seed.jsonl') })
    const strictDigest = strict.digest('blender', 'blender.exe', { preset: 'computer-use' })
    assert.equal(strictDigest.notes.length, 1, 'includeStale=false drops the expired until-date note…')
    assert.equal(strictDigest.notes[0].recheckAfterConfigChange, true, '…but keeps the labelled recheck note: it is not stale, it is unverified')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EXP-16 the snapshot card is live composition data, independent of any note (V3)', () => {
  const { dir, store } = tempStore()
  try {
    const card = store.snapshot({ preset: 'computer-use', surfaces: ['computer'], exposedTools: ['click'] })
    assert.equal(card.kind, 'live-snapshot')
    assert.equal(card.preset, 'computer-use')
    assert.equal(card.surfaces[0], 'computer')
    assert.equal(card.exposedTools.length, 1)
    // Temp dir has no profile files: the card degrades instead of throwing (D-1).
    assert.ok(card.bundles, 'bundles degrade to unknown without a profile')
    assert.ok(card.mcpRowsByPreset, 'per-preset MCP rows degrade to unknown without a profile')

    const patch = path.join(dir, 'fake.presets.patch.yml')
    fs.writeFileSync(patch, [
      '- insert:',
      '    - id: preset-browser',
      '      config:',
      '        plugins:',
      '          - id: mcp-chrome-devtools',
      '          - id: mcp-context7',
      '    - id: preset-computer-use',
      '      config:',
      '        plugins:',
      '          - id: mcp-chrome-devtools',
      '    - id: preset-reverse',
      '      config:',
      '        plugins:',
      '          - id: mcp-chrome-devtools',
      '          - id: mcp-rea',
      '          - id: mcp-context7',
    ].join('\n'))
    const rows = store.mcpRowsByPreset(patch)
    assert.deepEqual(rows.rows.browser, ['mcp-chrome-devtools', 'mcp-context7'])
    assert.deepEqual(rows.rows['computer-use'], ['mcp-chrome-devtools'])
    assert.deepEqual(rows.rows.reverse, ['mcp-chrome-devtools', 'mcp-rea', 'mcp-context7'])

    store.record({ app: 'blender.exe', statement: 'a note exists', preset: 'computer-use' })
    const again = store.snapshot({ preset: 'computer-use' })
    assert.notEqual(again.at, card.at, 'the card is regenerated on every call')
    assert.equal(again.preset, 'computer-use')
    assert.equal(store.digest('blender', 'blender.exe', { preset: 'computer-use' }).notes.length, 1, 'notes and the snapshot stay separate layers')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
