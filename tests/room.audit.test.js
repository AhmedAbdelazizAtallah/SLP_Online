// SIGN ROOMS audit regression suite.
//
// Locks in the fixes for the room controls: dead buttons, controls that fought
// each other, and the two headline functional errors (an invisible avatar and an
// AUTO-SPEAK toggle that could never fire for signed text).
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(ROOT + '/app.html', 'utf8');
const bundle = fs.readFileSync(ROOT + '/app.compiled.js', 'utf8');

let fails = 0;
const ok = (m) => console.log('PASS: ' + m);
const bad = (m) => { fails++; console.log('FAIL: ' + m); };
const has = (s) => src.includes(s);
const count = (re) => (src.match(re) || []).length;

/* ---------- #1 the in-call avatar must be visible ---------- */
has("tab==='net' ? 'av-host-net'")
  ? ok('#1 room tab resolves a real avatar host (was falling back to the off-screen keeper)')
  : bad('#1 room tab still has no avatar host');
has("id=\"av-host-net\"")
  ? ok('#1 the av-host-net element exists in RoomStage') : bad('#1 av-host-net element missing');
count(/id="av-host-net"/g) === 2
  ? ok('#1 avatar host present in BOTH split and pip stage layouts') : bad('#1 avatar host missing from one stage layout, count=' + count(/id="av-host-net"/g));
/setAvatarHost\(el\);\s*\},\[tab, avatarKeeper, roomSignOn\]\)/.test(src)
  ? ok('#1 host resolution re-runs when the room slot mounts') : bad('#1 host effect does not depend on roomSignOn');
// every sign trigger must go through playRoomSign, which mounts the slot first:
// the local send, plus both receive transports.
has("if(mode === 'sign') playRoomSign(t);") && count(/if\(m\.sign\) playRoomSign\(m\.text\);/g) === 2
  ? ok('#1 all 3 sign triggers (local send + both transports) mount the slot')
  : bad('#1 not every sign trigger uses playRoomSign');
!/setBuilderText\(m\.text\); setTimeout\(\(\)=>playAvatarSequence/.test(src)
  ? ok('#1 no raw off-screen playback path left') : bad('#1 a raw playAvatarSequence sign path remains');
// and the slot must be retired again, with a safety timeout
/clearTimeout\(roomSignTimerRef\.current\);\s*setRoomSignOn\(false\);/.test(src)
  ? ok('#1 slot is retired when playback finishes') : bad('#1 slot is never retired');
has('ROOM_SIGN_MAX_MS')
  ? ok('#1 slot has a hard timeout if playback never reports completion') : bad('#1 no safety timeout on the slot');

/* ---------- #2 AUTO-SPEAK / provenance ---------- */
has('const shouldSpeakIncoming')
  ? ok('#2 incoming-speech decision is a single shared rule') : bad('#2 shouldSpeakIncoming missing');
!has("autoSpeakRef.current && m.kind!=='chat'")
  ? ok('#2 AUTO-SPEAK no longer requires kind!==chat (it never fired for SEND)') : bad('#2 AUTO-SPEAK still gated on message kind');
count(/shouldSpeakIncoming\(m\)/g) === 2
  ? ok('#2 both transports use the shared rule') : bad('#2 rule not applied to both transports, count=' + count(/shouldSpeakIncoming\(m\)/g));
has('if(roomMutedRef.current) return false;')
  ? ok('#2 SOUND OFF still overrides everything') : bad('#2 SOUND OFF no longer overrides speech');
has("(mode==='sign' || draftSignRef.current) ? 'sign' : 'chat'")
  ? ok('#2 kind now carries provenance, not which button was pressed') : bad('#2 kind is still button-derived');
has('draftSignRef.current = true;')
  ? ok('#2 sign commits mark the draft as signed') : bad('#2 signed drafts are not marked');
has('const typeRoomDraft = (v)=>{ draftSignRef.current=false; setRoomDraft(v); }')
  ? ok('#2 typing clears the signed-provenance flag') : bad('#2 typing does not reset provenance');
has('if(!base) draftSignRef.current = false;')
  ? ok('#2 dictated text is not misreported as signing') : bad('#2 speech can be reported as sign provenance');

/* ---------- #5 transport parity ---------- */
count(/kind:m\.kind\|\|'chat'/g) === 2
  ? ok('#5 DataChannel and WebSocket agree on the kind fallback') : bad('#5 kind fallback still differs per transport');
!has("kind:m.kind||'sign'")
  ? ok('#5 the sign-defaulting fallback is gone') : bad("#5 a kind||'sign' fallback remains");

/* ---------- #3 / #9 recording ---------- */
has('mr.onstop=()=>{ if(recSaveRef.current) saveRec(); else recChunksRef.current=[]; }')
  ? ok('#3 recording is saved from onstop (no dropped tail chunk)') : bad('#3 recording still saved synchronously after stop()');
has('if(recRef2.current) stopRec(true);')
  ? ok('#3 LEAVE saves the recording instead of discarding it') : bad('#3 LEAVE still throws the recording away');
!/recRef2\.current=null; setRecOn\(false\); recChunksRef\.current=\[\]; \}/.test(src)
  ? ok('#3 LEAVE no longer nulls the recorder without stopping it') : bad('#3 LEAVE still abandons a running recorder');
