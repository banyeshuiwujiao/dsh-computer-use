/**
 * PRESET-plane Computer Use tools. Registers into the host `tools` registry
 * and provides nothing, so this row needs no isolate realm.
 * @module dsh-computer-use/tool
 */

import fs from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { computerUsePrompt, documentationSummary, promptAssetStatus, BROWSER_REQUIRED_FOR } from './prompt.js'
import {
  NOOP_EXPERIENCE,
  appKeyOf,
  appsInResult,
  formatDigest,
  isDigestMethod,
  observationFor,
} from './experience.js'

export const name = 'tool-computer-use'
export const inject = ['tools', 'dshComputerUse', 'systemPrompt']

/**
 * Where the always-on computer-use contract sits in the system prompt. DSH 0.1.6 added
 * a centrally owned TOOL_COMPUTER_USE slot beside the other tool contracts; releases
 * without it return undefined, where the historical value 48 keeps the placement.
 * @param {object} systemPrompt the host system-prompt service
 * @returns {number}
 */
export function computerUseSectionOrder(systemPrompt) {
  try {
    const order = systemPrompt?.getSectionOrder?.('TOOL_COMPUTER_USE')
    return typeof order === 'number' ? order : 48
  } catch {
    return 48
  }
}

/** What to do when the helper reports `AppApprovalRequired` for a tool. */
export const APPROVAL_MODES = ['prompt', 'allow', 'deny']

/**
 * Request meta for one Computer Use tool call.
 *
 * The turn id MUST be stable for the whole DSH turn. The sidecar sends `end_turn`
 * whenever the turn scope changes (`ensureTurn`), and the helper treats that as "flush the
 * observation lease", so stamping the per-call id here made every call a new turn: an
 * observation was discarded before the very next input action, and the model saw
 * `coordinate input target is unavailable` / `call get_window_state before using this
 * window` on every click after a successful `get_window_state`. The turn id now comes from
 * the host service's `session/event` tracking; the fallback is a constant, never a call id.
 *
 * `callId` stays in the meta because the approval path forwards it to the answerer.
 *
 * @param {object} service host-plane `dshComputerUse` service
 * @param {object} exec tool execution context (`agent`, `callId`, `rootCallId`)
 * @returns {{ conversationId: string, turnId: string, callId: string }}
 */
export function turnMetaFor(service, exec) {
  const conversationId = String(exec?.agent?.id || exec?.rootCallId || 'dsh')
  const known = service?.currentTurnIdFor?.(conversationId)
  return {
    conversationId,
    turnId: known === undefined || known === null || known === '' ? 'turn' : String(known),
    callId: String(exec?.callId || ''),
  }
}

export const Config = Schema.object({
  surfaces: Schema.array(Schema.string()).default(['computer']),
  browserSkill: Schema.string().default('computer-use-browser'),
  /**
   * Per-tool approval policy (MCP-09). `prompt` asks the DSH approval service,
   * `allow` records the grant without asking, `deny` fails closed.
   *
   * Official elicits **only after** the helper refuses (APP-1), so this governs
   * the refusal path; the plugin never pre-approves an action the helper was
   * willing to take. The default is `prompt`: a method nobody configured must
   * never silently approve itself (APS-01).
   */
  approvalDefault: Schema.union(APPROVAL_MODES).default('prompt'),
  approvalTools: Schema.dict(Schema.union(APPROVAL_MODES)).default({}),
  /**
   * Desktop `enabled_tools` whitelist (MCP-07). The official `.mcp.json`
   * exposes only `js/js_reset/turn_ended`; DSH exposes the official 13 plus
   * explicitly listed harness extensions. Diagnostic tools
   * (`session_note/session_state/diagnostic_state`) and `end_turn` stay out of
   * the catalog unless named here.
   */
  // batch_actions and scroll_element are on by default because the always-present
  // `scroll` / `batch_actions` descriptions tell the model to use `scroll_element`
  // for indexed scrolling; a tool the guidance names must also be discoverable.
  // It is a harness-surface extension, so the official native `computer` surface
  // stays exactly 13. Diagnostic tools and end_turn stay opt-in.
  // `fill_form` joins the defaults because a multi-field form is the single most
  // common round-trip sink (each field costs an observe→act→observe cycle), and
  // the guidance now names it as the preferred path for 2+ field forms.
  enabledTools: Schema.array(Schema.string()).default(['batch_actions', 'scroll_element', 'fill_form']),
})

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    value: {},
    images: { type: 'array' },
  },
}

const BROWSER_SKILL = 'computer-use-browser'

/**
 * Official `docs/documents.json` `requiredFor` entries that ship with DSH.
 * Reading the listed reference clears the gate (PSG-5); the official runtime
 * enforces the same table with `assertRequiredDocumentationRead`.
 *
 * PSG-4: the value is a **path-qualified** reference, not a basename. The desktop
 * and browser skills both ship a `references/confirmations.md` with different
 * policy text, so matching on the basename let a read of the *Windows* policy
 * satisfy the *browser* CDP gate without the official browser confirmations ever
 * being read.
 */
const BROWSER_CONFIRMATIONS_DOC = 'computer-use-browser/references/confirmations.md'

export const REQUIRED_DOCS = {
  // Invert the official documents.json shape (document -> tools) into the lookup
  // the dispatcher needs (tool -> documents).
  ...Object.fromEntries(
    BROWSER_REQUIRED_FOR[BROWSER_CONFIRMATIONS_DOC].map(tool => [tool, [BROWSER_CONFIRMATIONS_DOC]]),
  ),
  // The official entry for this one points at the unshipped
  // capabilities/tab/browserAuth document; until that ships, the browser
  // confirmations policy is the shipped gate.
  tab_browser_auth_handoff: [BROWSER_CONFIRMATIONS_DOC],
}

