/**
 * Local experience layer for Computer Use.
 *
 * Two record kinds, deliberately different in trust:
 *
 *   lessons      one-line statements the model writes after a task (V2: each carries a
 *                scope - which presets/apps see it - and a volatility - how long it
 *                holds). ADVISORY ONLY: no lesson can block, rewrite or gate a Computer
 *                Use call, and the current observation always wins over a stored note.
 *                V3 discipline: a lesson records a durable fact or a pitfall - anything
 *                readable from the system belongs to the live snapshot, not here.
 *   observations machine-written facts (method, ok/error, app, AX presence, window
 *                geometry, timing). Typed text, element names and screenshot bytes
 *                never reach these files.
 *   snapshot     NOT stored: regenerated on every call from the live system (bundles,
 *                per-preset MCP rows). State questions are answered from here, which is
 *                why a stale lesson can no longer masquerade as current state.
 *
 * The store lives inside the plugin folder by explicit decision (D-1):
 * <pluginRoot>/.experience/, gitignored. The experience.store config points it
 * elsewhere when needed. Every entry point is best-effort: a broken store degrades
 * to "no notes" and can never fail a Computer Use call.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot } from './paths.js'

export const STORE_DIR_NAME = '.experience'

export const STORE_FILES = {
  lessons: 'lessons.jsonl',
  manual: 'manual.jsonl',
  observations: 'observations.jsonl',
  pending: 'pending.jsonl',
  markdown: 'lessons.md',
}

export const EXPERIENCE_DEFAULTS = {
  enabled: true,
  store: '',
  captureObservations: true,
  injectDigest: true,
  maxEntries: 3,
  maxChars: 900,
  noteChars: 220,
  staleAfterDays: 90,
  includeStale: true,
  retainEntries: 200,
  retainObservationDays: 30,
  redactPaths: true,
}

const LIMITS = {
  statement: 300,
  symptom: 400,
  context: 400,
  cause: 500,
  workaround: 800,
  errorText: 300,
  app: 120,
  tag: 32,
  tags: 8,
  verifyHint: 200,
  scopeItem: 60,
}

/**
 * V2 redesign (2026-10-25): a note carries an explicit audience (scope) and an
 * explicit lifetime (volatility), because the failure that motivated the redesign
 * was a note describing host-level MCP rows being injected into a Computer Use
 * session after those rows had moved into presets.
 *
 *   scope      who may see it:  { presets: 'all' | [...], apps: 'all' | [...] }
 *   volatility how long it holds: 'durable' | 'until-config-change' | 'until-date'
 *              ('until-date' pairs with expiresAt; 'until-config-change' is only
 *              LABELLED in phase 1 - auto-invalidation is the phase-2 fingerprint work)
 *
 * V3 discipline lives in the tool copy, not in code: a note records a durable fact or
 * a pitfall ("reading of the world"); anything readable from the system (mounted rows,
 * PIDs, ports) belongs to the live snapshot action instead.
 */
export const VOLATILITY = new Set(['durable', 'until-config-change', 'until-date'])
export const NOTE_KINDS = new Set(['fact', 'pitfall', 'pointer'])

const OUTCOME_RANK = { worked: 3, partial: 2, unknown: 1, failed: 0 }
const MAX_OBSERVATION_BYTES = 512 * 1024
const LOCK_STALE_MS = 10000
const LOCK_WAIT_MS = 400
const PENDING_DAYS = 30
export const DIGEST_METHODS = new Set(['list_windows', 'list_apps', 'launch_app', 'get_window', 'get_window_state'])

/** Store directory: explicit config, then env override, then <pluginRoot>/.experience. */
export function experienceDir(config = {}) {
  const configured = typeof config.store === 'string' ? config.store.trim() : ''
  if (configured) return path.resolve(configured)
  const fromEnv = String(process.env.DSH_CU_EXPERIENCE_DIR || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(pluginRoot(), STORE_DIR_NAME)
}

/** The env switch wins over the config so a single run can opt out. */
export function experienceEnabled(config = {}) {
  const env = String(process.env.DSH_CU_EXPERIENCE || '').trim().toLowerCase()
  if (env === 'off' || env === '0' || env === 'false') return false
  return config.enabled !== false
}

export function resolveExperienceConfig(config = {}) {
  return { ...EXPERIENCE_DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
}

/* ------------------------------------------------------------------ text --- */

function collapse(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
}

function clamp(text, max) {
  const flat = collapse(text)
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)) + '\u2026'
}

function slug(text) {
  const ascii = collapse(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii.slice(0, 24) || 'note'
}

function normalizeForSignature(text) {
  return collapse(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim()
}

/** Strip the local user profile out of an error string and bound its length. */
export function redactText(text, config = {}) {
  let out = String(text === undefined || text === null ? '' : text)
  if (config.redactPaths !== false) {
    const pairs = [
      [process.env.USERPROFILE, '%USERPROFILE%'],
      [process.env.LOCALAPPDATA, '%LOCALAPPDATA%'],
      [process.env.APPDATA, '%APPDATA%'],
      [process.env.TEMP, '%TEMP%'],
    ]
    for (const pair of pairs) {
      const from = pair[0]
      if (!from) continue
      out = out.split(from).join(pair[1]).split(from.replace(/\\/g, '/')).join(pair[1])
    }
    out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1%USER%')
  }
  return clamp(out, LIMITS.errorText)
}

/* ------------------------------------------------------------- identity --- */

export function normalizeAppSpec(app) {
  if (app && typeof app === 'object' && !Array.isArray(app)) {
    const id = clamp(app.id || app.app || app.name || '', LIMITS.app)
    if (!id) return null
    const spec = { id }
    if (app.name) spec.name = clamp(app.name, 80)
    if (app.version) spec.version = clamp(app.version, 40)
    return spec
  }
  const id = clamp(app, LIMITS.app)
  return id ? { id } : null
}

/** Lower-case identity used for matching: blender.exe and Blender collapse to blender. */
export function appKeyOf(app) {
  const spec = normalizeAppSpec(app)
  if (!spec) return null
  return spec.id.toLowerCase().replace(/\.exe$/, '')
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : tags === undefined || tags === null || tags === '' ? [] : [tags]
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const tag = clamp(raw, LIMITS.tag).toLowerCase().replace(/\s+/g, '-')
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= LIMITS.tags) break
  }
  return out
}

