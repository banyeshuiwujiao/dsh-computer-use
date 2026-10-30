/**
 * PRESET-plane Computer Use tools. Registers into the host `tools` registry
 * and provides nothing, so this row needs no isolate realm.
 * @module dsh-computer-use/tool
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { computerUsePrompt, documentationSummary, promptAssetStatus, BROWSER_REQUIRED_FOR } from './prompt.js'

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
  // `preset` (V2 experience scope) was removed with the experience layer
  // (commits 0b11afb/bd2ef99); the option had no consumer left. Audit P2-10.
})

const OUTPUT_SCHEMA = {
  // `value` carries arbitrary tool output (object, array, string, number...), so the
  // schema is intentionally open. The host validator rejects an untyped `properties.value`
  // (both `{}` and `{type:'json'}` fail), so we declare no properties at all and accept
  // any object shape via additionalProperties.
  type: 'object',
  additionalProperties: true,
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
    surfaces,
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
  // Standalone, helper-independent extension: a read-only CDP probe. It talks to the
  // sidecar only through the same `call` bridge the window2 tools use, so it needs no
  // helper surface entry (and cannot disturb the `WINDOW2_TOOLS` contract).
  // NOTE: desktop `wait` is already a harness-provided tool; do NOT register one here
  // (a duplicate name would abort the whole desktop tool registration).
  ctx.tools.register(cdpProbeTool(ctx, state))
  const exposed = desktops.concat(extras)
  for (const spec of exposed) {
    try {
      ctx.tools.register(makeSidecarTool(ctx, spec, config, state, {}))
    } catch (error) {
      console.error(`[dsh-computer-use] skipped tool ${spec.name}: ${error}`)
    }
  }
  state.exposedNames = exposed.map(spec => spec.name)
    .concat(['computer_use_cdp_probe'])
    .filter((name, index, all) => all.indexOf(name) === index)
  publishToolNames(ctx, state)
}

/**
 * Tell the safety contract which tool schemas belong to this plugin.
 *
 * The contract hides them from a session whose capability is off (SEC-02), so it
 * needs the exact set of names — the list grows when the browser catalog is
 * unlocked, which is why it is published again from there.
 *
 * @param {object} ctx
 * @param {{ exposedNames: string[] }} state
 */
function publishToolNames(ctx, state) {
  const safety = ctx.dshComputerUse?.safety
  if (safety && typeof safety.setToolNames === 'function') {
    safety.setToolNames(state.exposedNames)
  }
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
      state.exposedNames = [...state.exposedNames, spec.name]
    } catch (error) {
      console.error(`[dsh-computer-use] skipped tool ${spec.name}: ${error}`)
    }
  }
  publishToolNames(ctx, state)
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
        // The safety contract, seen from the calling session: may it drive the
        // desktop, does it hold the write lease, and are its tool schemas
        // currently hidden. This is the audit surface for "why was that
        // refused" — the answer belongs next to the health facts.
        safety: ctx.dshComputerUse?.safetyState?.(exec?.agent?.session?.id ?? exec?.agent?.id),
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

// ---------------------------------------------------------------------------
// Standalone, helper-independent tools: `wait` and `computer_use_cdp_probe`.
// ---------------------------------------------------------------------------

const WAIT_MAX_MS = 60_000

/** Sleeping that honours the tool-call abort signal. */
function sleepRespectingSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('wait aborted')); return }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => { cleanup(); reject(new Error('wait aborted')) }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort) }
    signal?.addEventListener?.('abort', onAbort)
  })
}

/**
 * Desktop `wait`: the missing counterpart of the browser's `tab_pw_wait_for_timeout`.
 * Auto-playing media, animations, debounced search boxes and polling loops all need
 * a pause; without this the model either wastes a helper round-trip or fakes it with
 * a shell sleep. `observe:true` folds a fresh get_window_state into the same call so
 * the very next action is grounded in current state.
 */