/** Normalise a `read` file path so the gate is separator- and case-insensitive. */
export function normalizeDocPath(file) {
  return String(file).replace(/\\/g, '/').toLowerCase()
}

/** Whether a recorded read satisfies a path-qualified `requiredFor` entry. */
export function documentWasRead(readPaths, required) {
  const needle = normalizeDocPath(required)
  for (const read of readPaths) {
    const path = normalizeDocPath(read)
    if (path === needle || path.endsWith('/' + needle)) return true
  }
  return false
}

/**
 * Official documents referenced by `requiredFor` that DSH does not ship yet
 * (`capabilities/tab/cdp`, `webmcp`, `capabilities/tab/browserAuth`). Kept
 * visible in health so the gap is auditable instead of silent.
 */
export const UNSHIPPED_REQUIRED_DOCS = ['capabilities/tab/cdp', 'webmcp', 'capabilities/tab/browserAuth']

/**
 * Browser entry selection, layered onto every browser tool description
 * (MCP-03). Official `resources/browser-description.md` is concatenated into
 * the `js` tool description; DSH has one description per tool, so the same
 * first-match strategy is prepended to the browser catalog.
 */
const BROWSER_ENTRY_GUIDANCE = [
  'Browser entry selection - use the first matching option:',
  '1. Tab @-mention: find the tab whose id/title/url match the mention, then attach it.',
  '2. Known tab id and browser: attach that tab.',
  '3. Known URL in the in-app browser: create a visible in-app tab.',
  '4. Known URL and a named browser: create a tab in that browser; do not probe first.',
  '5. Known URL and no named browser: select the browser for that URL.',
].join('\n')

export function apply(ctx, config) {
  const surfaces = Array.isArray(config.surfaces) ? config.surfaces : ['computer']
  const desktop = surfaces.length === 0 || surfaces.includes('computer') || surfaces.includes('all')
  const wantsBrowser = surfaces.includes('browser') || surfaces.includes('all')
  const gateBrowser = !wantsBrowser
  const state = {
    browserUnlocked: false,
    exposedNames: [],
    /**
     * The experience layer is owned by the host-plane service, which owns the store and
     * the turn lifecycle. Without it -- a harness that never mounted the host plane --
     * the tools keep working and simply carry no notes (I1: the layer is advisory and
     * can never fail a Computer Use call).
     */
    experience: ctx.dshComputerUse.experience || NOOP_EXPERIENCE,
    /** turnKey + app pairs already annotated this turn, so a digest is injected once. */
    digested: new Set(),
    /** Basenames of reference documents the model has actually read (PSG-5). */
    readDocuments: new Set(),
    /** Audit trail for operator-configured `allow` grants (APS-01). */
    recordedApprovals: [],
  }
  const hideOverlay = () => {
    ctx.dshComputerUse.releaseOverlay().catch(() => {})
  }
  // No `session/event` listener here on purpose. This row is mounted in the user-agent
  // preset, i.e. in a descendant scope, and scope-filtered dispatch only reaches a
  // listener on an equal or enclosing scope, so a listener here can never see
  // `turn/end` (the old hook was dead code and left the overlay on screen). The
  // host-plane service in `index.js` owns the turn-end release.
  ctx.effect(() => () => {
    hideOverlay()
    ctx.dshComputerUse.shutdownSidecar().catch(() => {})
  }, 'computer-use overlay release')

  ctx.systemPrompt.section({
    name: 'tool:computer-use',
    // 0.1.6+ reserves the TOOL_COMPUTER_USE slot (3000) for the computer-use contract;
    // older releases have no such slot, where 48 keeps the previous placement.
    order: computerUseSectionOrder(ctx.systemPrompt),
    // Always-on text is the session contract plus the on-demand pointer; the
    // reference documents resolve through the skill's references/ directory.
    text: () => computerUsePrompt(),
  })

  // One listener serves both hooks: the skill result unlocks the browser
  // catalog, and any `read` of a bundled reference clears the requiredFor gate.
  ctx.on('tools/result', (exec, result) => {
    if (result?.isError) return
    if (exec.name === 'read') {
      const file = String(exec.arguments?.file_path || exec.arguments?.path || '')
      if (file) state.readDocuments.add(normalizeDocPath(file))
      return
    }
    if (!gateBrowser || exec.name !== 'skill') return
    if (String(exec.arguments?.name || '') === BROWSER_SKILL) void unlockBrowserTools(ctx, state, config)
  })

  const ready = desktop ? registerDesktop(ctx, state, config) : Promise.resolve()
  if (wantsBrowser) return Promise.resolve(ready).then(() => unlockBrowserTools(ctx, state, config))
  return ready
}

