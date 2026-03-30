#!/usr/bin/env node
/**
 * Context Monitor Hook — AdSpot
 * Warns when Claude context window is running low.
 * Adapted from gsd-build/get-shit-done context monitor.
 *
 * Triggers: PostToolUse
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const WARNING_THRESHOLD = 0.35  // warn at 35% remaining
const CRITICAL_THRESHOLD = 0.25 // critical at 25% remaining
const DEBOUNCE_TOOL_USES = 5    // suppress warnings every N tool uses
const STALE_DATA_MS = 60000     // ignore metrics older than 60s

let toolUseCount = 0

function run(rawInput) {
  try {
    const input = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput
    toolUseCount++

    const sessionId = input?.session_id || 'default'
    const metricsPath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`)

    if (!fs.existsSync(metricsPath)) return

    const raw = fs.readFileSync(metricsPath, 'utf8')
    const metrics = JSON.parse(raw)

    // Stale data check
    if (Date.now() - (metrics.timestamp || 0) > STALE_DATA_MS) return

    const remaining = metrics.remaining_ratio ?? 1
    const isCritical = remaining <= CRITICAL_THRESHOLD
    const isWarning = remaining <= WARNING_THRESHOLD

    if (!isWarning) return

    // Debounce — suppress unless critical
    if (!isCritical && toolUseCount % DEBOUNCE_TOOL_USES !== 0) return

    const pct = Math.round(remaining * 100)
    const level = isCritical ? 'CRITICAL' : 'WARNING'
    const msg = isCritical
      ? `[CTX ${level}] Only ${pct}% context remaining. Wrap up current task and summarize state to STATE.md before continuing.`
      : `[CTX ${level}] ${pct}% context remaining. Consider committing progress and starting fresh context.`

    process.stderr.write(msg + '\n')
  } catch {
    // Parse errors: exit 0 silently
  }
  process.exit(0)
}

// Support both direct invocation and module export
if (require.main === module) {
  let input = ''
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => run(input))
} else {
  module.exports = { run }
}