function waitTool(ctx, state) {
  return defineTool({
    name: 'wait',
    description:
      'Wait a fixed duration without a helper round-trip. Use it for auto-playing media, animations, debounced UI, '
      + 'or between polls. Set observe:true with a window to also take a fresh get_window_state (screenshot, and '
      + 'optionally the accessibility tree) after the wait so the next action is grounded in current state. '
      + 'Desktop counterpart of the browser tab wait.',
    parameters: {
      ms: { type: 'integer', description: 'Milliseconds to wait (default 1000, clamped to 0..60000).' },
      window: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional target window to observe after the wait (required when observe:true).',
        properties: {
          app: { type: 'string', required: true },
          id: { type: 'integer', required: true },
          title: { type: 'string' },
        },
      },
      observe: { type: 'boolean', description: 'When true and a window is given, take a fresh get_window_state after waiting (default false).' },
      include_text: { type: 'boolean', description: 'With observe:true, also return the indexed accessibility tree (default false).' },
    },
    output: { schema: OUTPUT_SCHEMA, render(_args, value) { return renderValue(value) } },
    async execute(args, exec) {
      const raw = Number(args?.ms ?? 1000)
      const ms = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), WAIT_MAX_MS) : 1000
      await sleepRespectingSignal(ms, exec?.signal)
      const out = { waitedMs: ms }
      if (args?.observe && args?.window) {
        const turnMeta = turnMetaFor(ctx.dshComputerUse, exec)
        const res = await ctx.dshComputerUse.call(
          'get_window_state',
          { window: args.window, include_screenshot: true, include_text: Boolean(args.include_text) },
          exec.signal,
          turnMeta,
        )
        if (res && res.ok === false && res.error) throw new Error(String(res.error))
        const value = res && res.value !== undefined ? res.value : res
        if (value?.accessibility?.tree) {
          state.lastElements = extractInteractiveElements(value.accessibility.tree)
          state.lastWindow = { app: args.window.app, id: args.window.id, title: args.window.title }
        }
        const refs = await admitImages(ctx, res?.images || [])
        return { value: { ...out, observation: value }, images: refs }
      }
      return { value: out, images: [] }
    },
    isConcurrencySafe() { return true },
    presentCall(args) { return { card: 'generic', title: 'wait', rawInput: args && typeof args === 'object' ? args : {} } },
  })
}