async function registerDesktop(ctx, state, config) {
  let desktops
  try {
    const listed = await ctx.dshComputerUse.tools('computer')
    desktops = Array.isArray(listed?.tools) ? listed.tools.filter(spec => spec?.name) : []
  } catch (error) {
    ctx.tools.register(healthTool(ctx, state, config, String(error)))
    registerExperienceTool(ctx, state)
    return
  }
  // Harness extensions are requested as their own surface (TC-01). A helper
  // that does not know `harness` yet falls back to the full table, so the
  // name-dedup below still yields exactly the non-window2 extras.
  let harness = []
  for (const surface of ['harness', 'gated']) {
    if (harness.length > 0) break
    try {
      const listed = await ctx.dshComputerUse.tools(surface)
      const known = new Set(desktops.map(spec => spec.name))
      harness = (Array.isArray(listed?.tools) ? listed.tools : [])
        .filter(spec => spec?.name && !known.has(spec.name))
    } catch {
      harness = []
    }
  }
  const enabled = new Set(config.enabledTools || [])
  const extras = harness.filter(spec => enabled.has(spec.name))
  ctx.tools.register(healthTool(ctx, state, config))
  registerExperienceTool(ctx, state)
  const exposed = desktops.concat(extras)
  for (const spec of exposed) {
    try {
      ctx.tools.register(makeSidecarTool(ctx, spec, config, state, {}))
    } catch (error) {
      console.error(`[dsh-computer-use] skipped tool ${spec.name}: ${error}`)
    }
  }
  state.exposedNames = exposed.map(spec => spec.name)
}

async function unlockBrowserTools(ctx, state, config) {
  if (state.browserUnlocked) return
  state.browserUnlocked = true
  let listed
  try {
    listed = await ctx.dshComputerUse.tools('browser')
  } catch (error) {
    console.error(`[dsh-computer-use] browser tools failed to load: ${error}`)
    state.browserUnlocked = false
    return
  }
  for (const spec of listed?.tools || []) {
    if (!spec?.name) continue
    try {
      ctx.tools.register(makeSidecarTool(ctx, spec, config, state, { descriptionPrefix: BROWSER_ENTRY_GUIDANCE }))
    } catch (error) {
      console.error(`[dsh-computer-use] skipped tool ${spec.name}: ${error}`)
    }
  }
  try {
    await ctx.dshComputerUse.call('browser_setup', { environment: 'codex-app' })
  } catch (error) {
    console.error(`[dsh-computer-use] browser_setup failed: ${error}`)
  }
}

function healthTool(ctx, state, config, startError) {
  return defineTool({
    name: 'computer_use_health',
    description:
      'Report whether Computer Use is running, which desktop backend is active, the observation freshness model ' +
      '(window identity, bounds, and the human-input monitor), the app allow list, the injected helper environment, ' +
      'and whether browser tools are unlocked. Codex is not required.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(_args, exec) {
      const catalogue = {
        browserUnlocked: Boolean(state.browserUnlocked),
        browserSkill: BROWSER_SKILL,
        tools: { exposed: state.exposedNames, enabled: config.enabledTools },
        approval: {
          default: config.approvalDefault,
          tools: config.approvalTools,
          recorded: state.recordedApprovals.slice(0, 32),
          // What this session will actually do with a helper refusal: full access and a
          // 'never' policy both grant it without an ask (see approvalFacts).
          session: approvalFacts(exec, ctx.get('approval')),
        },
        documentation: documentationSummary(),
        promptAssets: promptAssetStatus(),
        // DSH extension, not official: the local experience layer, its store path and
        // what it currently holds. Notes are advisory; nothing here gates a call.
        experience: experienceStats(state),
        documentationGate: {
          requiredFor: REQUIRED_DOCS,
          unshipped: UNSHIPPED_REQUIRED_DOCS,
          read: [...state.readDocuments],
        },
      }
      if (startError) {
        return { ok: false, codexRequired: false, error: startError, ...catalogue }
      }
      const health = await ctx.dshComputerUse.health()
      // The overlay's own diagnostics (which pill renderer is live, how many frames it
      // pushed, whether the pill window exists at all) live on the helper's
      // diagnostic_state method. Surfacing them here answers "the pill did not appear"
      // from the documented health call instead of a bespoke probe: the status pill is a
      // DirectComposition visual tree, so when it is missing nothing in the normal API says
      // why. The helper may be gone or wedged, so this never fails the health call.
      let overlay
      try {
        const diagnostics = await ctx.dshComputerUse.call('diagnostic_state', {})
        const payload = diagnostics && diagnostics.value !== undefined ? diagnostics.value : diagnostics
        overlay = payload && typeof payload === 'object' ? payload.overlayState : undefined
      } catch {
        overlay = undefined
      }
      return { ...health, ...catalogue, ...(overlay === undefined ? {} : { overlay }) }
    },
    isConcurrencySafe() {
      return true
    },
    presentCall() {
      return { card: 'generic', title: 'computer_use_health' }
    },
  })
}

/** Name of the DSH-only experience tool (not one of the official 13 methods). */
export const EXPERIENCE_TOOL_NAME = 'computer_use_experience'

/**
 * Register the experience tool, degrading instead of failing: a schema mistake in this
 * one tool must never take the whole Computer Use preset down with it.
 */
function registerExperienceTool(ctx, state) {
  try {
    ctx.tools.register(experienceTool(state))
  } catch (error) {
    console.error('[dsh-computer-use] skipped tool ' + EXPERIENCE_TOOL_NAME + ': ' + error)
  }
}

/**
 * Machine-written facts about one call. Pure observation: it never changes the result
 * and never throws (I1), so a broken store cannot fail a Computer Use call.
 */
function recordCall(state, method, input, turnMeta, startedAt, value, error) {
  const experience = state.experience
  if (!experience || typeof experience.observe !== 'function') return
  try {
    const turnKey = turnKeyOf(turnMeta)
    experience.observe(turnKey, observationFor({
      method,
      args: input,
      value,
      error,
      callMs: Date.now() - startedAt,
      turn: turnKey.split('\u0000')[1] || '',
    }))
  } catch {
    // Observational only.
  }
}

