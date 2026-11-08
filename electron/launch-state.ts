export interface ForegroundActivity {
  component: string;
  packageName: string;
  userId: number;
}

const ACTIVITY_RECORD =
  /^ActivityRecord\{[^\s{}]+\s+u(\d+)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\/([A-Za-z0-9_.$]+)\s+t\d+\}\s*$/;

/** Read the primary display's resumed activity, never an arbitrary history entry. */
export function parseForegroundActivity(
  output: string,
  userId: number,
): ForegroundActivity | undefined {
  if (!Number.isSafeInteger(userId) || userId < 0) return undefined;
  let display: number | undefined;
  let primarySections = 0;
  let topSeen = false;
  let invalidTop = false;
  let invalidLegacy = false;
  const top = new Map<string, ForegroundActivity>();
  const legacy = new Map<string, ForegroundActivity>();

  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^Display #(\d+) \(activities from top to bottom\):\s*$/);
    if (header) {
      display = Number(header[1]);
      if (display === 0) primarySections += 1;
      continue;
    }
    // These summaries follow all display sections. Their activity records do
    // not identify a display, and waiting/finishing activities are not foreground.
    if (/^\s*(?:ResumedActivity:|Activities waiting to (?:finish|stop):|KeyguardController:)/.test(line)) {
      display = undefined;
      continue;
    }
    if (display !== 0) continue;
    const field = line.match(/^\s*(topResumedActivity=|mResumedActivity:)\s*(.*?)\s*$/);
    if (!field) continue;
    const isTop = field[1] === "topResumedActivity=";
    if (isTop) topSeen = true;
    const record = field[2].match(ACTIVITY_RECORD);
    if (!record || !Number.isSafeInteger(Number(record[1]))) {
      if (isTop) invalidTop = true;
      else invalidLegacy = true;
      continue;
    }
    const activity: ForegroundActivity = {
      userId: Number(record[1]),
      packageName: record[2],
      component: `${record[2]}/${record[3]}`,
    };
    (isTop ? top : legacy).set(`${activity.userId}:${activity.component}`, activity);
  }

  // Android 11 uses mResumedActivity; newer versions use topResumedActivity
  // per root task. Multiple distinct resumed tasks are ambiguous, even if one
  // happens to belong to the requested package or user.
  const candidates = topSeen ? top : legacy;
  if (primarySections !== 1 || (topSeen ? invalidTop : invalidLegacy) || candidates.size !== 1)
    return undefined;
  const activity = candidates.values().next().value;
  return activity?.userId === userId ? activity : undefined;
}

/** Undefined means the dump cannot establish that the primary display is unlocked. */
export function parseKeyguardLocked(output: string): boolean | undefined {
  const blocks: Array<{ showing?: boolean; aod?: boolean; goingAway?: boolean; invalid: boolean }> = [];
  let prefix: string | undefined;
  let state: (typeof blocks)[number] | undefined;
  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^(\s*)KeyguardController:\s*$/);
    if (header) {
      prefix = header[1];
      state = { invalid: false };
      blocks.push(state);
      continue;
    }
    if (!state || prefix === undefined || !line.trim()) continue;
    const indentation = line.match(/^\s*/)?.[0].length || 0;
    if (indentation <= prefix.length) {
      state = undefined;
      prefix = undefined;
      continue;
    }
    // In both API 30 and 36 these m-prefixed fields describe DEFAULT_DISPLAY.
    // Per-display detail lines use different names and must not override them.
    const field = line.match(/^\s*m(KeyguardShowing|AodShowing|KeyguardGoingAway)=(true|false)\s*$/);
    if (!field) continue;
    const key = field[1] === "KeyguardShowing" ? "showing"
      : field[1] === "AodShowing" ? "aod" : "goingAway";
    const value = field[2] === "true";
    if (state[key] !== undefined && state[key] !== value) state.invalid = true;
    state[key] = value;
  }
  if (blocks.length !== 1 || blocks[0].invalid) return undefined;
  const result = blocks[0];
  if (result.showing || result.aod || result.goingAway) return true;
  return result.showing === false && result.aod === false ? false : undefined;
}