/** Win32 process rows for a name/path, via a single read-only CIM query. */
function listProcessRows(filter) {
  const script = `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }).trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** Read a Chromium `DevToolsActivePort` file: line 1 is the port, line 2 the path. */
function readDevToolsActivePort(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const port = Number(String(lines[0] || '').trim())
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { port, wsPath: String(lines[1] || '').trim() }
    }
  } catch { /* not present */ }
  return null
}

async function fetchCdpVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(900) })
    if (!res.ok) return null
    const data = await res.json()
    return { port, browser: data?.Browser ?? null, webSocketDebuggerUrl: data?.webSocketDebuggerUrl ?? null }
  } catch {
    return null
  }
}

/**
 * Is this window's process a Chromium/WebView2 host whose CDP endpoint is reachable?
 * WeChat's mini-program runtime (WeChatAppEx / RadiumWMPF) is Chromium-derived but does
 * NOT honour --remote-debugging-port and exposes no DevToolsActivePort, so it can only
 * ever be pixel-driven — this probe says so explicitly instead of letting the model
 * keep hunting for a DOM route that cannot exist.
 */
async function probeCdp(args) {
  let exe = ''
  if (typeof args.process === 'string' && args.process.trim()) exe = args.process.trim()
  else if (args.window && typeof args.window.app === 'string') {
    const m = /^process:(.+)$/i.exec(args.window.app)
    exe = m ? m[1] : args.window.app
  }
  let rows = []
  if (Number.isInteger(args.pid) && args.pid > 0) {
    rows = listProcessRows(` -Filter "ProcessId=${args.pid}"`)
  } else if (exe) {
    const base = path.basename(exe).replace(/'/g, "''")
    rows = listProcessRows(` -Filter "Name='${base}'"`)
    const wantPath = exe.toLowerCase()
    if (rows.some(r => r.ExecutablePath)) {
      const matched = rows.filter(r => String(r.ExecutablePath || '').toLowerCase() === wantPath)
      if (matched.length) rows = matched
    }
  }
  const ports = new Set()
  const pipePids = []
  const devToolsActivePorts = []
  for (const row of rows) {
    const cmd = String(row.CommandLine || '')
    const portMatch = /--remote-debugging-port=(\d+)/i.exec(cmd)
    if (portMatch) ports.add(Number(portMatch[1]))
    if (/--remote-debugging-pipe/i.test(cmd)) pipePids.push(Number(row.ProcessId))
    const ud = /--user-data-dir="?([^"\s]+)"?/i.exec(cmd) || /--webview-user-data-folder="?([^"\s]+)"?/i.exec(cmd)
    if (ud) {
      const found = readDevToolsActivePort(path.join(ud[1], 'DevToolsActivePort'))
      if (found) { devToolsActivePorts.push({ file: path.join(ud[1], 'DevToolsActivePort'), ...found }); ports.add(found.port) }
    }
  }
  const endpoints = []
  for (const port of ports) {
    const version = await fetchCdpVersion(port)
    if (version) endpoints.push(version)
  }
  const blob = rows.map(r => `${r.Name || ''} ${r.ExecutablePath || ''} ${r.CommandLine || ''}`).join(' ')
  const chromiumLike = /chrome|chromium|msedge|electron|webview2|WeChatAppEx|RadiumWMPF|wmpf/i.test(blob)
  const canAttach = endpoints.length > 0
  let guidance
  if (canAttach) {
    const port = endpoints[0].port
    guidance = `CDP is reachable on 127.0.0.1:${port}. Attach chrome-devtools MCP with --browserUrl http://127.0.0.1:${port} and drive the DOM instead of pixels.`
  } else if (chromiumLike) {
    guidance = exe && /WeChatAppEx|RadiumWMPF|wmpf/i.test(`${exe} ${blob}`)
      ? 'Chromium-derived host (WeChat WMPF/Radium) with NO CDP endpoint. It ignores --remote-debugging-port and writes no DevToolsActivePort, so DOM automation is not available — drive this window by screenshot + coordinates.'
      : 'Chromium/WebView2 host but no CDP endpoint is exposed right now. To enable it, relaunch that app with --remote-debugging-port=<free> (or, for a WebView2 host, set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<free> before launch), then probe again.'
  } else {
    guidance = 'The target process does not look like a Chromium/WebView2 host; CDP does not apply. Use the window2 pixel/UIA path.'
  }
  return {
    probed: { exe: exe || null, pids: rows.map(r => Number(r.ProcessId)), matchedProcesses: rows.length },
    chromiumLike,
    remoteDebuggingPorts: [...ports],
    remoteDebuggingPipePids: pipePids,
    devToolsActivePorts,
    endpoints,
    canAttach,
    guidance,
  }
}

function cdpProbeTool() {
  return defineTool({
    name: 'computer_use_cdp_probe',
    description:
      'Detect whether a window belongs to a Chromium/WebView2 host and whether its CDP endpoint is reachable, '
      + 'so DOM-level automation can replace pixel clicks when possible. Reports the debugging port/ws endpoint, '
      + 'DevToolsActivePort files, or the exact enablement step. WeChat WMPF/Radium renderers expose no CDP and stay '
      + 'pixel-driven. Read-only.',
    parameters: {
      window: {
        type: 'object',
        additionalProperties: false,
        description: 'Window to probe (its app identifier names the process).',
        properties: {
          app: { type: 'string', required: true },
          id: { type: 'integer', required: true },
          title: { type: 'string' },
        },
      },
      process: { type: 'string', description: 'Process name or full exe path to probe instead of a window.' },
      pid: { type: 'integer', description: 'Explicit process id to probe.' },
    },
    output: { schema: OUTPUT_SCHEMA, render(_args, value) { return renderValue(value) } },
    async execute(args) {
      return { value: await probeCdp(args && typeof args === 'object' ? args : {}) }
    },
    isConcurrencySafe() { return true },
    presentCall() { return { card: 'generic', title: 'computer_use_cdp_probe' } },
  })
}

// ---------------------------------------------------------------------------
// UIA tree semantic compression + dead-tree detection.
//
// A Chromium/WebView2/mini-program (WMPF) window publishes only a chain of
// anonymous containers over UIA: no names, no roles, no values. Printing that
// tree costs thousands of tokens and tells the model nothing. Two levers:
//   1. compress: drop decorative leaves and keep only meaningful nodes plus the
//      ancestors that hold them (indices are preserved, so element_index stays valid).
//   2. detect dead: if the tree is (almost) all anonymous containers, stop
//      pretending it is usable and emit one explicit "this path is dead" verdict.
// ---------------------------------------------------------------------------