/** The advisory digest, at most once per turn and app. */
function digestForCall(state, method, turnMeta, value) {
  const experience = state.experience
  if (!experience || typeof experience.digest !== 'function') return null
  if (!isDigestMethod(method)) return null
  try {
    const turnKey = turnKeyOf(turnMeta)
    for (const app of appsInResult(method, value)) {
      const key = appKeyOf(app)
      if (!key) continue
      const memo = turnKey + '\u0000' + key
      if (state.digested.has(memo)) continue
      state.digested.add(memo)
      if (state.digested.size > 256) state.digested.clear()
      const digest = experience.digest(key, app)
      if (digest) return digest
    }
  } catch {
    return null
  }
  return null
}

function turnKeyOf(turnMeta) {
  return String(turnMeta && turnMeta.conversationId ? turnMeta.conversationId : '') + '\u0000' +
    String(turnMeta && turnMeta.turnId ? turnMeta.turnId : 'turn')
}

function experienceStats(state) {
  try {
    const experience = state.experience
    if (!experience || typeof experience.stats !== 'function') return { enabled: false, dir: '', lessons: 0 }
    return experience.stats()
  } catch (error) {
    return { enabled: false, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * The local experience layer, as a tool. Pure JavaScript: it never starts the helper,
 * so notes stay readable and writable with no desktop session running.
 */
function experienceTool(state) {
  return defineTool({
    name: EXPERIENCE_TOOL_NAME,
    description:
      'Read, record and update the machine-local Computer Use experience notes: what went wrong in earlier ' +
      'tasks on this machine, the suspected cause, the workaround and the date. Notes are ADVISORY only - ' +
      'they never block or replace a tool call, the current observation always wins over a stored note, and ' +
      'a software upgrade can invalidate any of them. Use action "list" before driving an app you have not ' +
      'driven on this machine, and after a task that hit an app-specific problem you diagnosed or worked ' +
      'around, record one short note with action "record".',
    // DSH parameter schema: an implicit property map (NOT JSON Schema). defineTool
    // compiles it into the model-facing object schema and validates the arguments; the
    // sidecar tools skip this by registering plain objects, which is why their official
    // JSON-Schema parameters never go through this compiler.
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'record', 'update', 'stats'],
        description: 'What to do: list (default), get, record, update or stats.',
      },
      app: { type: 'string', description: 'App id from a Computer Use window/app object, for example blender.exe.' },
      id: { type: 'string', description: 'Note id, for get and update.' },
      tag: { type: 'string', description: 'list: only notes carrying this tag, for example ax-empty.' },
      since: { type: 'string', description: 'list: only notes dated on or after YYYY-MM-DD.' },
      limit: { type: 'number', description: 'list: maximum notes returned (default 10, max 50).' },
      symptom: { type: 'string', description: 'record: what you observed, objectively.' },
      context: { type: 'string', description: 'record: environment that matters (DPI, window state, version).' },
      cause: { type: 'string', description: 'record/update: suspected cause, marked as suspected.' },
      workaround: { type: 'string', description: 'record/update: what actually worked.' },
      outcome: { type: 'string', enum: ['worked', 'partial', 'failed', 'unknown'], description: 'record/update.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'record: how sure you are.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'record: short machine-friendly tags.' },
      verified: { type: 'json', description: 'update: true when the note proved correct again in this task.' },
      supersededBy: { type: 'string', description: 'update: id of the note that replaces this one.' },
      stale: { type: 'boolean', description: 'update: mark the note as no longer applicable.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: stringifyCompact(value) }]
      },
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const experience = state.experience
      const action = String(input.action || 'list').trim().toLowerCase()
      if (action === 'record') return { ok: true, action, ...experience.record(input) }
      if (action === 'update') {
        const id = String(input.id || '').trim()
        if (!id) throw new Error('experience: update needs an "id"')
        return { ok: true, action, ...experience.update(id, input) }
      }
      if (action === 'get') {
        const id = String(input.id || '').trim()
        if (!id) throw new Error('experience: get needs an "id"')
        const entry = experience.get(id)
        if (!entry) throw new Error('experience: no note with id ' + id)
        return { ok: true, action, entry }
      }
      if (action === 'stats') return { ok: true, action, ...experience.stats() }
      if (action === 'list') return { ok: true, action, ...experience.list(input) }
      throw new Error('experience: unknown action "' + action + '" (list, get, record, update, stats)')
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: EXPERIENCE_TOOL_NAME,
        rawInput: args && typeof args === 'object' ? args : {},
      }
    },
  })
}


//: Tools that accept `text` as "the element named X" rather than as a payload.
//: Mirrors exactly the tools whose schema gets the optional `text` property in
//: {@link makeSidecarTool}. Every other tool must keep `text` intact:
//: `type_text` types it, `session_note` stores it.
const TEXT_SELECTOR_TOOLS = new Set(['click', 'set_value', 'perform_secondary_action'])