export function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value)
  const pad = number => String(number).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/* ----------------------------------------------------- scope & volatility --- */

/** 'all' | a lower-cased list of preset ids / app keys; '' or missing picks the fallback. */
function normalizeScopeList(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === 'all') return 'all'
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const raw of list) {
    const item = clamp(raw, LIMITS.scopeItem).toLowerCase()
    if (!item || item === 'all' || out.includes(item)) continue
    out.push(item)
  }
  return out.length > 0 ? out : fallback
}

/** Missing scope on a hand-written or legacy record means "visible everywhere". */
export function normalizeScope(scope, fallbackPresets) {
  const raw = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {}
  return {
    presets: normalizeScopeList(raw.presets, fallbackPresets === undefined ? 'all' : fallbackPresets),
    apps: normalizeScopeList(raw.apps, 'all'),
  }
}

export function normalizeVolatility(volatility, expiresAt) {
  if (volatility === 'until-date') {
    const stamp = Date.parse(String(expiresAt || ''))
    if (Number.isFinite(stamp)) return { volatility: 'until-date', expiresAt: new Date(stamp).toISOString() }
  }
  return { volatility: VOLATILITY.has(volatility) ? volatility : 'durable', expiresAt: null }
}

/** Fail-closed: a scoped note is invisible when the reader has no preset identity. */
export function scopeMatches(scope, context) {
  const read = context && typeof context === 'object' ? context : {}
  const preset = String(read.preset || '').trim().toLowerCase()
  const appKey = String(read.appKey || '').trim().toLowerCase()
  const presets = scope && scope.presets !== undefined ? scope.presets : 'all'
  const apps = scope && scope.apps !== undefined ? scope.apps : 'all'
  if (presets !== 'all' && (!preset || !(Array.isArray(presets) ? presets : [presets]).includes(preset))) return false
  if (apps !== 'all' && (!appKey || !(Array.isArray(apps) ? apps : [apps]).includes(appKey))) return false
  return true
}

/** 'until-date' notes past their expiresAt read like any other expired note. */
export function volatilityExpired(entry, now) {
  if (!entry || entry.volatility !== 'until-date' || !entry.expiresAt) return false
  const stamp = Date.parse(entry.expiresAt)
  return Number.isFinite(stamp) && stamp < now.getTime()
}

function ageDaysOf(entry, now) {
  const stamp = Date.parse(entry.lastSeenAt || entry.date || '')
  if (!Number.isFinite(stamp)) return 0
  return Math.max(0, Math.round((now.getTime() - stamp) / 86400000))
}

function isExpired(entry, now, config) {
  const days = Number(config.staleAfterDays)
  if (!Number.isFinite(days) || days <= 0) return false
  return ageDaysOf(entry, now) > days
}

/* -------------------------------------------------------------- entries --- */

/**
 * Identity of a note: the app plus the observed symptom. Tags are deliberately NOT
 * part of it - the same problem is usually re-recorded with a slightly different tag
 * set, and that must merge (tags are unioned on merge) instead of piling up.
 */
export function signatureOf(entry) {
  const parts = [
    appKeyOf(entry && entry.app) || '',
    normalizeForSignature(entry && entry.statement),
  ]
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
}

function newId(appKey, symptom, date) {
  const rand = crypto.randomBytes(2).toString('hex')
  return slug(appKey) + '-' + slug(symptom) + '-' + isoDate(date).replace(/-/g, '') + '-' + rand
}

/** Fill defaults and repair hand-edited or older records. */
export function normalizeEntry(record, source) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const app = normalizeAppSpec(record.app)
  // V3: the one-line conclusion is the entry's content; "symptom" is the legacy alias.
  const statement = clamp(record.statement || record.symptom, LIMITS.statement)
  if (!app || !statement) return null
  const scope = normalizeScope(record.scope)
  const volatility = normalizeVolatility(record.volatility, record.expiresAt)
  const entry = {
    id: clamp(record.id, 80) || newId(appKeyOf(app), statement, record.date),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(record.date || '')) ? String(record.date) : isoDate(record.lastSeenAt),
    lastSeenAt: String(record.lastSeenAt || record.date || new Date().toISOString()),
    seenCount: Number.isFinite(Number(record.seenCount)) && Number(record.seenCount) > 0 ? Number(record.seenCount) : 1,
    app,
    statement,
    kind: NOTE_KINDS.has(record.kind) ? record.kind : 'pitfall',
    scope,
    volatility: volatility.volatility,
    expiresAt: volatility.expiresAt,
    outcome: OUTCOME_RANK[record.outcome] === undefined ? 'unknown' : record.outcome,
    tags: normalizeTags(record.tags),
    source: ['model', 'user', 'seed', 'auto'].includes(record.source) ? record.source : (source || 'model'),
    confidence: ['low', 'medium', 'high'].includes(record.confidence) ? record.confidence : 'medium',
    stale: record.stale === true,
    supersededBy: record.supersededBy ? clamp(record.supersededBy, 80) : null,
  }
  if (record.symptom && record.statement && record.symptom !== record.statement) {
    entry.symptom = clamp(record.symptom, LIMITS.symptom)
  }
  if (record.context) entry.context = clamp(record.context, LIMITS.context)
  if (record.cause) entry.cause = clamp(record.cause, LIMITS.cause)
  if (record.workaround) entry.workaround = clamp(record.workaround, LIMITS.workaround)
  if (record.verifyHint) entry.verifyHint = clamp(record.verifyHint, LIMITS.verifyHint)
  if (record.verified && typeof record.verified === 'object' && record.verified.at) {
    entry.verified = { at: String(record.verified.at), result: String(record.verified.result || entry.outcome) }
  }
  if (record.fromObservation) entry.fromObservation = clamp(record.fromObservation, 80)
  entry.signature = signatureOf(entry)
  return entry
}