// Roles that carry no information on their own (their *name* would have to).
const GENERIC_CONTAINER_ROLES = new Set([
  'pane', '窗格', 'group', '组', 'custom', '自定义', 'region', '区域',
  'client', '客户端', 'unknown', '未知', 'document', '文档',
])
// Roles that are inherently interactive/informative even with no extra text.
const MEANINGFUL_ROLES = new Set([
  'button', '按钮', 'edit', '编辑', 'menuitem', '菜单项', 'link', '链接', 'hyperlink', '超链接',
  'checkbox', '复选框', 'radiobutton', '单选按钮', 'combobox', '组合框', 'list', '列表',
  'listitem', '列表项', 'tab', '选项卡', 'tabitem', 'text', '文本', 'image', '图像',
  'slider', '滑块', 'spinner', '微调按钮', 'treeitem', '树项目', 'menuitemcheckbox',
])
const _TREE_EXTRA_MARKERS = ['Description: ', 'Value: ', 'Secondary Actions: ', 'ID: ']

function parseTreeLine(line) {
  const match = /^(\t*)(\d+)(?: +([^\s]+))?(.*)$/.exec(line)
  if (!match) return null
  return { indent: match[1].length, index: Number(match[2]), role: (match[3] || '').toLowerCase(), rest: (match[4] || ''), raw: line }
}

/** Does this node carry information (a name, a value/description, or a real role)? */
function nodeIsMeaningful(node) {
  if (!node) return false
  if (MEANINGFUL_ROLES.has(node.role)) return true
  if (_TREE_EXTRA_MARKERS.some(marker => node.rest.includes(marker))) return true
  // A name: strip a leading parenthesised state block, then any trailing extras.
  let text = node.rest.trim()
  const close = text.startsWith('(') ? text.indexOf(')') : -1
  if (close !== -1) text = text.slice(close + 1).trim()
  for (const marker of _TREE_EXTRA_MARKERS) {
    const at = text.indexOf(marker)
    if (at !== -1) text = text.slice(0, at).trim()
  }
  text = text.replace(/(?:^| )(off|on|indeterminate)$/, '').trim()
  if (text) return true
  // A non-generic role with no name still hints at structure worth keeping.
  return Boolean(node.role) && !GENERIC_CONTAINER_ROLES.has(node.role)
}

/** Does this node carry actual *content* (a live value/description, not just a label)? */
function nodeHasContent(node) {
  if (!node) return false
  if (node.rest.includes('Value: ') || node.rest.includes('Description: ')) return true
  // A text/document role that carries a readable name is content too.
  return (node.role === 'text' || node.role === '文本' || node.role === '文档') && nodeIsMeaningful(node)
}

/** Is this window's process a known Chromium/WebView2/Electron/WMPF host? (app string only, no shell) */
export function looksLikeChromiumHost(window) {
  const app = String(window?.app || '')
  if (!app) return false
  return /WeChatAppEx|RadiumWMPF|wmpf|msedgewebview2|webview2|electron|chrome\.exe|chromium|msedge|Microsoft\.Edge|Code\.exe|slack|discord|teams|notion|obsidian/i.test(app)
}

export function classifyAccessibilityTree(treeText, window) {
  const lines = String(treeText || '').split('\n')
  let total = 0
  let meaningful = 0
  let contentBearing = 0
  for (const line of lines) {
    const node = parseTreeLine(line)
    if (!node) continue
    total += 1
    if (nodeIsMeaningful(node)) meaningful += 1
    if (nodeHasContent(node)) contentBearing += 1
  }
  const ratio = total === 0 ? 1 : meaningful / total
  // "Dead" means: enough nodes to be a real tree, but NOT ONE content-bearing node —
  // and either the process is a known Chromium/WebView2/WMPF host (which renders into
  // a canvas and publishes only window chrome over UIA) or literally nothing is
  // meaningful. Window-chrome buttons (minimize/close) do NOT count as content, so they
  // no longer mask a useless tree.
  const dead = total >= 8 && contentBearing === 0 && (looksLikeChromiumHost(window) || meaningful <= 1)
  return { total, meaningful, contentBearing, ratio, dead }
}