function makeSidecarTool(ctx, spec, config, state, options) {
  const parameters = spec.parameters && typeof spec.parameters === 'object'
    ? JSON.parse(JSON.stringify(spec.parameters))
    : { type: 'object', properties: {}, additionalProperties: true }
  if (spec.name === 'click') {
    if (parameters.properties && !parameters.properties.text) {
      parameters.properties.text = {
        description: 'Optional element text or name to click (automatically matches element_index from latest get_window_state accessibility tree).',
        type: 'string',
      }
    }
  } else if (spec.name === 'set_value' || spec.name === 'perform_secondary_action') {
    if (parameters.properties && !parameters.properties.text) {
      parameters.properties.text = {
        description: 'Optional element text or name to target (automatically matches element_index from latest get_window_state accessibility tree).',
        type: 'string',
      }
    }
  }
  const base = spec.description || spec.name
  const description = options?.descriptionPrefix ? `${options.descriptionPrefix}\n\n${base}` : base
  return {
    name: spec.name,
    description,
    parameters,
    // The sidecar owns the official request budget (10 s / 15 s for launch_app)
    // and rejects first; this is only a backstop so a wedged helper can never
    // hold a tool call open forever.
    timeoutMs: 25_000,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        // The advisory digest rides as its own text block: the official payload keeps
        // its exact key set (AX-15/TC-09 gate get_window_state to exactly
        // accessibility/cacheDiagnostics/screenshots/window).
        const blocks = []
        const digest = value && typeof value === 'object' ? value.experience : undefined
        if (digest) blocks.push({ type: 'text', text: formatDigest(digest) })
        return blocks.concat(renderValue(value))
      },
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? { ...args } : {}
      // set_value takes the value in `value`; `text` is only the element selector.
      // Writing the value into `text` reaches the helper as a missing `value` and
      // fails with "value is required", which reads like a schema error rather
      // than "put it in the other field" (tools-improved #23). Checked before the
      // selector pass so the answer names the real mistake, not "no match".
      if (spec.name === 'set_value' && input.value === undefined
          && typeof input.text === 'string' && input.text.trim()
          && input.element_index === undefined) {
        throw new Error(
          `set_value needs its value in "value", not "text" ("${input.text.trim()}" was read as an element name). `
          + 'Pass value:"…" with element_index, or use type_text.',
        )
      }
      // "text as element name" is a convenience of three tools only; for every
      // other tool `text` is the payload. This block used to run unconditionally
      // and then `delete input.text`, so `type_text({window, text})` reached the
      // helper as `{window}` and failed with "text is required" — the payload
      // never survived the selector pass. `session_note` lost its note the same
      // way. Guarding on the tool keeps both intact.
      if (TEXT_SELECTOR_TOOLS.has(spec.name)) {
        const targetText = typeof input.text === 'string' ? input.text.trim() : ''
        if (targetText && input.element_index === undefined && (input.x === undefined || input.y === undefined)) {
          if (state.lastElements && state.lastElements.length > 0) {
            const matched = state.lastElements.find(e => e.name && e.name.toLowerCase().includes(targetText.toLowerCase()))
              || state.lastElements.find(e => e.raw && e.raw.toLowerCase().includes(targetText.toLowerCase()))
            if (matched) {
              input.element_index = matched.index
            }
          }
          // The text named no element: say so, with the nearest candidates,
          // instead of letting the helper answer `click requires x` (which reads
          // as "you forgot the coordinates" and sends the model chasing the wrong
          // thing — 2026-10-22/23). Only reachable with no index and no x/y.
          if (input.element_index === undefined) {
            const hay = targetText.toLowerCase()
            const near = (state.lastElements || [])
              .filter(e => typeof e.name === 'string' && e.name)
              .map(e => e.name)
              .filter(name => {
                const n = name.toLowerCase()
                // cheap similarity: share a substring of 3+ chars either way
                return n.includes(hay.slice(0, 3)) || hay.includes(n.slice(0, 3))
              })
              .slice(0, 5)
            const hint = near.length
              ? ` Closest: ${near.join(' | ')}`
              : (state.lastElements && state.lastElements.length
                  ? ' Call get_window_state again and pass element_index.'
                  : ' No observation yet: call get_window_state first.')
            throw new Error(
              `${spec.name} found no element matching text "${targetText}" in the current observation.${hint}`,
            )
          }
        }
        delete input.text
      }

      const required = REQUIRED_DOCS[spec.name]
      if (required) {
        const missing = required.filter(doc => !documentWasRead(state.readDocuments, doc))
        if (missing.length > 0) {
          throw new Error(
            `Computer Use cannot run ${spec.name} until you read ${missing.join(', ')} (official documents.json requiredFor gate); ` +
            'it ships under the computer-use-browser skill\'s references/ directory, and the ' +
            'Windows confirmations policy does not satisfy it.',
          )
        }
      }
      const turnMeta = turnMetaFor(ctx.dshComputerUse, exec)
      const startedAt = Date.now()
      let result
      try {
        result = await ctx.dshComputerUse.call(spec.name, input, exec.signal, turnMeta)
        if (result && result.approvalRequest) {
          const refusal = normalizeApprovalRequest(result.approvalRequest)
          // Official helper_transport.js only treats the payload as an approval when
          // "app" is a non-empty string after trimming; otherwise the helper returned
          // an ordinary error and this is not an approval flow (APS-10).
          if (refusal) result = await resolveRefusal(ctx, config, state, spec, exec, input, turnMeta, refusal)
        }
        if (!result?.ok && result?.error) throw new Error(String(result.error))
        result = deriveAudioResult(result, spec.name)
      } catch (error) {
        // The failure is a fact worth keeping: it is what makes the pending queue and
        // the "nobody wrote this up" reminder possible.
        recordCall(state, spec.name, input, turnMeta, startedAt, undefined, error)
        throw error
      }
      const value = result?.value ?? result
      if (spec.name === 'get_window_state' && value?.accessibility?.tree) {
        state.lastElements = extractInteractiveElements(value.accessibility.tree)
      }
      recordCall(state, spec.name, input, turnMeta, startedAt, value)
      const refs = await admitImages(ctx, result?.images || [])
      const digest = digestForCall(state, spec.name, turnMeta, value)
      return digest ? { value, images: refs, experience: digest } : { value, images: refs }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: spec.name,
        rawInput: args && typeof args === 'object' ? args : {},
      }
    },
  }
}