/**
 * Build a new model-authored entry; throws when the record has no actionable content.
 *
 * V3 contract: "statement" is the one-line conclusion that must still hold in another
 * session; state snapshots (mounted rows, PIDs, ports) do not belong here - the caller
 * is expected to steer state questions to the live snapshot action instead. The preset
 * the note was written in becomes its default audience, so a note recorded under one
 * preset never leaks into another one (the failure that motivated the redesign).
 */
export function buildLesson(input, now) {
  const source = input && typeof input === 'object' ? input : {}
  const app = normalizeAppSpec(source.app)
  if (!app) throw new Error('experience: "app" is required (the app id a Computer Use call returned)')
  const statement = clamp(source.statement || source.symptom, LIMITS.statement)
  if (!statement) {
    throw new Error('experience: "statement" is required - one line that stays true in another session (not a state snapshot)')
  }
  const cause = clamp(source.cause, LIMITS.cause)
  const workaround = clamp(source.workaround, LIMITS.workaround)
  const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now)
  const rawScope = source.scope !== undefined || (source.scopePresets === undefined && source.scopeApps === undefined)
    ? source.scope
    : { presets: source.scopePresets, apps: source.scopeApps }
  const scope = normalizeScope(rawScope, source.preset ? [String(source.preset).toLowerCase()] : 'all')
  const volatility = normalizeVolatility(source.volatility, source.expiresAt)
  if (source.volatility === 'until-date' && !volatility.expiresAt) {
    throw new Error('experience: volatility "until-date" needs an "expiresAt" (YYYY-MM-DD or ISO)')
  }
  const entry = {
    id: '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(source.date || '')) ? String(source.date) : isoDate(at),
    lastSeenAt: at.toISOString(),
    seenCount: 1,
    app,
    statement,
    kind: NOTE_KINDS.has(source.kind) ? source.kind : 'pitfall',
    scope,
    volatility: volatility.volatility,
    expiresAt: volatility.expiresAt,
    outcome: OUTCOME_RANK[source.outcome] === undefined ? 'unknown' : source.outcome,
    tags: normalizeTags(source.tags),
    source: 'model',
    confidence: ['low', 'medium', 'high'].includes(source.confidence) ? source.confidence : 'medium',
    stale: false,
    supersededBy: null,
  }
  if (source.symptom && source.symptom !== statement) entry.symptom = clamp(source.symptom, LIMITS.symptom)
  if (cause) entry.cause = cause
  if (workaround) entry.workaround = workaround
  if (source.context) entry.context = clamp(source.context, LIMITS.context)
  if (source.verifyHint) entry.verifyHint = clamp(source.verifyHint, LIMITS.verifyHint)
  if (source.fromObservation) entry.fromObservation = clamp(source.fromObservation, 80)
  entry.id = newId(appKeyOf(app) || 'app', statement, at)
  entry.signature = signatureOf(entry)
  return entry
}

function rankOf(entry, now, config) {
  let score = 0
  if (entry.source === 'user') score += 1000
  else if (entry.source === 'seed') score += 800
  if (entry.verified && OUTCOME_RANK[entry.verified.result] === OUTCOME_RANK.worked) score += 200
  score += (OUTCOME_RANK[entry.outcome] || 0) * 20
  score += Math.min(entry.seenCount || 1, 10) * 5
  score -= Math.min(ageDaysOf(entry, now), 365) / 10
  if (entry.stale) score -= 300
  if (isExpired(entry, now, config)) score -= 150
  return score
}

function noteOf(entry, now, config) {
  const action = entry.workaround || entry.cause || ''
  const note = {
    date: entry.date,
    outcome: entry.outcome,
    kind: entry.kind || 'pitfall',
    volatility: entry.volatility || 'durable',
    statement: clamp(entry.statement, 200),
    action: clamp(action, Number(config.noteChars) || 220),
    seen: entry.seenCount || 1,
    ageDays: ageDaysOf(entry, now),
    scope: entry.scope || { presets: 'all', apps: 'all' },
  }
  if (entry.expiresAt) note.expiresAt = entry.expiresAt
  if (entry.stale) note.stale = true
  else if (volatilityExpired(entry, now)) note.expired = true
  else if (isExpired(entry, now, config)) note.mayBeOutdated = true
  if (entry.volatility === 'until-config-change') note.recheckAfterConfigChange = true
  if (entry.source && entry.source !== 'model') note.source = entry.source
  if (entry.tags && entry.tags.length) note.tags = entry.tags.slice(0, 6)
  return note
}

export function summarizeEntry(entry, now, config) {
  const view = {
    id: entry.id,
    date: entry.date,
    app: entry.app && entry.app.id ? entry.app.id : '',
    kind: entry.kind || 'pitfall',
    statement: clamp(entry.statement, 240),
    scope: entry.scope || { presets: 'all', apps: 'all' },
    volatility: entry.volatility || 'durable',
    outcome: entry.outcome,
    tags: entry.tags || [],
    seen: entry.seenCount || 1,
    source: entry.source,
    lastSeenAt: entry.lastSeenAt,
  }
  if (entry.expiresAt) view.expiresAt = entry.expiresAt
  if (entry.cause) view.cause = clamp(entry.cause, 300)
  if (entry.workaround) view.workaround = clamp(entry.workaround, 300)
  if (entry.context) view.context = clamp(entry.context, 200)
  if (entry.verifyHint) view.verifyHint = entry.verifyHint
  if (entry.symptom && entry.symptom !== entry.statement) view.symptom = clamp(entry.symptom, 200)
  if (entry.supersededBy) view.supersededBy = entry.supersededBy
  if (entry.stale) view.stale = true
  if (volatilityExpired(entry, now)) view.expired = true
  else if (isExpired(entry, now, config)) view.mayBeOutdated = true
  return view
}

