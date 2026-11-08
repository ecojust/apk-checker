import { describe, expect, it } from "vitest";
import { parseForegroundActivity, parseKeyguardLocked } from "../electron/launch-state";

const primary = "Display #0 (activities from top to bottom):";
const secondary = "Display #2 (activities from top to bottom):";
const app = "ActivityRecord{abc u0 org.example.app/.Main$Inner t17}";
const home = "ActivityRecord{def u0 com.android.launcher/.Home t1}";
const modern = `  topResumedActivity=${app}`;

describe("primary display foreground parsing", () => {
  it("reads the API 36 root-task resumed record and preserves the exact component", () => {
    expect(parseForegroundActivity(`${primary}\n${modern}`, 0)).toEqual({
      component: "org.example.app/.Main$Inner",
      packageName: "org.example.app",
      userId: 0,
    });
  });

  it("reads the unique API 30 mResumedActivity record", () => {
    expect(parseForegroundActivity(`${primary}\n    mResumedActivity: ${app}`, 0)?.packageName)
      .toBe("org.example.app");
  });

  it("prefers an explicit modern resumed record over legacy records", () => {
    expect(parseForegroundActivity(`${primary}\n    mResumedActivity: ${home}\n${modern}`, 0)?.packageName)
      .toBe("org.example.app");
  });

  it("does not confuse secondary displays or display-less global summaries with the primary display", () => {
    const output = `${secondary}\n${modern}\n${primary}\n  topResumedActivity=${home}\n  ResumedActivity: ${app}`;
    expect(parseForegroundActivity(output, 0)?.packageName).toBe("com.android.launcher");
    expect(parseForegroundActivity(`${primary}\n${secondary}\n${modern}`, 0)).toBeUndefined();
    expect(parseForegroundActivity(`  ResumedActivity: ${app}`, 0)).toBeUndefined();
  });

  it("matches the Android user exactly", () => {
    expect(parseForegroundActivity(`${primary}\n${modern}`, 10)).toBeUndefined();
    expect(parseForegroundActivity(`${primary}\n${modern.replace("u0", "u10")}`, 10)?.userId).toBe(10);
  });

  it("can identify the built-in android package while a system activity is foreground", () => {
    expect(parseForegroundActivity(`${primary}\n  topResumedActivity=ActivityRecord{ab u0 android/com.android.internal.app.ResolverActivity t2}`, 0)?.packageName)
      .toBe("android");
  });

  it("ignores history, paused and finishing activity records", () => {
    const history = `${primary}\n  * Hist #0: ${app}\n  mLastPausedActivity: ${app}`;
    expect(parseForegroundActivity(history, 0)).toBeUndefined();
    expect(parseForegroundActivity(`${history}\n  Activities waiting to finish:\n${modern}`, 0)).toBeUndefined();
  });

  it.each([" t17 f}}", " t17 isExiting}", " t17 f} isExiting}", " t-1}"])(
    "does not accept a resumed record that is finishing, exiting or detached: %s",
    (suffix) => {
      expect(parseForegroundActivity(`${primary}\n${modern.replace(" t17}", suffix)}`, 0)).toBeUndefined();
    },
  );

  it("deduplicates the same resumed record but rejects conflicting root tasks", () => {
    expect(parseForegroundActivity(`${primary}\n${modern}\n${modern}`, 0)?.packageName).toBe("org.example.app");
    expect(parseForegroundActivity(`${primary}\n${modern}\n  topResumedActivity=${home}`, 0)).toBeUndefined();
    expect(parseForegroundActivity(`${primary}\n  mResumedActivity: ${app}\n  mResumedActivity: ${home}`, 0)).toBeUndefined();
  });

  it("does not fall back to a legacy record when the modern foreground is null or malformed", () => {
    for (const value of ["null", "ActivityRecord{broken}"]) {
      expect(parseForegroundActivity(`${primary}\n  topResumedActivity=${value}\n  mResumedActivity: ${app}`, 0)).toBeUndefined();
    }
  });

  it("rejects display-less, duplicated primary sections and malformed users/components", () => {
    expect(parseForegroundActivity(modern, 0)).toBeUndefined();
    expect(parseForegroundActivity(`${primary}\n${modern}\n${primary}\n${modern}`, 0)).toBeUndefined();
    expect(parseForegroundActivity(`${primary}\n${modern.replace("u0", "u9007199254740993")}`, 0)).toBeUndefined();
    expect(parseForegroundActivity(`${primary}\n${modern.replace(".Main$Inner", ".Main;id")}`, 0)).toBeUndefined();
    expect(parseForegroundActivity(`${primary}\n${modern}`, -1)).toBeUndefined();
  });
});

describe("primary display keyguard parsing", () => {
  const unlocked = "  KeyguardController:\n    mKeyguardShowing=false\n    mAodShowing=false\n    mKeyguardGoingAway=false";

  it("reads the API 30 global/default-display fields", () => {
    expect(parseKeyguardLocked(unlocked)).toBe(false);
    expect(parseKeyguardLocked(unlocked.replace("mKeyguardShowing=false", "mKeyguardShowing=true"))).toBe(true);
  });

  it("does not let API 36 secondary-display details override the default-display state", () => {
    expect(parseKeyguardLocked(`${unlocked}\n   KeyguardShowing=true AodShowing=true at display=2`)).toBe(false);
    expect(parseKeyguardLocked(`${unlocked.replace("mKeyguardShowing=false", "mKeyguardShowing=true")}\n   KeyguardShowing=false AodShowing=false at display=2`)).toBe(true);
  });

  it("treats AOD and an in-progress keyguard transition as locked", () => {
    expect(parseKeyguardLocked(unlocked.replace("mAodShowing=false", "mAodShowing=true"))).toBe(true);
    expect(parseKeyguardLocked(unlocked.replace("mKeyguardGoingAway=false", "mKeyguardGoingAway=true"))).toBe(true);
  });

  it("requires explicit unlocked evidence in a single controller block", () => {
    expect(parseKeyguardLocked("mKeyguardShowing=false\nmAodShowing=false")).toBeUndefined();
    expect(parseKeyguardLocked("KeyguardController:\n  mKeyguardShowing=false")).toBeUndefined();
    expect(parseKeyguardLocked(`${unlocked}\n${unlocked}`)).toBeUndefined();
    expect(parseKeyguardLocked(`${unlocked}\n    mKeyguardShowing=true`)).toBeUndefined();
  });

  it("does not read keyguard-looking fields outside the controller block", () => {
    expect(parseKeyguardLocked("KeyguardController:\nOtherController:\n  mKeyguardShowing=false\n  mAodShowing=false")).toBeUndefined();
    expect(parseKeyguardLocked(`${unlocked}\n  OtherController:\n    mKeyguardShowing=true`)).toBe(false);
  });
});