/**
 * APS-09: official `Audio.d.ts` is `{ filepath, bytes, data_url }` ("Raw 24 kHz
 * stereo WAV bytes") and the official Windows client derives `bytes`/`data_url` by
 * re-reading the file the helper wrote (`computer_use_client_base.js`,
 * `stop_audio_recording`):
 *
 *   const audio = await request('stop_audio_recording', {})
 *   if (typeof audio !== 'object' || audio == null) throw new Error('codex-computer-use.exe did not return computer audio')
 *   const filepath = Reflect.get(audio, 'filepath')
 *   if (typeof filepath !== 'string' || filepath.length === 0) throw new Error('codex-computer-use.exe did not return a computer audio filepath')
 *   const bytes = await from_filepath(filepath)
 *   return { filepath, bytes, data_url: to_data_url(bytes, 'audio/wav') }
 *
 * DSH's helper returns `filepath` + `data_url` but no `bytes`, so the plugin closes
 * the gap here. `bytes` is published as the byte COUNT: the official in-process
 * value is a `Uint8Array`, which a model-facing JSON tool result cannot carry
 * faithfully; the payload itself travels in the official `data_url`.
 *
 * @param {object} result the sidecar call result ({ ok, value, images })
 * @param {string} method
 * @returns {object}
 * @throws with the official error strings (the read failure rides along as `cause`)
 */
export function deriveAudioResult(result, method) {
  if (method !== 'stop_audio_recording') return result
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result
  const audio = result.value !== undefined ? result.value : result
  if (audio === null || typeof audio !== 'object' || Array.isArray(audio)) {
    throw new Error('codex-computer-use.exe did not return computer audio')
  }
  const filepath = typeof audio.filepath === 'string' ? audio.filepath : ''
  if (filepath === '') throw new Error('codex-computer-use.exe did not return a computer audio filepath')
  let bytes
  try {
    bytes = fs.readFileSync(filepath)
  } catch (error) {
    // The official client does not catch this; the closest official string is the
    // filepath one, and the original error stays visible as `cause` (never swallowed).
    throw new Error('codex-computer-use.exe did not return a computer audio filepath', { cause: error })
  }
  const derived = {
    ...audio,
    filepath,
    bytes: bytes.length,
    data_url: 'data:audio/wav;base64,' + bytes.toString('base64'),
  }
  return result.value !== undefined ? { ...result, value: derived } : derived
}

/**
 * Official `helper_transport.js` approval-request parser (APS-10).
 *
 * The official shape is: an approval exists only when `app` is a **non-empty
 * string after trimming**; `displayName` is the trimmed `displayName` or else the
 * trimmed `app` (`helper_transport.js`: `const s = (typeof n === 'string' &&
 * n.trim() !== '') ? n.trim() : i`); `riskLevel` is the two-valued boolean
 * mapping (`'high'`/`'low'`, anything else dropped); and
 * `allowPersistentApproval` defaults to `true`.
 *
 * @param {unknown} raw
 * @returns {{ app: string, displayName: string, riskLevel?: 'low'|'high', allowPersistentApproval: boolean }|null}
 */
export function normalizeApprovalRequest(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = /** @type {Record<string, unknown>} */ (raw)
  const app = typeof value.app === 'string' ? value.app.trim() : ''
  if (app === '') return null
  const displayName = typeof value.displayName === 'string' && value.displayName.trim() !== ''
    ? value.displayName.trim()
    : app
  const risk = value.riskLevel === 'high' || value.riskLevel === 'low' ? value.riskLevel : undefined
  return {
    app,
    displayName,
    allowPersistentApproval: value.allowPersistentApproval !== false,
    ...(risk !== undefined ? { riskLevel: risk } : {}),
  }
}

/**
 * The session's permission facts for the app-approval path.
 *
 * The harness derives two independent knobs from the user's permission preset and
 * writes both into the session log: `sandbox/mode` and `approval/policy`. The shipped
 * base bundle maps full access to `danger-full-access` + `never`, and `never` means
 * "never prompt anyone": ApprovalService.request() resolves "rejected" deterministically
 * *before* any answerer sees the ask (user-approval/src/index.ts decide()). Asking
 * anyway therefore does not merely skip a click, it makes launch_app, activate_window
 * and audio recording unusable for the whole session -- which is exactly the bug this
 * reads the log for. Full access is the user saying "do not ask me", so the app gate is
 * granted instead of asked, and the grant is recorded for the audit trail.
 *
 * @param {object} exec tool execution context; `agent.session` carries the log
 * @param {object} [approval] the approval service, for its configured default policy
 * @returns {{ sandbox: string|undefined, policy: string, fullAccess: boolean, neverAsk: boolean }}
 */