has('if(!vt[0].enabled){')
  ? ok('#9 REC refuses a disabled camera track (was recording black video)') : bad('#9 REC still accepts a disabled track');

/* ---------- #4 send buttons require a room ---------- */
count(/disabled=\{!p\.netOn \|\| !p\.roomDraft\.trim\(\)\}/g) === 3
  ? ok('#4 all three SEND buttons require an open room') : bad('#4 send buttons still enabled pre-join, count=' + count(/disabled=\{!p\.netOn \|\| !p\.roomDraft\.trim\(\)\}/g));
// ...but dictating a draft before joining must still be possible
!/if\(!netOnRef\.current\)\{\s*sysNote[^}]*\}\s*\n\s*\/\/ Kill ANY previous/.test(src)
  ? ok('#4 pre-join dictation is still allowed (draft then join then send)') : bad('#4 pre-join dictation was blocked');

/* ---------- #7 clearing resets speech state ---------- */
has('const clearRoomDraft = ()=>{')
  ? ok('#7 clearing the draft is a single owned action') : bad('#7 clearRoomDraft missing');
/clearRoomDraft = \(\)=>\{[\s\S]{0,260}?srFinalRef\.current=''[\s\S]{0,120}?baseDraftRef\.current=''/.test(src)
  ? ok('#7 clearing drops the banked speech text (it used to re-appear)') : bad('#7 clearing still leaves banked speech');
has('onClick={p.clearRoomDraft}')
  ? ok('#7 the clear button uses it') : bad('#7 clear button still calls setRoomDraft directly');
/clearRoomDraft\(\); setPcNote\(''\);/.test(src)
  ? ok('#7 LEAVE reuses the same reset') : bad('#7 LEAVE resets the draft ad hoc');

/* ---------- #8 Enter joins ---------- */
has('const onRoomKeyDown')
  ? ok('#8 Enter handler exists for the room fields') : bad('#8 no Enter handler');
count(/onKeyDown=\{onRoomKeyDown\}/g) === 2
  ? ok('#8 both ROOM CODE and PIN honour Enter (enterKeyHint promised it)') : bad('#8 Enter wired to ' + count(/onKeyDown=\{onRoomKeyDown\}/g) + ' field(s), expected 2');

/* ---------- #10 role chips vs AUTO-SPEAK ---------- */
has('autoSpeakTouchedRef')
  ? ok('#10 an explicit AUTO-SPEAK choice is remembered') : bad('#10 explicit choice not tracked');
/pickRole = \(r\)=>\{[\s\S]{0,220}?if\(autoSpeakTouchedRef\.current\) return;/.test(src)
  ? ok('#10 role chips no longer overwrite an explicit AUTO-SPEAK choice') : bad('#10 role chips still clobber AUTO-SPEAK');
has('setAutoSpeakChoice')
  ? ok('#10 the toggle records the choice through one setter') : bad('#10 toggle still writes state inline');
!has('title="Speak incoming sign captions aloud"')
  ? ok('#10 AUTO-SPEAK tooltip matches its real behaviour') : bad('#10 tooltip still claims sign-captions only');

/* ---------- #11 duplicate SPEAK button ---------- */
!has('const secSpeak =')
  ? ok('#11 the duplicate desktop SPEAK button is gone') : bad('#11 duplicate desktop SPEAK button remains');
!has('p.stopRoomSR(false)')
  ? ok('#11 the dead stopRoomSR(false) argument is gone') : bad('#11 stopRoomSR is still called with a dead argument');
count(/stopRoomSR\(\)/g) >= 2
  ? ok('#11 every caller uses the real no-arg signature') : bad('#11 stopRoomSR callers inconsistent');

/* ---------- #12 action sheet consistency ---------- */
(() => {
  const i = src.indexOf('function RoomMoreSheet');
  const j = src.indexOf('function RoomChatCard');
  const sheet = src.slice(i, j);
  const grid = sheet.slice(sheet.indexOf('sheet-grid'));
  const buttons = (grid.match(/onClick=\{/g) || []).length;
  const closes = (grid.match(/p\.onClose\(\)/g) || []).length;
  buttons === closes && buttons === 6
    ? ok('#12 all 6 action-sheet buttons close the sheet (only FULL used to)')
    : bad('#12 sheet buttons=' + buttons + ' but only ' + closes + ' close it');
})();

/* ---------- #13 language row label ---------- */
!has('لغة التسجيل • SR LANG')
  ? ok('#13 the language row no longer claims to be speech-recognition only') : bad('#13 misleading SR LANG label remains');
has('LANGUAGE')
  ? ok('#13 row is labelled as the app language') : bad('#13 replacement label missing');

/* ---------- #14-#18 dead code and duplicated controls ---------- */
!/const \[netSelf,setNetSelf\]/.test(src)
  ? ok('#14 the write-only netSelf state is removed') : bad('#14 netSelf still declared');
!has('setNetSelf')
  ? ok('#14 no setNetSelf callers remain') : bad('#14 setNetSelf still called');
(() => {
  const i = src.indexOf('{/* Desktop/tablet only');
  const bar = src.slice(i, i + 900);
  !bar.includes('chatOpen={chatOpen}') && !bar.includes('hasUnread=') && !bar.includes('startRoomSR={startRoomSR}')
    ? ok('#15 dead mobile-only props removed from the desktop controls bar')
    : bad('#15 desktop controls bar still receives mobile-only props');
})();
count(/placeholder="https:\/\/your-app\.onrender\.com"/g) === 1
  ? ok('#16 the duplicated API-URL input is gone (one owner: Settings)') : bad('#16 API URL input still duplicated, count=' + count(/placeholder="https:\/\/your-app\.onrender\.com"/g));
!has("localStorage.setItem('slp_turn_url',e.target.value)")
  ? ok('#17 TURN inputs no longer double-write localStorage') : bad('#17 TURN inputs still write localStorage inline');
has("localStorage.setItem('slp_turn_url',turnUrl)")
  ? ok('#17 TURN persistence still handled by the effect') : bad('#17 TURN persistence lost');
has('disabled={!p.netCaps.length} onClick={()=>p.setNetCaps([])}')
  ? ok('#18 chat CLEAR is disabled when there is nothing to clear') : bad('#18 chat CLEAR still enabled when empty');

/* ---------- the bundle actually carries all of it ---------- */
['av-host-net','shouldSpeakIncoming','draftSignRef','onRoomKeyDown','autoSpeakTouchedRef','clearRoomDraft','playRoomSign','recSaveRef']
  .every(s => bundle.includes(s))
  ? ok('all new room symbols are present in the built bundle') : bad('the bundle is stale — re-run build.ps1');
!bundle.includes('secSpeak') ? ok('bundle has no duplicate SPEAK button') : bad('bundle still contains secSpeak');

console.log(fails === 0 ? 'ALL SIGN ROOM CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