/**
 * Drop decorative leaves while keeping every meaningful node and the ancestor
 * containers that lead to it. Node indices are untouched, so element_index from
 * the helper still resolves against the retained lines.
 */
export function compressAccessibilityTree(treeText) {
  const lines = String(treeText || '').split('\n')
  const nodes = []
  const nodeLineIndexes = []
  lines.forEach((line, index) => {
    const node = parseTreeLine(line)
    if (node) { nodes.push({ ...node, keep: nodeIsMeaningful(node) }); nodeLineIndexes.push(index) }
  })
  if (nodes.length === 0) return treeText
  // Propagate "has a meaningful descendant" up through the indent stack.
  const stack = []
  for (const node of nodes) {
    while (stack.length && stack[stack.length - 1].indent >= node.indent) stack.pop()
    if (node.keep) for (const ancestor of stack) ancestor.hasMeaningfulDescendant = true
    stack.push(node)
  }
  const kept = nodes.filter(node => node.keep || node.hasMeaningfulDescendant)
  if (kept.length === 0) return treeText
  const dropped = nodes.length - kept.length
  const firstNodeLine = nodeLineIndexes[0]
  const lastNodeLine = nodeLineIndexes[nodeLineIndexes.length - 1]
  const header = lines.slice(0, firstNodeLine)
  const footer = lines.slice(lastNodeLine + 1)
  const out = [...header, ...kept.map(node => node.raw), ...footer].join('\n')
  return dropped > 0
    ? `${out}\n# (semantic compression: ${dropped} anonymous container node(s) omitted; indices above are unchanged)`
    : out
}

/** One explicit verdict that replaces a useless tree. */
export function deadTreeSignal(classification, cdp) {
  const lines = [
    '=== Accessibility tree is UNUSABLE for this window (semantic verdict) ===',
    `nodes: ${classification.total}, meaningful labels: ${classification.meaningful}, content-bearing: ${classification.contentBearing} — no window content is exposed over UIA, only anonymous containers and window chrome.`,
    'This window is a Chromium/WebView2 or mini-program (WeChat WMPF/Radium) surface that does not publish its DOM over UIA.',
    'Do NOT call get_window_state with include_text for this window again (it costs tokens and yields nothing).',
    'Use screenshots + vision (vision_map / vision_read / vision_zoom) for content, and act by x/y coordinates; element_index / set_value / perform_secondary_action will not work here.',
  ]
  if (cdp) {
    if (cdp.canAttach && cdp.endpoints?.length) {
      const port = cdp.endpoints[0].port
      lines.push(`CDP IS reachable on 127.0.0.1:${port} (${cdp.endpoints[0].browser || 'chromium'}); prefer DOM automation: attach chrome-devtools MCP with --browserUrl http://127.0.0.1:${port}.`)
    } else if (cdp.chromiumLike) {
      lines.push(`CDP: ${cdp.guidance}`)
    }
  }
  return lines.join('\n')
}

/** Cache a CDP probe per app so a dead-tree window does not spawn a shell on every observation. */
async function cachedCdpProbe(state, window, maxAgeMs = 60_000) {
  if (!window || typeof window.app !== 'string' || !window.app) return null
  state.cdpProbeCache = state.cdpProbeCache || new Map()
  const key = window.app
  const hit = state.cdpProbeCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < maxAgeMs) return hit.value
  let value = null
  try { value = await probeCdp({ window }) } catch { value = null }
  state.cdpProbeCache.set(key, { at: now, value })
  return value
}

const UIA_TREE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'uia-tree.ps1')