export function approvalFacts(exec, approval) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  let sandbox
  let policy
  if (session && typeof session.seq === 'number' && typeof session.eventAt === 'function') {
    for (let seq = session.seq - 1; seq >= 0 && (sandbox === undefined || policy === undefined); seq -= 1) {
      let event
      try {
        event = session.eventAt(seq)
      } catch {
        break
      }
      if (!event) continue
      if (sandbox === undefined && event.type === 'sandbox/mode') sandbox = event.data && event.data.mode
      if (policy === undefined && event.type === 'approval/policy') policy = event.data && event.data.policy
    }
  }
  const configured = approval && approval.config && typeof approval.config.policy === 'string'
    ? approval.config.policy
    : undefined
  const effective = typeof policy === 'string' && policy !== '' ? policy : (configured || 'ask')
  return {
    sandbox,
    policy: effective,
    fullAccess: sandbox === 'danger-full-access',
    neverAsk: effective === 'never',
  }
}

/**
 * Decide a helper refusal. Official transport elicits **after** the refusal and
 * retries with `x-oai-cua-approved-app`; the plugin must never synthesise that
 * header on its own (APS-01). A session the user put into full access (or one whose
 * approval policy never prompts) has already answered the question, so its refusal is
 * granted without an ask; an explicit `deny` still fails closed.
 *
 * @returns {Promise<object>} the (possibly retried) helper result
 */
async function resolveRefusal(ctx, config, state, spec, exec, input, turnMeta, refusal) {
  const approval = refusal
  const app = approval.app || String(exec.arguments?.app || '')
  const displayName = approval.displayName || app || spec.name
  const isAudio = spec.name === 'start_audio_recording' || spec.name === 'stop_audio_recording'
  const mode = approvalModeFor(config, spec.name)
  if (mode === 'deny') throw new Error(notApprovedMessage(displayName))
  if (mode === 'allow') {
    state.recordedApprovals.push({ toolName: spec.name, app, mode: 'allow' })
    return retryWithApproval(ctx, spec, exec, input, turnMeta, app)
  }
  const service = ctx.get('approval')
  const facts = approvalFacts(exec, service)
  if (facts.fullAccess || facts.neverAsk) {
    // The user already answered the question by choosing this permission preset, and a
    // 'never' policy cannot be answered at all (the service auto-rejects before any
    // answerer). Grant the app for this call and keep the audit trail honest.
    state.recordedApprovals.push({
      toolName: spec.name,
      app,
      mode: 'allow',
      outcome: facts.fullAccess ? 'full-access' : 'approval-policy-never',
    })
    return retryWithApproval(ctx, spec, exec, input, turnMeta, app)
  }
  if (service === undefined || exec.agent === undefined) {
    // No answerer: fail closed exactly like the official unavailable path.
    throw new Error(notApprovedMessage(displayName))
  }
  const allowPersistent = approval.allowPersistentApproval !== false
  const canPersist = allowPersistent && !isAudio
  const request = {
    agent: exec.agent,
    toolName: spec.name,
    callId: exec.callId,
    reason: isAudio
      ? 'Allow Computer Use to record computer audio?'
      : `Allow Computer Use to use ${displayName}?`,
    signal: exec.signal,
  }
  // Official elicitation meta (helper_transport oHT:149-176 / APP-3). DSH's
  // ApprovalRequestEvent has no slot for these, so they ride as extra
  // properties on the same object the answerer receives.
  Object.assign(request, {
    codex_approval_kind: 'mcp_tool_call',
    connector_id: 'computer-use',
    connector_name: 'Computer Use',
    persist: canPersist ? ['session', 'always'] : ['session'],
    riskLevel: approval.riskLevel || 'low',
    tool_params: { app },
    tool_params_display: [{ name: 'app', display_name: 'App', value: displayName }],
    ...(isAudio
      ? { codex_request_type: 'approval_request', tool_call_id: exec.callId, tool_name: 'start_audio_recording' }
      : {}),
  })
  const outcome = await service.request(request)
  if (outcome !== 'allowed-once') throw new Error(notApprovedMessage(displayName))
  state.recordedApprovals.push({ toolName: spec.name, app, mode: 'prompt', outcome: String(outcome) })
  return retryWithApproval(ctx, spec, exec, input, turnMeta, app)
}

function approvalModeFor(config, toolName) {
  const tools = config.approvalTools || {}
  if (Object.prototype.hasOwnProperty.call(tools, toolName)) return tools[toolName]
  return config.approvalDefault || 'prompt'
}

function retryWithApproval(ctx, spec, exec, input, turnMeta, app) {
  return ctx.dshComputerUse.call(spec.name, input, exec.signal, { ...turnMeta, 'x-oai-cua-approved-app': app })
}

/** Official transport wording for a declined approval (oHT:177-189). */
function notApprovedMessage(subject) {
  return `Computer Use was not approved to use ${subject}`
}

/**
 * Extract interactive elements from an accessibility tree for compact inspection.
 * @param {string} treeText
 * @returns {Array<{ index: number, role: string, name: string, raw: string }>}
 */
export function extractInteractiveElements(treeText) {
  if (!treeText || typeof treeText !== 'string') return []
  const lines = treeText.split('\n')
  const elements = []
  const regex = /^\t*(\d+)\s+([^\s]+)(?:\s+(.+))?$/
  for (const line of lines) {
    const match = regex.exec(line)
    if (!match) continue
    const index = parseInt(match[1], 10)
    const role = match[2]
    const rest = match[3] || ''
    const isInteractive = /按钮|选项卡|选项卡项目|菜单项|链接|复选框|单选按钮|编辑|组合框|列表项目|button|tab|tabitem|menuitem|link|checkbox|radiobutton|edit|combobox|listitem/i.test(role)
    if (isInteractive) {
      elements.push({ index, role, name: rest.trim(), raw: line.trim() })
    }
  }
  return elements
}

