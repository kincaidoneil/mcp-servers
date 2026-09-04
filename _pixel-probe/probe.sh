#!/usr/bin/env bash
# Virtual-display feasibility probe for Android agent control.
# Read-only except: creates a virtual display and launches one app on it.
# Taps nothing. Sends nothing. Ctrl-C to abort at any point.
set -uo pipefail

TARGET_PKG="${1:-co.hinge.app}"
say() { printf "\n\033[1m== %s\033[0m\n" "$*"; }
ok()  { printf "  \033[32mPASS\033[0m %s\n" "$*"; }
no()  { printf "  \033[31mFAIL\033[0m %s\n" "$*"; }
hm()  { printf "  \033[33m????\033[0m %s\n" "$*"; }

say "0. Toolchain"
for t in adb scrcpy; do
  if command -v "$t" >/dev/null; then ok "$t $($t --version 2>/dev/null | head -1)"
  else no "$t missing -> brew install android-platform-tools scrcpy"; MISSING=1; fi
done
[ "${MISSING:-0}" = 1 ] && exit 1

say "1. Device"
adb devices -l | sed 's/^/  /'
[ "$(adb devices | grep -cw device)" -eq 0 ] && { no "no authorized device"; exit 1; }
REL=$(adb shell getprop ro.build.version.release | tr -d '\r')
SDK=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
MODEL=$(adb shell getprop ro.product.model | tr -d '\r')
ok "$MODEL, Android $REL (API $SDK)"
[ "$SDK" -ge 34 ] && ok "API >= 34, virtual display gets OWN_FOCUS (you can keep using the phone)" \
                  || no "API < 34, no OWN_FOCUS: the virtual display will steal focus from you"

say "2. Platform prerequisites"
adb shell pm list features 2>/dev/null | grep -q activities_on_secondary_displays \
  && ok "FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS declared" \
  || no "feature absent -> apps cannot launch on secondary displays at all"
# The permission Google deleted in 15-QPR2 and restored in 16.
if adb shell dumpsys package com.android.shell 2>/dev/null | grep -q ADD_TRUSTED_DISPLAY; then
  ok "shell holds ADD_TRUSTED_DISPLAY (trusted virtual displays possible)"
else
  no "shell lacks ADD_TRUSTED_DISPLAY -> untrusted display, almost nothing will launch"
fi

say "3. Target app"
adb shell pm list packages 2>/dev/null | grep -q "^package:${TARGET_PKG}$" \
  && ok "$TARGET_PKG installed" || { no "$TARGET_PKG not installed"; exit 1; }

say "4. Baseline: can we read the UI tree at all?"
adb shell uiautomator dump --windows /sdcard/_probe_win.xml >/dev/null 2>&1 \
  && ok "uiautomator dump --windows supported (multi-display aware)" \
  || hm "--windows unsupported, falling back to bare dump (display metadata will be wrong)"

say "5. Creating virtual display and launching $TARGET_PKG"
echo "  Watch your phone. Its screen should stay on whatever you left it on."
scrcpy --new-display=1600x2560/400 --start-app="$TARGET_PKG" \
       --keep-active --display-ime-policy=local --no-audio \
       --window-title="probe (close me when done)" &
SCRCPY_PID=$!
sleep 9

say "6. What happened"
DISPLAYS=$(adb shell dumpsys display 2>/dev/null | grep -Eo 'mDisplayId=[0-9]+' | grep -Eo '[0-9]+' | sort -un | tr '\n' ' ')
ok "display ids present: $DISPLAYS"
VD=$(echo $DISPLAYS | tr ' ' '\n' | grep -v '^0$' | tail -1)
if [ -z "$VD" ]; then no "no secondary display was created"; else ok "virtual display id = $VD"; fi

adb shell uiautomator dump --windows /sdcard/_probe_after.xml >/dev/null 2>&1
adb pull /sdcard/_probe_after.xml ./probe_tree.xml >/dev/null 2>&1
if [ -f ./probe_tree.xml ]; then
  ok "UI tree saved to $(pwd)/probe_tree.xml ($(wc -c < ./probe_tree.xml) bytes)"
  grep -q "$TARGET_PKG" ./probe_tree.xml \
    && ok "TARGET APP IS READABLE IN THE TREE" \
    || no "target app not found in tree (may have fallen back to main display)"
  echo "  displays seen in tree:"; grep -Eo '<display id="[0-9]+"[^>]*' ./probe_tree.xml | sed 's/^/    /'
  TEXTNODES=$(grep -Eo 'text="[^"]{2,}"' ./probe_tree.xml | wc -l | tr -d ' ')
  [ "$TEXTNODES" -gt 5 ] && ok "$TEXTNODES text nodes readable (FLAG_SECURE does not strip the a11y tree)" \
                         || hm "only $TEXTNODES text nodes: app may render text as canvas/Compose without semantics"
fi

say "7. Screenshot of the virtual display (blank => FLAG_SECURE)"
if [ -n "${VD:-}" ]; then
  adb exec-out screencap -d "$VD" -p > ./probe_vd.png 2>/dev/null
  SZ=$(wc -c < ./probe_vd.png | tr -d ' ')
  [ "$SZ" -gt 20000 ] && ok "captured probe_vd.png ($SZ bytes) - open it, is it the app or black?" \
                      || no "capture is $SZ bytes: display blanked, almost certainly FLAG_SECURE"
fi

say "Done. Leaving scrcpy running so you can look at it."
echo "  Kill it with: kill $SCRCPY_PID"
echo "  Then tell Claude what probe_tree.xml and probe_vd.png look like."