/** Render a .NET-UIА fallback node list into a readable tree with window-relative bounds. */
export function formatUiaFallback(nodes) {
  const lines = [
    '=== UIA fallback tree (.NET UIAutomation ControlView) ===',
    'The helper-provided tree under-reported this Chromium/WebView2 window; this is a fuller walk of the same window.',
    'These nodes have NO helper element_index. Act by x/y using the window-relative bounds shown as {{x,y,w,h}}.',
    '',
  ]
  for (const n of nodes) {
    const indent = '\t'.repeat(Math.min((n.depth || 0) + 1, 12))
    const role = n.role || 'Node'
    const name = n.name ? ` ${n.name}` : ''
    const value = n.value ? ` Value: ${n.value}` : ''
    const box = ` {{x:${n.x | 0},y:${n.y | 0},w:${n.w | 0},h:${n.h | 0}}}`
    lines.push(`${indent}${role}${name}${value}${box}`)
  }
  return lines.join('\n')
}

/**
 * Walk a window's UIA tree through the bundled .NET script and return nodes with
 * window-relative bounds. This is the fix for Chromium/WebView2/mini-program windows
 * (WeChat WMPF, Electron, WebView2) whose tree the native helper under-reports down to
 * anonymous panes: a .NET UIAutomation ControlView walk DOES reach the Document/Text/
 * ListItem content and the Document value carries the live URL. Returns null on failure.
 */
export function uiaTreeFallback(hwnd, maxNodes = 800) {
  if (!Number.isInteger(hwnd) || hwnd <= 0) return null
  try {
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_TREE_SCRIPT, '-Hwnd', String(hwnd), '-MaxNodes', String(maxNodes)],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    ).trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return null
  }
}

//: Tools whose coordinate form needs a cached capture session from the last
//: observation; the first observation of a cold/just-restarted helper can leave
//: that session empty. See {@link recoverCoordinateRefusal}.
const COORDINATE_TOOLS = new Set(['click', 'scroll', 'drag'])

/**
 * Recover a coordinate action refused only because no screenshot session was cached
 * (first observation after helper start) or because the caller's screenshotId was
 * superseded. The refusal means the action never ran, so a single re-observe + retry
 * is safe and turns a two-round-trip model dance into zero. Anything else is left
 * untouched for the caller to see.
 */
async function recoverCoordinateRefusal(ctx, state, spec, exec, input, result, turnMeta) {
  if (!result || result.ok || !result.error) return result
  if (!COORDINATE_TOOLS.has(spec.name)) return result
  const message = String(result.error)
  const recoverable = /none is cached/i.test(message)
    || /not the latest observation/i.test(message)
    || /unknown screenshotId/i.test(message)
  if (!recoverable) return result
  if (!input || typeof input.window !== 'object' || input.window === null) return result
  try {
    const observed = await ctx.dshComputerUse.call(
      'get_window_state',
      { window: input.window, include_screenshot: true, include_text: false },
      exec.signal,
      turnMeta,
    )
    if (!observed || observed.ok === false) return result
    const value = observed.value !== undefined ? observed.value : observed
    if (value?.accessibility?.tree) {
      state.lastElements = extractInteractiveElements(value.accessibility.tree)
      state.lastWindow = { app: input.window.app, id: input.window.id, title: input.window.title }
    }
    const retryInput = { ...input }
    delete retryInput.screenshotId
    const retried = await ctx.dshComputerUse.call(spec.name, retryInput, exec.signal, turnMeta)
    return retried || result
  } catch {
    return result
  }
}

//: Tools that accept `text` as "the element named X" rather than as a payload.
//: Mirrors exactly the tools whose schema gets the optional `text` property in
//: {@link makeSidecarTool}. Every other tool must keep `text` intact:
//: `type_text` types it, `session_note` stores it.
const TEXT_SELECTOR_TOOLS = new Set(['click', 'set_value', 'perform_secondary_action'])


const JSON_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
/**
 * 规范 sidecar 返回的 JSON Schema：新版 harness（dsh-tools assertSupportedJsonSchema）只接受
 * 合法单值 type。sidecar 可能返回数组 type 或别名，会被整份工具定义拒绝注册（skip）。
 * 递归修正为合法单值，不改变语义（多类型取首个合法）。
 */