/**
 * Detect whether the observed window is hosting a Web Document (browser page)
 * and extract routing facts (URL, browser type) to guide the agent toward
 * 10x faster CDP/DOM automation instead of blind coordinate clicks.
 *
 * @param {object} body
 * @returns {{ isWeb: boolean, browser: string, url: string | null } | null}
 */
export function detectWebDocument(body) {
  if (!body || typeof body !== 'object') return null
  const app = String(body.window?.app || '')
  const appLower = app.toLowerCase()
  const isBrowser = /chrome|msedge|edge|brave|firefox|opera|vivaldi|chromium/i.test(appLower)
  const tree = body.accessibility?.tree || ''
  const focused = body.accessibility?.focused_element || ''
  const docText = body.accessibility?.document_text || ''

  // Match URL from focused element, accessibility tree, or document_text
  let url = null
  const urlRegex = /Value:\s*(https?:\/\/[^\s\n\r"'>]+)/i
  const match = urlRegex.exec(focused) || urlRegex.exec(tree)
  if (match) {
    url = match[1]
  } else {
    const textUrlMatch = /(https?:\/\/[^\s\n\r"'>]+)/i.exec(docText)
    if (textUrlMatch) {
      url = textUrlMatch[1]
    }
  }

  const hasWebArea = /RootWebArea|Chrome_RenderWidgetHostHWND|\b文档\b|\bdocument\b/i.test(tree)
  if ((isBrowser && (url || hasWebArea)) || (url && hasWebArea)) {
    const browserName = app.replace(/^process:.*\\/i, '').replace(/\.exe$/i, '')
    return {
      isWeb: true,
      browser: browserName || 'browser',
      url,
    }
  }
  return null
}

/**
 * Format WindowState body with an interactive element summary and trimmed document_text
 * to prevent context explosion and DSH middle-pruning while preserving JSON structure.
 * @param {object} body
 * @returns {string}
 */
export function formatWindowStateBody(body) {
  if (!body || typeof body !== 'object') return stringifyCompact(body)
  const ax = body.accessibility
  if (!ax || typeof ax !== 'object') return stringifyCompact(body)

  let header = ''
  const webDoc = detectWebDocument(body)
  if (webDoc) {
    const urlDisplay = webDoc.url ? ` (${webDoc.url})` : ''
    header = [
      `=== Web Document Detected: Smart Router Advisory ===`,
      `Target window is displaying a Web Document in ${webDoc.browser}${urlDisplay}.`,
      `• Fast Path (Recommended): For web forms, buttons, links, and data reading, prefer CDP / DOM automation (load skill "computer-use-browser" for tab_* tools or use "cdp-browser-use"). DOM scripts execute in ~0.5s without pixel coordinates, screen capture latency, or IME composition issues.`,
      `• Native Path: If staying on the desktop surface, use "fill_form" for atomic multi-field input, or use element_index from the summary below.`,
      `====================================================\n\n`,
    ].join('\n')
  }

  let summary = ''
  if (typeof ax.tree === 'string' && ax.tree.length > 0) {
    const elems = extractInteractiveElements(ax.tree)
    if (elems.length > 0) {
      const summaryLines = [
        `=== Interactive Elements (${elems.length} found; use element_index with click/set_value) ===`,
      ]
      for (const el of elems.slice(0, 60)) {
        summaryLines.push(`[${el.index}] ${el.role} "${el.name}"`)
      }
      if (elems.length > 60) {
        summaryLines.push(`... [${elems.length - 60} more interactive elements in tree]`)
      }
      summary = summaryLines.join('\n') + '\n\n'
    }
  }

  let safeBody = body
  if (typeof ax.document_text === 'string' && ax.document_text.length > 600) {
    const total = ax.document_text.length
    const trimmed =
      ax.document_text.slice(0, 250) +
      `\n... [document_text trimmed: ${total} total characters to prevent middle pruning; see tree for structure] ...\n` +
      ax.document_text.slice(-150)
    safeBody = {
      ...body,
      accessibility: {
        ...ax,
        document_text: trimmed,
      },
    }
  }

  return header + summary + stringifyCompact(safeBody)
}

function renderValue(value) {
  const record = value && typeof value === 'object' ? value : { value }
  const body = record.value === undefined ? record : record.value
  const blocks = []
  if (body !== null && body !== undefined) {
    blocks.push({ type: 'text', text: formatWindowStateBody(body) })
  }
  for (const attachment of Array.isArray(record.images) ? record.images : []) {
    if (attachment && attachment.attachmentId) {
      blocks.push({ type: 'image', attachment })
    }
  }
  return blocks
}

function stringifyCompact(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function admitImages(ctx, images) {
  if (images.length === 0) return []
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new Error('screenshot captured but attachments service is unavailable; cannot admit vision ImageBlocks')
  }
  const decoded = []
  for (const image of images) {
    if (!image?.data) continue
    const buffer = Buffer.from(image.data, 'base64')
    decoded.push({
      data: new Uint8Array(buffer),
      mediaType: image.mimeType === 'image/jpeg' || image.mimeType === 'image/webp' || image.mimeType === 'image/gif'
        ? image.mimeType
        : 'image/png',
      name: image.name || 'screenshot.png',
    })
  }
  if (decoded.length === 0) return []
  if (typeof attachments.saveImages === 'function') {
    return [...await attachments.saveImages(decoded)]
  }
  if (typeof attachments.saveImage === 'function') {
    const refs = []
    for (const item of decoded) refs.push(await attachments.saveImage(item))
    return refs
  }
  return []
}