/** The model-visible text block for an injected digest. */
export function formatDigest(digest) {
  if (!digest) return ''
  const lines = []
  lines.push('Experience notes for ' + digest.app + ' - machine-local notes from earlier tasks here.')
  lines.push('ADVISORY ONLY: not rules and not a gate; the current observation always wins over a')
  lines.push('stored note. Each note is scoped (which presets/apps see it) and dated - check both')
  lines.push('before relying on one. These are NOT live state: for what is mounted or running right')
  lines.push('now, call computer_use_experience({action: "snapshot"}).')
  for (const note of digest.notes) {
    const flags = []
    if (note.stale) flags.push('stale')
    if (note.expired) flags.push('expired ' + (note.expiresAt || ''))
    if (note.mayBeOutdated) flags.push('may be outdated')
    if (note.volatility === 'until-config-change') flags.push('recheck after config changes')
    const scope = note.scope && note.scope.presets !== undefined
      ? 'scope: presets=' + (Array.isArray(note.scope.presets) ? note.scope.presets.join('|') : note.scope.presets)
      : ''
    const head = '- ' + note.date + ' [' + (note.kind || 'pitfall') + '/' + (note.volatility || 'durable')
      + (flags.length > 0 ? ', ' + flags.join(', ') : '') + '] ' + note.statement
    const tail = (scope ? ' (' + scope + ', written ' + note.ageDays + 'd ago)' : ' (written ' + note.ageDays + 'd ago)')
    lines.push(note.action ? head + ' -> ' + note.action + tail : head + tail)
  }
  if (digest.pending > 0) {
    lines.push(digest.pending + ' earlier problem(s) on this app were never written up. If you learn the cause')
    lines.push('or a workaround this time, record it: computer_use_experience({action: "record", ...}).')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------ file io --- */

export function parseJsonl(text) {
  const records = []
  let invalid = 0
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed)
      else invalid += 1
    } catch {
      invalid += 1
    }
  }
  return { records, invalid }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function countLines(file) {
  const text = readText(file)
  if (!text) return 0
  let count = 0
  for (const line of text.split('\n')) if (line.trim()) count += 1
  return count
}

function atomicWrite(file, text) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // No shared memory (rare): the write is still temp+rename atomic.
  }
}

/** Bounded, best-effort lock: never throws, never waits longer than LOCK_WAIT_MS. */
function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, '.lock')
  let held = false
  const deadline = Date.now() + LOCK_WAIT_MS
  while (!held) {
    try {
      fs.mkdirSync(lock)
      held = true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') break
      let age = Number.MAX_SAFE_INTEGER
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs
      } catch {
        // The holder vanished between mkdir and stat: retry immediately.
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.rmSync(lock, { recursive: true, force: true })
        } catch {
          // Someone else cleaned it up first.
        }
      }
      if (Date.now() >= deadline) break
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { recursive: true, force: true })
      } catch {
        // A stale-lock sweep already removed it.
      }
    }
  }
}

function errorCodeOf(error) {
  const text = String(error && error.message ? error.message : error || '')
  return slug(text.split(/[.;\n]/)[0]).slice(0, 48) || 'error'
}

/* ---------------------------------------------------------- observation --- */

function collectApps(method, value, out, depth) {
  const found = out || []
  if (found.length >= 8 || depth > 3 || value === null || value === undefined || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) collectApps(method, item, found, depth + 1)
    return found
  }
  let direct = null
  if (typeof value.app === 'string') direct = value.app
  else if (typeof value.processKey === 'string') direct = value.processKey
  else if (method === 'list_apps') {
    if (typeof value.id === 'string') direct = value.id
    else if (typeof value.appId === 'string') direct = value.appId
  }
  if (direct) found.push(direct)
  for (const key of ['window', 'windows', 'apps', 'items', 'result', 'value']) {
    if (value[key] !== undefined) collectApps(method, value[key], found, depth + 1)
  }
  return found
}

function accessibilityOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { present: false, chars: 0 }
  const ax = value.accessibility
  if (typeof ax === 'string') return { present: ax.trim().length > 0, chars: ax.length }
  if (ax && typeof ax === 'object') {
    const text = JSON.stringify(ax)
    return { present: text.length > 2, chars: text.length }
  }
  return { present: false, chars: 0 }
}

function geometryOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const shot = Array.isArray(value.screenshots) && value.screenshots.length > 0 ? value.screenshots[0] : null
  const source = shot || (value.window && typeof value.window === 'object' ? value.window : null)
  if (!source) return null
  const out = {}
  for (const key of ['originX', 'originY', 'width', 'height']) {
    const number = Number(source[key])
    if (Number.isFinite(number)) out[key] = number
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Whitelisted argument summary: never the typed text, never element names. */
function argsSummary(args, method) {
  const input = args && typeof args === 'object' ? args : {}
  const summary = {}
  if (input.include_text !== undefined) summary.includeText = input.include_text === true
  if (input.include_screenshot !== undefined) summary.includeScreenshot = input.include_screenshot === true
  if (input.screenshotId !== undefined) summary.hasScreenshotId = true
  if (typeof input.text === 'string') summary.textChars = input.text.length
  if (Array.isArray(input.keys)) summary.keyCount = input.keys.length
  if (Array.isArray(input.actions)) summary.actionCount = input.actions.length
  if (method === 'scroll') {
    for (const key of ['scrollX', 'scrollY']) {
      const number = Number(input[key])
      if (Number.isFinite(number)) summary[key] = number
    }
  }
  return summary
}

/** The app identities a tool result mentions, most specific first. */
export function appsInResult(method, value) {
  return collectApps(method, value, [], 0)
}

/**
 * One machine-written fact about a Computer Use call. Pure function: the caller
 * decides when to persist it, which keeps the failure path side-effect free.
 */
export function observationFor(input) {
  const source = input && typeof input === 'object' ? input : {}
  const method = String(source.method || '')
  const value = source.value
  const error = source.error
  const ax = accessibilityOf(value)
  const apps = collectApps(method, value)
  const includeText = Boolean(source.args && typeof source.args === 'object' && source.args.include_text === true)
  const observation = {
    kind: 'call',
    id: crypto.randomBytes(4).toString('hex'),
    at: new Date().toISOString(),
    turn: String(source.turn || '').slice(0, 12),
    app: apps.length > 0 ? apps[0] : null,
    method,
    ok: !error,
    callMs: Number.isFinite(Number(source.callMs)) ? Number(source.callMs) : null,
    args: argsSummary(source.args, method),
  }
  if (error) {
    observation.errorCode = errorCodeOf(error)
    observation.errorText = redactText(error.message || error, source.redact === undefined ? {} : { redactPaths: source.redact })
  }
  if (includeText) {
    observation.axRequested = true
    observation.axPresent = ax.present
    observation.axChars = ax.chars
  }
  const geometry = geometryOf(value)
  if (geometry) observation.window = geometry
  return observation
}

/* --------------------------------------------------------------- store --- */

export class ExperienceStore {
  constructor(config = {}, options = {}) {
    this.config = resolveExperienceConfig(config)
    this.dir = options.dir || experienceDir(this.config)
    this.seedPath = options.seedPath || path.join(pluginRoot(), 'helper-rs', 'assets', 'experience', 'seed.jsonl')
    this.turns = new Map()
    this.invalid = 0
  }

  get enabled() {
    return experienceEnabled(this.config)
  }

  file(name) {
    return path.join(this.dir, STORE_FILES[name])
  }

  readJsonlSafe(name) {
    const text = readText(this.file(name))
    const parsed = parseJsonl(text)
    this.invalid += parsed.invalid
    return parsed
  }

  /** lessons.jsonl only: the records this layer owns and may rewrite. */
  readLessons() {
    const parsed = this.readJsonlSafe('lessons')
    const entries = []
    let invalid = parsed.invalid
    for (const record of parsed.records) {
      const entry = normalizeEntry(record, 'model')
      if (entry) entries.push(entry)
      else invalid += 1
    }
    return { entries, invalid }
  }

  /** manual.jsonl (never rewritten) + an optional shipped seed + lessons.jsonl. */
  readAll() {
    const byId = new Map()
    let invalid = 0
    if (this.seedPath && fs.existsSync(this.seedPath)) {
      const parsed = parseJsonl(readText(this.seedPath))
      invalid += parsed.invalid
      for (const record of parsed.records) {
        const entry = normalizeEntry(record, 'seed')
        if (!entry) {
          invalid += 1
          continue
        }
        entry.source = 'seed'
        if (!byId.has(entry.id)) byId.set(entry.id, entry)
      }
    }
    const add = (name, source) => {
      const parsed = this.readJsonlSafe(name)
      invalid += parsed.invalid
      for (const record of parsed.records) {
        const entry = normalizeEntry(record, source)
        if (!entry) {
          invalid += 1
          continue
        }
        if (source !== 'model') entry.source = source
        if (!byId.has(entry.id)) byId.set(entry.id, entry)
      }
    }
    add('manual', 'user')
    add('lessons', 'model')
    const entries = [...byId.values()].sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    return { entries, invalid }
  }

  writeLessons(entries) {
    withLock(this.dir, () => {
      const body = entries.map(entry => JSON.stringify(entry)).join('\n')
      atomicWrite(this.file('lessons'), body ? body + '\n' : '')
      atomicWrite(this.file('markdown'), this.renderMarkdownText(entries))
    })
  }

  renderMarkdownText(entries) {
    const list = entries || this.readAll().entries
    const lines = []
    lines.push('# Computer Use experience notes')
    lines.push('')
    lines.push('Machine-local notes written after Computer Use tasks on this machine.')
    lines.push('**Reference only**: software updates, DPI or configuration changes can invalidate them,')
    lines.push('no note can block a tool call, and the current observation always wins.')
    lines.push('Each note carries a scope (which presets/apps see it) and a volatility (how long it holds).')
    lines.push('Live state (mounted rows, versions, processes) is answered by the snapshot action, never by a note.')
    lines.push('')
    lines.push('- Store: ' + this.dir)
    lines.push('- Generated: ' + new Date().toISOString())
    lines.push('- Entries: ' + list.length)
    lines.push('')
    const groups = new Map()
    for (const entry of list) {
      const key = (entry.app && entry.app.id) || 'unknown'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(entry)
    }
    for (const group of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      const name = group[1][0].app && group[1][0].app.name ? ' (' + group[1][0].app.name + ')' : ''
      lines.push('## ' + group[0] + name)
      lines.push('')
      for (const entry of group[1]) {
        lines.push('### ' + entry.date + ' - ' + entry.outcome + ' - ' + entry.id)
        lines.push('')
        lines.push('- statement: ' + (entry.statement || ''))
        lines.push('- kind: ' + (entry.kind || 'pitfall') + ' / volatility: ' + (entry.volatility || 'durable') + (entry.expiresAt ? ' until ' + entry.expiresAt : ''))
        lines.push('- scope: presets=' + (entry.scope && entry.scope.presets !== undefined ? (Array.isArray(entry.scope.presets) ? entry.scope.presets.join('|') : entry.scope.presets) : 'all')
          + ', apps=' + (entry.scope && entry.scope.apps !== undefined ? (Array.isArray(entry.scope.apps) ? entry.scope.apps.join('|') : entry.scope.apps) : 'all'))
        if (entry.context) lines.push('- context: ' + entry.context)
        if (entry.cause) lines.push('- cause (suspected): ' + entry.cause)
        if (entry.workaround) lines.push('- workaround: ' + entry.workaround)
        if (entry.verifyHint) lines.push('- verify: ' + entry.verifyHint)
        if (entry.tags && entry.tags.length) lines.push('- tags: ' + entry.tags.join(', '))
        const flags = []
        if (entry.source !== 'model') flags.push('source ' + entry.source)
        if (entry.verified && entry.verified.at) flags.push('verified ' + entry.verified.at)
        if (entry.stale) flags.push('marked stale')
        if (entry.supersededBy) flags.push('superseded by ' + entry.supersededBy)
        lines.push('- seen ' + (entry.seenCount || 1) + ' time(s), last ' + (entry.lastSeenAt || entry.date) + (flags.length > 0 ? ', ' + flags.join(', ') : ''))
        lines.push('')
      }
    }
    return lines.join('\n')
  }

  pruneLessons(entries, now) {
    const limit = Math.max(20, Number(this.config.retainEntries) || EXPERIENCE_DEFAULTS.retainEntries)
    if (entries.length <= limit) return entries
    const removable = entries
      .map((entry, index) => ({ entry, index }))
      .filter(item => item.entry.source !== 'user' && item.entry.source !== 'seed')
      .sort((a, b) => rankOf(a.entry, now, this.config) - rankOf(b.entry, now, this.config))
    const drop = new Set()
    for (const item of removable) {
      if (entries.length - drop.size <= limit) break
      drop.add(item.index)
    }
    return entries.filter((entry, index) => !drop.has(index))
  }

  /* ------------------------------------------------------------- writes --- */

  record(input) {
    if (!this.enabled) throw new Error('experience: the experience layer is disabled')
    return withLock(this.dir, () => {
      let entries = this.readLessons().entries
      const now = new Date()
      const incoming = buildLesson(input, now)
      const existing = entries.find(entry => !entry.supersededBy && entry.signature === incoming.signature)
      if (!existing) {
        entries.push(incoming)
        entries = this.pruneLessons(entries, now)
        this.writeLessons(entries)
        return { created: true, entry: incoming, store: this.dir }
      }
      const differs = normalizeForSignature(existing.workaround || '') !== normalizeForSignature(incoming.workaround || '')
      if (differs && incoming.workaround && incoming.outcome === 'worked' && existing.outcome !== 'worked') {
        existing.supersededBy = incoming.id
        entries.push(incoming)
        entries = this.pruneLessons(entries, now)
        this.writeLessons(entries)
        return { created: true, superseded: existing.id, entry: incoming, store: this.dir }
      }
      existing.seenCount = (existing.seenCount || 1) + 1
      existing.lastSeenAt = now.toISOString()
      existing.stale = false
      if (OUTCOME_RANK[incoming.outcome] > OUTCOME_RANK[existing.outcome]) existing.outcome = incoming.outcome
      for (const field of ['context', 'cause', 'workaround']) {
        if (!existing[field] && incoming[field]) existing[field] = incoming[field]
      }
      if (incoming.tags.length > 0) existing.tags = normalizeTags([...(existing.tags || []), ...incoming.tags])
      existing.signature = signatureOf(existing)
      this.writeLessons(entries)
      return { created: false, merged: true, entry: existing, store: this.dir }
    })
  }

  update(id, patch) {
    if (!this.enabled) throw new Error('experience: the experience layer is disabled')
    const target = clamp(id, 80)
    return withLock(this.dir, () => {
      const entries = this.readLessons().entries
      const entry = entries.find(item => item.id === target)
      if (!entry) throw new Error('experience: no note with id ' + target)
      const source = patch && typeof patch === 'object' ? patch : {}
      if (source.outcome !== undefined) {
        if (OUTCOME_RANK[source.outcome] === undefined) {
          throw new Error('experience: outcome must be worked, partial, failed or unknown')
        }
        entry.outcome = source.outcome
      }
      if (source.workaround !== undefined) entry.workaround = clamp(source.workaround, LIMITS.workaround)
      if (source.cause !== undefined) entry.cause = clamp(source.cause, LIMITS.cause)
      if (source.context !== undefined) entry.context = clamp(source.context, LIMITS.context)
      if (source.supersededBy !== undefined) entry.supersededBy = source.supersededBy ? clamp(source.supersededBy, 80) : null
      if (source.stale !== undefined) entry.stale = source.stale === true
      if (source.tags !== undefined) entry.tags = normalizeTags(source.tags)
      if (source.statement !== undefined) entry.statement = clamp(source.statement, LIMITS.statement)
      if (source.kind !== undefined) {
        if (!NOTE_KINDS.has(source.kind)) throw new Error('experience: kind must be fact, pitfall or pointer')
        entry.kind = source.kind
      }
      if (source.scope !== undefined) entry.scope = normalizeScope(source.scope, entry.scope && entry.scope.presets)
      if (source.volatility !== undefined || source.expiresAt !== undefined) {
        const next = normalizeVolatility(
          source.volatility === undefined ? entry.volatility : source.volatility,
          source.expiresAt === undefined ? entry.expiresAt : source.expiresAt,
        )
        entry.volatility = next.volatility
        entry.expiresAt = next.expiresAt
      }
      if (source.verifyHint !== undefined) entry.verifyHint = source.verifyHint ? clamp(source.verifyHint, LIMITS.verifyHint) : undefined
      if (source.verified) {
        const result = source.verified === true ? (entry.outcome === 'unknown' ? 'worked' : entry.outcome) : String(source.verified)
        entry.verified = { at: new Date().toISOString(), result }
        entry.lastSeenAt = entry.verified.at
        entry.seenCount = (entry.seenCount || 1) + 1
        entry.stale = false
      }
      entry.signature = signatureOf(entry)
      this.writeLessons(entries)
      return { entry, store: this.dir }
    })
  }

  /* -------------------------------------------------------------- reads --- */

  list(query) {
    const input = query && typeof query === 'object' ? query : {}
    const { entries } = this.readAll()
    const now = new Date()
    const app = input.app ? String(appKeyOf(input.app) || '') : ''
    const tag = input.tag ? clamp(input.tag, LIMITS.tag).toLowerCase() : ''
    const since = input.since ? String(input.since) : ''
    const filtered = entries
      .filter(entry => {
        if (app && appKeyOf(entry.app) !== app) return false
        if (tag && !(entry.tags || []).includes(tag)) return false
        if (since && String(entry.date || '') < since) return false
        if (input.includeSuperseded !== true && entry.supersededBy) return false
        return true
      })
      .sort((a, b) => rankOf(b, now, this.config) - rankOf(a, now, this.config))
    const limit = Number(input.limit) > 0 ? Math.min(Number(input.limit), 50) : 10
    return {
      count: filtered.length,
      entries: filtered.slice(0, limit).map(entry => summarizeEntry(entry, now, this.config)),
      store: this.dir,
    }
  }

  get(id) {
    const target = clamp(id, 80)
    const { entries } = this.readAll()
    const entry = entries.find(item => item.id === target)
    if (!entry) return null
    return summarizeEntry(entry, new Date(), this.config)
  }

  /**
   * The advisory block attached to the first observation of an app in a turn.
   * V2: `context.preset` filters by the note's scope, so a note recorded under one
   * preset never injects into another one; expired until-date notes behave like
   * stale ones (visible but labelled under the default includeStale, dropped otherwise).
   */
  digest(appKey, appName, context) {
    if (!this.enabled || this.config.injectDigest === false) return null
    const key = String(appKey || '').toLowerCase().replace(/\.exe$/, '')
    if (!key) return null
    let entries = []
    try {
      entries = this.readAll().entries
    } catch {
      return null
    }
    const now = new Date()
    const matches = entries
      .filter(entry => !entry.supersededBy && appKeyOf(entry.app) === key)
      .filter(entry => scopeMatches(entry.scope, { preset: context && context.preset, appKey: key }))
      .filter(entry => this.config.includeStale !== false || (!entry.stale && !volatilityExpired(entry, now) && !isExpired(entry, now, this.config)))
      .sort((a, b) => rankOf(b, now, this.config) - rankOf(a, now, this.config))
    const pending = this.pendingFor(key)
    if (matches.length === 0 && pending === 0) return null
    const digest = {
      advisory: true,
      app: appName || key,
      notes: [],
      pending,
      hint: 'historical, machine-local, advisory: not a rule, may be outdated after an upgrade, the current observation wins',
    }
    const maxEntries = Math.max(1, Number(this.config.maxEntries) || EXPERIENCE_DEFAULTS.maxEntries)
    const maxChars = Math.max(200, Number(this.config.maxChars) || EXPERIENCE_DEFAULTS.maxChars)
    for (const entry of matches.slice(0, maxEntries)) {
      digest.notes.push(noteOf(entry, now, this.config))
      while (digest.notes.length > 1 && formatDigest(digest).length > maxChars) digest.notes.pop()
    }
    if (formatDigest(digest).length > maxChars && digest.notes.length > 0) digest.notes = []
    return digest
  }

  /* ------------------------------------------------------------- snapshot --- */

  /**
   * V3: the live state card. Anything readable from the system (mounted MCP rows,
   * bundles, the preset this session runs under) is answered from HERE, regenerated on
   * every call, never from a stored note. Best-effort by contract (D-1): a missing or
   * unreadable file degrades that one field to "unknown" and never throws.
   */
  snapshot(facts) {
    const input = facts && typeof facts === 'object' ? facts : {}
    const card = {
      kind: 'live-snapshot',
      at: new Date().toISOString(),
      preset: clamp(input.preset, 60) || 'unknown',
      note: 'live state, regenerated on every call; a stored lesson cannot answer state questions',
    }
    if (Array.isArray(input.surfaces)) card.surfaces = input.surfaces
    if (Array.isArray(input.exposedTools)) card.exposedTools = input.exposedTools
    if (input.helper !== undefined) card.helper = input.helper
    // <profile> = .experience -> dsh-computer-use -> node_modules -> <profile>
    const profileRoot = path.resolve(this.dir, '..', '..', '..')
    try {
      const pkg = JSON.parse(readText(path.join(profileRoot, 'package.json')) || '{}')
      card.bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
        ? pkg.dsh.profile.bundles
        : []
    } catch {
      card.bundles = 'unknown (profile package.json unreadable)'
    }
    card.mcpRowsByPreset = this.mcpRowsByPreset(path.join(profileRoot, 'node_modules', 'dsh-presets-extra', 'cordis.patch.yml'))
    return card
  }

  /** Best-effort scan of the generated preset patch: which preset mounts which MCP server. */
  mcpRowsByPreset(patchFile) {
    const text = readText(patchFile)
    if (!text) return { source: patchFile, rows: {}, note: 'patch file missing or unreadable' }
    const rows = {}
    let current = null
    for (const line of text.split('\n')) {
      const preset = line.match(/^\s*- id: preset-([A-Za-z0-9-]+)\s*$/)
      if (preset) {
        current = preset[1]
        continue
      }
      const mcp = line.match(/^\s*- id: (mcp-[A-Za-z0-9-]+)\s*$/)
      if (mcp && current) {
        if (!rows[current]) rows[current] = []
        if (!rows[current].includes(mcp[1])) rows[current].push(mcp[1])
      }
    }
    return { source: patchFile, rows }
  }

  /* -------------------------------------------------------- observations --- */

  observe(turnKey, observation) {
    if (!this.enabled || !observation || typeof observation !== 'object') return
    const key = String(turnKey || 'turn')
    let turn = this.turns.get(key)
    if (!turn) {
      turn = { calls: 0, apps: new Set(), failures: new Map(), ax: new Map(), startedAt: Date.now() }
      this.turns.set(key, turn)
      if (this.turns.size > 64) this.turns.delete(this.turns.keys().next().value)
    }
    turn.calls += 1
    const app = observation.app ? String(appKeyOf(observation.app) || '') : ''
    if (app) turn.apps.add(app)
    if (observation.ok === false) {
      const signature = (app || 'unknown') + '|' + (observation.errorCode || 'error')
      const hit = turn.failures.get(signature) || { app: app || 'unknown', code: observation.errorCode || 'error', count: 0, sample: '' }
      hit.count += 1
      if (!hit.sample && observation.errorText) hit.sample = observation.errorText
      turn.failures.set(signature, hit)
    }
    if (observation.axRequested) {
      const stat = turn.ax.get(app || 'unknown') || { requested: 0, present: 0 }
      stat.requested += 1
      if (observation.axPresent) stat.present += 1
      turn.ax.set(app || 'unknown', stat)
    }
    if (this.config.captureObservations !== false) this.appendObservation(observation)
  }

  appendObservation(observation) {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.file('observations'), JSON.stringify(observation) + '\n')
    } catch {
      // I1: an unwritable store never fails a Computer Use call.
    }
  }

  pendingFor(appKey) {
    const parsed = this.readJsonlSafe('pending')
    const cutoff = Date.now() - PENDING_DAYS * 86400000
    return parsed.records.filter(record => {
      const stamp = Date.parse(record.at || '')
      if (!Number.isFinite(stamp) || stamp < cutoff) return false
      return String(record.app || '') === String(appKey || '')
    }).length
  }

  /** Turn end: summarise what happened and queue the problems nobody wrote up. */
  settleTurn(conversationId, turnId) {
    if (!this.enabled) return { settled: 0, pending: 0 }
    const base = conversationId === undefined || conversationId === null ? '' : String(conversationId)
    const wanted = turnId === undefined || turnId === null || turnId === '' ? 'turn' : String(turnId)
    const keys = [base + '\u0000' + wanted]
    if (wanted !== 'turn') keys.push(base + '\u0000turn')
    let settled = 0
    let pending = 0
    for (const key of keys) {
      const turn = this.turns.get(key)
      if (!turn) continue
      this.turns.delete(key)
      settled += 1
      pending += this.writePending(turn)
      this.appendSummary(key, turn)
    }
    if (settled > 0) this.compactObservations()
    return { settled, pending }
  }

  appendSummary(key, turn) {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
      const summary = {
        kind: 'turn-summary',
        at: new Date().toISOString(),
        turn: String(key).split('\u0000')[1] || 'turn',
        calls: turn.calls,
        apps: [...turn.apps],
        failures: [...turn.failures.values()].map(hit => ({ app: hit.app, code: hit.code, count: hit.count })),
        ax: [...turn.ax.entries()].map(pair => ({ app: pair[0], requested: pair[1].requested, present: pair[1].present })),
        durationMs: Date.now() - turn.startedAt,
      }
      fs.appendFileSync(this.file('observations'), JSON.stringify(summary) + '\n')
    } catch {
      // best effort
    }
  }

  writePending(turn) {
    const candidates = []
    for (const hit of turn.failures.values()) {
      if (hit.count < 2) continue
      candidates.push({
        app: hit.app,
        kind: 'failure',
        signature: hit.app + '|failure|' + hit.code,
        sample: hit.sample,
        counts: { hits: hit.count, calls: turn.calls },
        hint: hit.app + ' failed ' + hit.count + ' times with ' + hit.code + ' in one task; write down the cause or the workaround',
      })
    }
    for (const pair of turn.ax.entries()) {
      if (pair[1].requested < 2 || pair[1].present !== 0) continue
      candidates.push({
        app: pair[0],
        kind: 'ax-empty',
        signature: pair[0] + '|ax-empty',
        sample: 'accessibility was empty in all ' + pair[1].requested + ' text observations',
        counts: { requested: pair[1].requested, present: 0, calls: turn.calls },
        hint: pair[0] + ' returned no accessibility tree in ' + pair[1].requested + ' observations; note how you worked around it',
      })
    }
    if (candidates.length === 0) return 0
    let written = 0
    try {
      const existingPending = this.readJsonlSafe('pending').records
      const lessons = this.readAll().entries
      const fresh = []
      for (const candidate of candidates) {
        if (existingPending.some(record => record.signature === candidate.signature)) continue
        const covered = lessons.some(entry => appKeyOf(entry.app) === candidate.app && (entry.tags || []).includes(candidate.kind))
        if (covered) continue
        fresh.push({ id: crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), ...candidate })
      }
      if (fresh.length === 0) return 0
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.file('pending'), fresh.map(record => JSON.stringify(record)).join('\n') + '\n')
      written = fresh.length
    } catch {
      return written
    }
    return written
  }

  compactObservations() {
    const file = this.file('observations')
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    if (text.length < MAX_OBSERVATION_BYTES / 2) return
    const days = Math.max(1, Number(this.config.retainObservationDays) || EXPERIENCE_DEFAULTS.retainObservationDays)
    const cutoff = Date.now() - days * 86400000
    const kept = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const record = JSON.parse(trimmed)
        const at = Date.parse(record.at || '')
        if (!Number.isFinite(at) || at >= cutoff) kept.push(trimmed)
      } catch {
        // Drop the corrupt line rather than growing forever.
      }
    }
    try {
      atomicWrite(file, kept.length > 0 ? kept.join('\n') + '\n' : '')
    } catch {
      // best effort
    }
  }

  stats() {
    let entries = []
    let invalid = this.invalid
    try {
      const all = this.readAll()
      entries = all.entries
      invalid += all.invalid
    } catch {
      // report what we can
    }
    const now = new Date()
    return {
      enabled: this.enabled,
      dir: this.dir,
      injectDigest: this.config.injectDigest !== false,
      captureObservations: this.config.captureObservations !== false,
      lessons: entries.filter(entry => entry.source !== 'seed').length,
      pending: this.readJsonlSafe('pending').records.length,
      observations: countLines(this.file('observations')),
      invalid,
      openTurns: this.turns.size,
      latest: entries.slice(0, 3).map(entry => summarizeEntry(entry, now, this.config)),
    }
  }
}

export function createExperience(config = {}, options = {}) {
  return new ExperienceStore(config, options)
}

/** Whether a method's result may carry a digest (the app-identifying observations). */
export function isDigestMethod(method) {
  return DIGEST_METHODS.has(String(method || ''))
}

/**
 * Null object for a session without the host-plane service (and for tests): every
 * call is a no-op, record/update explain themselves instead of pretending.
 */
export const NOOP_EXPERIENCE = {
  enabled: false,
  dir: '',
  observe() {},
  settleTurn() {
    return { settled: 0, pending: 0 }
  },
  digest() {
    return null
  },
  list() {
    return { count: 0, entries: [], store: '' }
  },
  get() {
    return null
  },
  stats() {
    return { enabled: false, dir: '', lessons: 0, pending: 0, observations: 0, invalid: 0, latest: [] }
  },
  snapshot() {
    return { kind: 'live-snapshot', at: new Date().toISOString(), preset: 'unknown', note: 'experience layer not mounted' }
  },
  renderMarkdownText() {
    return ''
  },
  record() {
    throw new Error('experience: the Computer Use host service is not mounted in this session')
  },
  update() {
    throw new Error('experience: the Computer Use host service is not mounted in this session')
  },
}