function normalizeSchemaTypes(node, path = "schema") {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((x, i) => normalizeSchemaTypes(x, path + '[' + i + ']')); return }
  if (node.type !== undefined) {
    if (Array.isArray(node.type)) {
      const pick = node.type.find(x => JSON_SCHEMA_TYPES.has(x))
      console.error('[dsh-computer-use] type[] @' + path + ': ' + JSON.stringify(node.type) + ' -> ' + String(pick))
      if (pick !== undefined) node.type = pick; else delete node.type
    } else if (typeof node.type === 'string' && !JSON_SCHEMA_TYPES.has(node.type)) {
      const MAP = { any: 'string', json: 'object', dynamic: 'string', auto: 'string' }
      const next = MAP[node.type] ?? "string"
      console.error('[dsh-computer-use] type @' + path + ': "' + node.type + '" -> "' + next + '"')
      node.type = next
    }
  }
  if (node.properties && typeof node.properties === 'object') for (const k of Object.keys(node.properties)) normalizeSchemaTypes(node.properties[k], path + '.properties.' + k)
  if (node.items !== undefined) normalizeSchemaTypes(node.items, path + ".items")
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(node[key])) node[key].forEach((x, i) => normalizeSchemaTypes(x, path + '.' + key + '[' + i + ']'))
  if (node.additionalProperties && typeof node.additionalProperties === 'object') normalizeSchemaTypes(node.additionalProperties, path + '.additionalProperties')
}

function makeSidecarTool(ctx, spec, config, state, options) {
  const parameters = spec.parameters && typeof spec.parameters === 'object'
    ? JSON.parse(JSON.stringify(spec.parameters))
    : { type: 'object', properties: {}, additionalProperties: true }
  normalizeSchemaTypes(parameters, 'parameters')
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
        return renderValue(value)
      },
    },
    async execute(args, exec) {
      // The safety contract runs **first**, before argument validation: a
      // capability that is off has to report the same actionable message no
      // matter what the model passed. It also decides whether this call moves
      // the desktop, which is exactly what the cross-session write lease
      // arbitrates (read operations are never arbitrated).
      const safety = ctx.dshComputerUse?.safety
      const gate = safety ? safety.gate(exec, spec.name) : null
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
          // Audit P1-4 (2026-10-25): the cached indices belong to ONE observed
          // window. Matching text against them for a *different* window silently
          // clicks the wrong control, so the cache is only consulted when the
          // caller's window matches the observation (or names no window at all).
          const cacheForThisWindow = state.lastElements && state.lastElements.length > 0
            && (!input.window || typeof input.window !== 'object' || !state.lastWindow
              || (String(input.window.app || '') === String(state.lastWindow.app || '')
                && (input.window.id === undefined || state.lastWindow.id === undefined
                  || input.window.id === state.lastWindow.id)))
          if (cacheForThisWindow) {
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
      // Audit P3-3: the try/catch here used to rethrow unchanged — a dead
      // remnant of the removed recordCall hook — so the bare try is gone too.
      // (`startedAt` went with it: the removed hook was its only reader.)
      //
      // The write lease is held for the **whole** mutating region, including the
      // approval retry: the retry is a second desktop mutation, and a lease that
      // was released between the two would let another session take the desktop
      // in the middle of this one. The idle clock restarts when the write
      // *finishes*, not when it was accepted.
      let result
      if (gate?.write) safety.beginWrite()
      try {
        result = await ctx.dshComputerUse.call(spec.name, input, exec.signal, turnMeta)
        if (result && result.approvalRequest) {
          const refusal = normalizeApprovalRequest(result.approvalRequest)
          // Official helper_transport.js only treats the payload as an approval when
          // "app" is a non-empty string after trimming; otherwise the helper returned
          // an ordinary error and this is not an approval flow (APS-10).
          if (refusal) result = await resolveRefusal(ctx, config, state, spec, exec, input, turnMeta, refusal)
        }
        // First-observation usability: a coordinate click/scroll/drag can be refused
        // because the previous get_window_state cached no capture session (a cold or
        // just-restarted helper), or because the caller passed a screenshotId that a
        // newer observation superseded. Both are recoverable without the model
        // re-deriving the plan: re-observe once, drop the stale screenshotId, retry.
        result = await recoverCoordinateRefusal(ctx, state, spec, exec, input, result, turnMeta)
      } finally {
        if (gate?.write) safety.finishWrite()
      }
      if (gate?.write) safety.lease.note(gate.sessionId, spec.name)
      if (!result?.ok && result?.error) throw new Error(String(result.error))
      result = deriveAudioResult(result, spec.name)
      const value = result?.value ?? result
      if (spec.name === 'get_window_state' && value?.accessibility?.tree) {
        const classification = classifyAccessibilityTree(value.accessibility.tree, input && input.window)
        if (classification.dead) {
          // The helper's tree has no content for this window. Before declaring the
          // path dead, try the .NET UIAutomation ControlView fallback: for Chromium/
          // WebView2/mini-program windows the helper under-reports, but a ControlView
          // walk DOES reach Document/Text/ListItem (and the Document value is the URL).
          const hwnd = Number(input?.window?.id)
          const fallback = uiaTreeFallback(hwnd)
          if (Array.isArray(fallback) && fallback.length >= 3) {
            value.accessibility.tree = formatUiaFallback(fallback)
            value.accessibility.semantic = {
              dead: false,
              source: 'uia-dotnet-fallback',
              nodes: fallback.length,
              helperNodes: classification.total,
            }
            // No helper element_index here: leave lastElements empty so a stray
            // element_index cannot resolve against a fallback line. Act by x/y.
            state.lastElements = []
            state.lastWindow = input && typeof input.window === 'object'
              ? { app: input.window.app, id: input.window.id, title: input.window.title }
              : null
          } else {
            // Both the helper tree AND the .NET fallback are empty/blocked: emit the
            // explicit "this path is dead" verdict (with a cached CDP probe) so the
            // model stops wasting tokens and switches to vision + pixel input.
            const cdp = await cachedCdpProbe(state, input && input.window)
            value.accessibility.tree = deadTreeSignal(classification, cdp)
            value.accessibility.semantic = {
              dead: true,
              totalNodes: classification.total,
              meaningfulNodes: classification.meaningful,
              fallbackTried: true,
              cdpAttachable: Boolean(cdp && cdp.canAttach),
            }
            state.lastElements = []
            state.lastWindow = input && typeof input.window === 'object'
              ? { app: input.window.app, id: input.window.id, title: input.window.title }
              : null
          }
        } else {
          // Semantic compression: drop decorative anonymous leaves, keep the
          // structure that leads to real content (indices unchanged).
          const compressed = compressAccessibilityTree(value.accessibility.tree)
          value.accessibility.tree = compressed
          value.accessibility.semantic = {
            dead: false,
            totalNodes: classification.total,
            meaningfulNodes: classification.meaningful,
          }
          state.lastElements = extractInteractiveElements(compressed)
          // Remember which window those indices describe (audit P1-4): text
          // selection must never resolve against another window's observation.
          state.lastWindow = input && typeof input.window === 'object'
            ? { app: input.window.app, id: input.window.id, title: input.window.title }
            : null
        }
      }
      const refs = await admitImages(ctx, result?.images || [])
      return { value, images: refs }
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
  const axOverrides = {}
  if (typeof ax.document_text === 'string' && ax.document_text.length > 600) {
    const total = ax.document_text.length
    axOverrides.document_text =
      ax.document_text.slice(0, 250) +
      `\n... [document_text trimmed: ${total} total characters to prevent middle pruning; see tree for structure] ...\n` +
      ax.document_text.slice(-150)
  }
  // Audit P2-11 (2026-10-25): the raw tree was shipped whole. Deep windows
  // (IDEs, browsers) push past 100k characters, and the interactive summary
  // above already carries what element_index targeting needs, so the raw tree
  // gets a middle-trim budget of its own instead of a free ride.
  if (typeof ax.tree === 'string' && ax.tree.length > 24_000) {
    const total = ax.tree.length
    axOverrides.tree =
      ax.tree.slice(0, 20_000) +
      `\n... [tree trimmed: ${total} total characters; ${total - 22_000} middle characters dropped. Re-run get_window_state with a narrower scope if the element you need is gone] ...\n` +
      ax.tree.slice(-2_000)
  }
  if (Object.keys(axOverrides).length > 0) {
    safeBody = { ...body, accessibility: { ...ax, ...axOverrides } }
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
    // Audit P2-11: pretty-printing doubled the payload size of every
    // get_window_state result for zero reader benefit — the model consumes
    // JSON, it does not need indentation.
    return JSON.stringify(value)
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
