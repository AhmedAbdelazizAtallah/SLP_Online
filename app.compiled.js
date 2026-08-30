const { useState, useRef, useEffect, useCallback, useMemo } = React;
const WINDOW = 23;
const SPEED_PRESETS = {
  smooth: { stab: 8, gap: 8 },
  fast: { stab: 4, gap: 5 },
  turbo: { stab: 2, gap: 3 }
};
const MIN_FILL = 8;
const ROOM_SIGN_MIN_FILL = 4;
const ROOM_SIGN_STAB = 2;
const ROOM_SIGN_GAP = 2;
const ROOM_SIGN_RELEASE = 3;
const ROOM_SIGN_HEURISTIC_STRIDE = 2;
const ROOM_SIGN_MAX_MS = 45e3;
const MOTION_SETTLED = 0.055;
const SIGN_BOUNDARY_FRAMES = 3;
const LOW_FPS_LIMIT = 14;
const LOW_FPS_STRIKES = 3;
const RELEASE_CONF_RATIO = 0.7;
const UP_TIMELINE_MAX = 4e3;
function releaseFrames(sp) {
  return Math.max(3, (sp && sp.stab || 4) + 2);
}
function newStab() {
  return { cur: null, count: 0, last: null, away: 0, armed: false, rel: 0 };
}
function addRelease(st, need) {
  st.away++;
  if (st.away >= need) st.armed = true;
}
function holdsLatch(st, letter) {
  return st.last === null || letter === st.last;
}
function framesNeeded(stab, isRepeat) {
  return isRepeat ? stab + Math.max(2, Math.ceil(stab / 2)) : stab;
}
function latch(st, letter) {
  st.last = letter;
  st.cur = null;
  st.count = 0;
  st.away = 0;
  st.armed = false;
}
function armLatch(st, onlyLetter) {
  if (!st) return false;
  if (onlyLetter !== void 0 && onlyLetter !== null && st.last !== onlyLetter) return false;
  st.armed = true;
  st.away = 0;
  st.cur = null;
  st.count = 0;
  return true;
}
function featMotion(a, b) {
  if (!a || !b || a.length !== 63 || b.length !== 63) return 0;
  let sum = 0;
  for (let i = 0; i < 63; i += 3) {
    const dx = a[i] - b[i], dy = a[i + 1] - b[i + 1];
    sum += Math.hypot(dx, dy);
  }
  return sum / 21;
}
function mirrorSeq(seq) {
  return seq.map((f) => {
    const g = f.slice();
    for (let k = 0; k < g.length; k += 3) g[k] = 1 - g[k];
    return g;
  });
}
function statKey(lang, cls) {
  return (lang === "ar" ? "ar" : "en") + ":" + cls;
}
function parseStatKey(k) {
  const s = String(k);
  const i = s.indexOf(":");
  if (i < 0) return null;
  const lang = s.slice(0, i), cls = Number(s.slice(i + 1));
  if (lang !== "ar" && lang !== "en" || !Number.isFinite(cls)) return null;
  return { lang, cls };
}
function isNonLetter(letter) {
  const L = String(letter || "");
  return L === "SPACE" || L === "space" || L === " " || L === "DEL" || L === "del";
}
function mergeSpeechText(current, next) {
  const a = String(current || "").replace(/\s+/g, " ").trim();
  const b = String(next || "").replace(/\s+/g, " ").trim();
  if (!a) return b;
  if (!b || a === b || a.endsWith(" " + b)) return a;
  if (b.startsWith(a + " ") || b.startsWith(a)) return b;
  const aw = a.split(" "), bw = b.split(" ");
  for (let n = Math.min(aw.length, bw.length); n > 0; n--) {
    if (aw.slice(-n).join(" ") === bw.slice(0, n).join(" ")) return aw.concat(bw.slice(n)).join(" ");
  }
  return a + " " + b;
}
const CONFUSABLE_EN = {
  "A": ["T"],
  "T": ["A"],
  "M": ["N", "S"],
  "N": ["M", "S"],
  "S": ["M", "N"],
  "U": ["V", "R"],
  "V": ["U", "R"],
  "R": ["U", "V"],
  "G": ["H"],
  "H": ["G"],
  "K": ["P"],
  "P": ["K"],
  "D": ["K"]
};
const CONFUSABLE_AR = {
  "\u062F": ["\u0630"],
  "\u0630": ["\u062F"],
  "\u0637": ["\u0638"],
  "\u0638": ["\u0637"],
  "\u062A": ["\u062B"],
  "\u062B": ["\u062A"],
  // ص listed س but س did not list ص — a one-way edge, so pair-mass voting only
  // protected one direction of that confusion. Every edge here is mutual now.
  "\u0633": ["\u0634", "\u0635"],
  "\u0634": ["\u0633"],
  // ض is the closed ص fist plus an extended thumb, the same "dot finger"
  // relationship as خ/ح and غ/ع, and it was absent from this table.
  "\u0635": ["\u0633", "\u0636"],
  "\u0636": ["\u0635"],
  // ج / ح / خ are a mutual TRIPLE, not a pair: all three are the same four
  // fingers held together, differing only in curl and thumb extension. خ used
  // to be missing from this table entirely, so it got no pair-mass protection
  // at all and ح/ج never even considered it.
  "\u062D": ["\u062C", "\u062E"],
  "\u062C": ["\u062D", "\u062E"],
  "\u062E": ["\u062D", "\u062C"],
  // غ is ع plus an extended thumb (the dot) — same relationship as خ to ح.
  "\u0639": ["\u063A"],
  "\u063A": ["\u0639"],
  // ال and لا carry byte-identical pose descriptions (both "rock horns"), so
  // the model cannot separate them geometrically at all — let the recent-window
  // probability mass decide instead of a single noisy argmax.
  "\u0627\u0644": ["\u0644\u0627"],
  "\u0644\u0627": ["\u0627\u0644"],
  "\u0632": ["\u0631"],
  "\u0631": ["\u0632"]
};
const JHK_AR = { "\u062C": 1, "\u062D": 1, "\u062E": 1 };
function pairMass(recent, X, partners) {
  let sX = 0;
  const sP = {};
  partners.forEach((y) => {
    sP[y] = 0;
  });
  for (const rp of recent) {
    if (!rp || !Array.isArray(rp.top3)) continue;
    for (const t of rp.top3) {
      const c = typeof t.conf === "number" ? t.conf : 0;
      if (t.letter === X) sX += c;
      else if (sP[t.letter] !== void 0) sP[t.letter] += c;
    }
  }
  return { sX, sP };
}
function atArbitrate(feats) {
  if (!feats || feats.length < 63) return null;
  const px = (i) => feats[i * 3], py = (i) => feats[i * 3 + 1];
  const d = (a, b) => Math.hypot(px(a) - px(b), py(a) - py(b));
  const hand = d(0, 9);
  if (hand < 1e-6) return null;
  const dIdx = Math.min(d(4, 5), d(4, 6));
  const dMid = Math.min(d(4, 9), d(4, 10));
  const ratio = dIdx / (dIdx + dMid + 1e-6);
  const gap = d(6, 10) / hand;
  if (ratio >= 0.42 && ratio <= 0.62 && gap >= 0.2) return "T";
  if (ratio <= 0.38) return "A";
  return null;
}
function jhkArbitrate(feats) {
  if (!feats || feats.length < 63) return null;
  const px = (i) => feats[i * 3], py = (i) => feats[i * 3 + 1];
  const d = (a, b) => Math.hypot(px(a) - px(b), py(a) - py(b));
  const hand = d(0, 9);
  if (hand < 1e-6) return null;
  const spread = (d(8, 12) + d(12, 16) + d(16, 20)) / (3 * hand);
  if (spread > 0.42) return null;
  const thumbUp = (py(5) - py(4)) / hand;
  const thumbOut = d(4, 9) / hand;
  const tips = (py(8) + py(12) + py(16) + py(20)) / 4;
  const knuckles = (py(5) + py(9) + py(13) + py(17)) / 4;
  const tipsBelow = (tips - knuckles) / hand;
  if (thumbUp > 0.42 && thumbOut > 0.5 && tipsBelow < 0.3) return "\u062E";
  if (tipsBelow > 0.38 && thumbUp < 0.18) return "\u062C";
  if (tipsBelow < 0.22 && thumbUp < 0.22) return "\u062D";
  return null;
}
const AR_CLASSES = ["\u0639", "\u0627\u0644", "\u0627", "\u0628", "\u0636", "\u062F", "\u0641", "\u063A", "\u062D", "\u0647", "\u062C", "\u0643", "\u062E", "\u0644\u0627", "\u0644", "\u0645", "\u0646", "\u0642", "\u0631", "\u0635", "\u0633", "\u0634", "\u0637", "\u062A", "\u0629", "\u0630", "\u062B", "\u0648", "\u064A", "\u0638", "\u0632", "DEL", "SPACE"];
const AR_NAMES = ["Ain", "Al", "Alef", "Beh", "Dad", "Dal", "Feh", "Ghain", "Hah", "Heh", "Jeem", "Kaf", "Khah", "Laa", "Lam", "Meem", "Noon", "Qaf", "Reh", "Sad", "Seen", "Sheen", "Tah", "Teh", "Teh_Marbuta", "Thal", "Theh", "Waw", "Yeh", "Zah", "Zain", "Del", "Space"];
const AR_HINTS = [
  "\u0639\u064A\u0646: \u0627\u0644\u064A\u062F \u0623\u0641\u0642\u064A\u0629 \u0648\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u0648\u0633\u0637\u0649 \u0645\u0645\u062F\u0648\u062F\u062A\u0627\u0646 \u0644\u0644\u0623\u0645\u0627\u0645 \u0645\u062A\u062C\u0627\u0648\u0631\u062A\u0627\u0646 \u0643\u0641\u0645 \u0645\u0641\u062A\u0648\u062D \u0648\u0627\u0644\u0628\u0627\u0642\u064A \u0645\u0637\u0648\u064A",
  "(\u0627\u0644): \u0642\u0631\u0648\u0646 \u0627\u0644\u0631\u0648\u0643 \u2014 \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u062E\u0646\u0635\u0631 \u0644\u0644\u0623\u0639\u0644\u0649 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u064A\u0637\u0648\u064A \u0627\u0644\u0648\u0633\u0637\u0649 \u0648\u0627\u0644\u0628\u0646\u0635\u0631",
  "\u0623\u0644\u0641: \u0642\u0628\u0636\u0629 \u0645\u063A\u0644\u0642\u0629 \u0645\u0639 \u0631\u0641\u0639 \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0644\u0644\u0623\u0639\u0644\u0649 \u0628\u0634\u0643\u0644 \u0645\u0633\u062A\u0642\u064A\u0645 (Thumbs up)",
  "\u0628\u0627\u0621: \u0642\u0628\u0636\u0629 \u0645\u063A\u0644\u0642\u0629 \u0645\u0639 \u0631\u0641\u0639 \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0641\u0642\u0637 \u0645\u0645\u062F\u0648\u062F\u0629 \u0644\u0644\u0623\u0639\u0644\u0649 (\u0625\u0635\u0628\u0639 \u0648\u0627\u062D\u062F)",
  "\u0636\u0627\u062F: \u0642\u0628\u0636\u0629 \u0627\u0644\u0635\u0627\u062F \u0627\u0644\u0645\u063A\u0644\u0642\u0629 \u0645\u0639 \u0645\u062F\u0651 \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0623\u0641\u0642\u064A\u0627\u064B \u0625\u0644\u0649 \u0627\u0644\u062C\u0627\u0646\u0628",
  "\u062F\u0627\u0644: \u0641\u062A\u062D \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0641\u0642\u0637 \u0623\u0641\u0642\u064A\u0627\u064B \u0644\u062A\u0634\u0643\u064A\u0644 \u0632\u0627\u0648\u064A\u0629/\u0645\u0646\u0642\u0627\u0631 \u0645\u0641\u062A\u0648\u062D \u0635\u063A\u064A\u0631 \u0648\u0627\u0644\u0628\u0627\u0642\u064A \u0645\u0642\u0628\u0648\u0636",
  "\u0641\u0627\u0621: \u0642\u0628\u0636\u0629 \u0623\u0645\u0627\u0645\u064A\u0629 \u0648\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0645\u062B\u0646\u064A\u0629 \u0642\u0644\u064A\u0644\u0627\u064B \u0644\u0644\u0623\u0639\u0644\u0649 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u064A\u0633\u0646\u062F\u0647\u0627 \u0645\u0646 \u0627\u0644\u062C\u0627\u0646\u0628",
  "\u063A\u064A\u0646: \u0648\u0636\u0639\u064A\u0629 \u0627\u0644\u0639\u064A\u0646 \u0645\u0639 \u0645\u062F\u0651 \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0645\u0627\u0626\u0644\u0627\u064B \u0644\u0644\u0623\u0639\u0644\u0649 (\u0627\u0644\u0646\u0642\u0637\u0629)",
  "\u062D\u0627\u0621: \u0643\u0641 \u062C\u0627\u0646\u0628\u064A \u0648\u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0627\u0644\u0623\u0631\u0628\u0639\u0629 \u0645\u0639\u0627\u064B \u0623\u0641\u0642\u064A\u0627\u064B \u0645\u062B\u0646\u064A\u0629 \u0628\u0632\u0627\u0648\u064A\u0629 \u0642\u0627\u0626\u0645\u0629 \u0644\u0644\u0623\u0645\u0627\u0645",
  "\u0647\u0627\u0621: \u0636\u0645 \u0623\u0637\u0631\u0627\u0641 \u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0627\u0644\u062E\u0645\u0633\u0629 \u0644\u062A\u0644\u062A\u0642\u064A \u0641\u064A \u0646\u0642\u0637\u0629 \u0648\u0627\u062D\u062F\u0629 (\u0642\u0628\u0636\u0629 \u0627\u0644\u0648\u0631\u062F\u0629)",
  "\u062C\u064A\u0645: \u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0627\u0644\u0623\u0631\u0628\u0639\u0629 \u0645\u062A\u0644\u0627\u0635\u0642\u0629 \u0645\u0646\u062D\u0646\u064A\u0629 \u0644\u0644\u0623\u0633\u0641\u0644 \u0643\u0645\u0646\u0642\u0627\u0631 \u0645\u0641\u062A\u0648\u062D\u060C \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0641\u064A \u0627\u0644\u0623\u0633\u0641\u0644 \u064A\u0643\u0645\u0644 \u0641\u062A\u062D\u0629 \u0627\u0644\u0643\u0645\u0627\u0634\u0629",
  "\u0643\u0627\u0641: \u0643\u0641 \u0645\u0641\u062A\u0648\u062D \u0631\u0623\u0633\u064A \u0648\u0623\u0635\u0627\u0628\u0639 \u0645\u0636\u0645\u0648\u0645\u0629 \u062A\u0645\u0627\u0645\u0627\u064B \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0645\u0637\u0648\u064A \u0641\u0648\u0642 \u0631\u0627\u062D\u0629 \u0627\u0644\u064A\u062F",
  "\u062E\u0627\u0621: \u0646\u0641\u0633 \u0642\u0627\u0639\u062F\u0629 \u0627\u0644\u062D\u0627\u0621 \u062A\u0645\u0627\u0645\u0627\u064B (\u0645\u062A\u0644\u0627\u0635\u0642\u0629\u060C 90 \u062F\u0631\u062C\u0629\u060C \u0639\u064F\u0642\u0644 \u0645\u0641\u0631\u0648\u062F\u0629) \u0645\u0639 \u0645\u062F\u0651 \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0631\u0623\u0633\u064A\u0627\u064B \u0644\u0644\u0623\u0639\u0644\u0649 (\u0627\u0644\u0646\u0642\u0637\u0629)",
  "\u0644\u0627\u0645 \u0623\u0644\u0641 (\u0644\u0627): \u0642\u0631\u0648\u0646 \u0627\u0644\u0631\u0648\u0643 \u2014 \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u062E\u0646\u0635\u0631 \u0644\u0644\u0623\u0639\u0644\u0649 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u064A\u0637\u0648\u064A \u0627\u0644\u0648\u0633\u0637\u0649 \u0648\u0627\u0644\u0628\u0646\u0635\u0631",
  "\u0644\u0627\u0645: \u062D\u0631\u0641 L \u0635\u0631\u064A\u062D: \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0623\u0641\u0642\u064A\u0627\u064B \u0648\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0631\u0623\u0633\u064A\u0627\u064B \u0648\u0627\u0644\u0628\u0627\u0642\u064A \u0645\u0637\u0648\u064A",
  "\u0645\u064A\u0645: \u0642\u0628\u0636\u0629 \u0645\u063A\u0644\u0642\u0629 \u0645\u0639 \u0631\u0641\u0639 \u0627\u0644\u062E\u0646\u0635\u0631 \u0641\u0642\u0637 \u0644\u0644\u0623\u0639\u0644\u0649 \u0628\u0645\u0641\u0631\u062F\u0647",
  "\u0646\u0648\u0646: \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0645\u0646\u062D\u0646\u064A\u0629 \u0642\u0644\u064A\u0644\u0627\u064B \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u064A\u0642\u0627\u0628\u0644\u0647\u0627 \u0645\u0646\u062D\u0646\u064A\u0627\u064B (\u0648\u0639\u0627\u0621 \u0627\u0644\u0646\u0648\u0646/\u0647\u0644\u0627\u0644)",
  "\u0642\u0627\u0641: \u062D\u0644\u0642\u0629 \u0645\u0642\u0641\u0644\u0629 \u0628\u064A\u0646 \u0637\u0631\u0641\u064A \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0648\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u0648\u0633\u0637\u0649 \u062A\u0636\u0645 \u0641\u0648\u0642\u0647\u0627",
  "\u0631\u0627\u0621: \u0642\u0628\u0636\u0629 \u0648\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0628\u062E\u0637\u0627\u0641/\u0642\u0648\u0633 \u0645\u0639 \u062D\u0631\u0643\u0629 \u0633\u062D\u0628 \u0623\u0648 \u062A\u062D\u0631\u064A\u0643 \u0627\u0644\u064A\u062F",
  "\u0635\u0627\u062F: \u0642\u0628\u0636\u0629 \u0645\u0642\u0641\u0648\u0644\u0629 \u0628\u0627\u0644\u0643\u0627\u0645\u0644 \u062A\u0648\u0627\u062C\u0647 \u0627\u0644\u0623\u0645\u0627\u0645: \u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0641\u0648\u0642 \u0627\u0644\u0631\u0627\u062D\u0629 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0641\u0648\u0642\u0647\u0627",
  "\u0633\u064A\u0646: \u0643\u0641 \u0631\u0623\u0633\u064A \u0645\u0633\u0637\u062D \u0648\u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0627\u0644\u0623\u0631\u0628\u0639\u0629 \u0645\u0636\u0645\u0648\u0645\u0629 \u062A\u0645\u0627\u0645\u0627\u064B \u0644\u0628\u0639\u0636\u0647\u0627 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0645\u0645\u062F\u0648\u062F \u062C\u0627\u0646\u0628\u064A\u0627\u064B",
  "\u0634\u064A\u0646: \u0643\u0641 \u0645\u0641\u062A\u0648\u062D \u0645\u0633\u0637\u062D \u0644\u0644\u0623\u0645\u0627\u0645 \u0645\u0639 \u062A\u0641\u0631\u064A\u0642 \u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0627\u0644\u062E\u0645\u0633\u0629 \u0628\u0627\u0644\u0643\u0627\u0645\u0644",
  "\u0637\u0627\u0621: \u0625\u063A\u0644\u0627\u0642 \u0627\u0644\u0628\u0646\u0635\u0631 \u0648\u0627\u0644\u062E\u0646\u0635\u0631 \u0648\u062D\u0644\u0642\u0629 \u0628\u064A\u0646 \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0648\u0627\u0644\u0648\u0633\u0637\u0649 \u0648\u0645\u062F\u0651 \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0642\u0627\u0626\u0645\u0629 (\u0639\u0635\u0627 \u0627\u0644\u0637\u0627\u0621)",
  "\u062A\u0627\u0621: \u0642\u0628\u0636\u0629 \u0645\u0639 \u0631\u0641\u0639 \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u0648\u0633\u0637\u0649 \u0645\u0636\u0645\u0648\u0645\u064A\u0646 \u0644\u0644\u0623\u0639\u0644\u0649 (\u0646\u0642\u0637\u062A\u0627\u0646)",
  "\u062A\u0627\u0621 \u0645\u0631\u0628\u0648\u0637\u0629: \u062D\u0644\u0642\u0629 \u0628\u064A\u0646 \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0648\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0645\u0639 \u0645\u062F\u0651 \u0627\u0644\u0648\u0633\u0637\u0649 \u0648\u0627\u0644\u0628\u0646\u0635\u0631 \u0648\u0627\u0644\u062E\u0646\u0635\u0631 \u0644\u0644\u0623\u0639\u0644\u0649",
  "\u0630\u0627\u0644: \u0645\u062B\u0644 \u0627\u0644\u062F\u0627\u0644 \u062A\u0645\u0627\u0645\u0627\u064B \u0645\u0639 \u0645\u062F\u0651 \u0627\u0644\u0648\u0633\u0637\u0649 \u0645\u0627\u0626\u0644\u0627\u064B \u0644\u0644\u0623\u0639\u0644\u0649 (\u0627\u0644\u0646\u0642\u0637\u0629)",
  "\u062B\u0627\u0621: \u0642\u0628\u0636\u0629 \u0645\u0639 \u0631\u0641\u0639 \u062B\u0644\u0627\u062B\u0629 \u0623\u0635\u0627\u0628\u0639 \u0645\u0636\u0645\u0648\u0645\u0629 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u064A\u0637\u0648\u064A \u0627\u0644\u062E\u0646\u0635\u0631",
  "\u0648\u0627\u0648: \u0643\u0641 \u0645\u0627\u0626\u0644 \u0644\u0644\u0623\u0633\u0641\u0644 \u0645\u0642\u0648\u0633 \u0648\u0623\u0635\u0627\u0628\u0639 \u0634\u0628\u0647 \u0645\u0637\u0648\u064A\u0629 \u062A\u0634\u0643\u0644 \u0642\u0648\u0633 \u0627\u0644\u0648\u0627\u0648 \u0627\u0644\u0645\u0642\u0644\u0648\u0628",
  "\u064A\u0627\u0621: \u0627\u0644\u0634\u0627\u0643\u0627: \u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0648\u0627\u0644\u062E\u0646\u0635\u0631 \u0645\u0645\u062F\u0648\u062F\u0627\u0646 \u0644\u0644\u062C\u0627\u0646\u0628 \u0648\u0627\u0644\u062B\u0644\u0627\u062B\u0629 \u0627\u0644\u0648\u0633\u0637\u0649 \u0641\u064A \u0627\u0644\u0642\u0628\u0636\u0629",
  "\u0638\u0627\u0621: \u0645\u062B\u0644 \u0627\u0644\u0637\u0627\u0621 (\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0639\u0635\u0627) \u0645\u0639 \u0645\u062F\u0651 \u0627\u0644\u0648\u0633\u0637\u0649 \u0623\u0648 \u0627\u0644\u062E\u0646\u0635\u0631 \u0644\u0644\u062E\u0627\u0631\u062C (\u0627\u0644\u0646\u0642\u0637\u0629)",
  "\u0632\u0627\u064A: \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u0648\u0633\u0637\u0649 \u0645\u0639\u0627\u064B \u0645\u062B\u0646\u064A\u062A\u0627\u0646 \u0644\u0644\u0623\u0645\u0627\u0645 \u0641\u064A \u062E\u0637\u0627\u0641 \u0645\u0632\u062F\u0648\u062C",
  "\u0645\u0633\u062D \u0644\u0644\u062E\u0644\u0641 \u0628\u0627\u0644\u064A\u062F (\u062D\u0630\u0641)",
  "\u062A\u0648\u0642\u0641 \u0642\u0635\u064A\u0631 \u0628\u0643\u0641 \u0645\u0641\u062A\u0648\u062D (\u0641\u0631\u0627\u063A)"
];
const AR_ALPHA_ORDER = [2, 3, 23, 26, 10, 8, 12, 5, 25, 18, 30, 20, 21, 19, 4, 22, 29, 0, 7, 6, 17, 11, 14, 15, 16, 9, 27, 28, 24, 1, 13];
const EN_CLASSES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "DEL", "SPACE"];
const EN_ALPHA_ORDER = EN_CLASSES.slice(0, 26).map((g, i) => i);
const EN_HINTS = [
  "\u0642\u0628\u0636\u0629 \u0627\u0644\u064A\u062F \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0639\u0644\u0649 \u0627\u0644\u062C\u0627\u0646\u0628",
  "\u0643\u0641 \u0645\u0641\u062A\u0648\u062D \u0644\u0644\u0623\u0645\u0627\u0645 \u0648\u0623\u0635\u0627\u0628\u0639 \u0645\u0636\u0645\u0648\u0645\u0629",
  "\u0623\u0635\u0627\u0628\u0639 \u0645\u0646\u062D\u0646\u064A\u0629 \u0639\u0644\u0649 \u0634\u0643\u0644 C",
  "\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0644\u0644\u0623\u0639\u0644\u0649 \u0648\u0627\u0644\u0628\u0627\u0642\u064A \u0645\u062B\u0646\u064A",
  "\u0623\u0635\u0627\u0628\u0639 \u0645\u0646\u062D\u0646\u064A\u0629 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0639\u0644\u0649 \u0627\u0644\u0623\u0637\u0631\u0627\u0641",
  "\u062F\u0627\u0626\u0631\u0629 \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u0625\u0628\u0647\u0627\u0645 \u0648\u0628\u0642\u064A\u0629 \u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0644\u0644\u0623\u0639\u0644\u0649",
  "\u0633\u0628\u0627\u0628\u0629 \u0644\u0644\u0623\u0645\u0627\u0645 \u0645\u0639 \u0625\u0628\u0647\u0627\u0645 \u0645\u0648\u0627\u0632\u064A",
  "\u0633\u0628\u0627\u0628\u0629 \u0648\u0648\u0633\u0637\u0649 \u0623\u0641\u0642\u064A\u0629 \u0645\u062A\u0648\u0627\u0632\u064A\u0629",
  "\u0627\u0644\u062E\u0646\u0635\u0631 \u0644\u0644\u0623\u0639\u0644\u0649",
  "\u0627\u0644\u062E\u0646\u0635\u0631 \u0644\u0644\u0623\u0639\u0644\u0649 \u0648\u0627\u0631\u0633\u0645 \u062D\u0631\u0641 J",
  "\u0633\u0628\u0627\u0628\u0629 \u0648\u0648\u0633\u0637\u0649 \u0645\u062A\u0628\u0627\u0639\u062F\u062A\u0627\u0646 \u0644\u0644\u0623\u0639\u0644\u0649",
  "\u0634\u0643\u0644 \u062D\u0631\u0641 L",
  "\u0642\u0628\u0636\u0629 \u0648\u0625\u0628\u0647\u0627\u0645 \u0641\u0648\u0642 \u062B\u0644\u0627\u062B \u0623\u0635\u0627\u0628\u0639",
  "\u0642\u0628\u0636\u0629 \u0648\u0625\u0628\u0647\u0627\u0645 \u0628\u064A\u0646 \u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u0648\u0627\u0644\u0648\u0633\u0637\u0649",
  "\u0627\u0644\u0623\u0635\u0627\u0628\u0639 \u0643\u0644\u0647\u0627 \u0639\u0644\u0649 \u0634\u0643\u0644 \u062F\u0627\u0626\u0631\u0629 O",
  "\u0633\u0628\u0627\u0628\u0629 \u0644\u0644\u0623\u0645\u0627\u0645 \u0648\u0648\u0633\u0637\u0649 \u0644\u0644\u0623\u0633\u0641\u0644",
  "\u0633\u0628\u0627\u0628\u0629 \u0648\u0625\u0628\u0647\u0627\u0645 \u0644\u0644\u0623\u0633\u0641\u0644",
  "\u0633\u0628\u0627\u0628\u0629 \u0648\u0648\u0633\u0637\u0649 \u0645\u062A\u0642\u0627\u0637\u0639\u062A\u0627\u0646",
  "\u0642\u0628\u0636\u0629 \u0645\u0639 \u0625\u0628\u0647\u0627\u0645 \u0641\u0648\u0642 \u0627\u0644\u0623\u0635\u0627\u0628\u0639",
  "\u0642\u0628\u0636\u0629 \u0645\u0639 \u0625\u0628\u0647\u0627\u0645 \u0628\u064A\u0646 \u0627\u0644\u0623\u0635\u0627\u0628\u0639",
  "\u0633\u0628\u0627\u0628\u0629 \u0648\u0648\u0633\u0637\u0649 \u0644\u0644\u0623\u0639\u0644\u0649 \u0645\u0639\u0627",
  "\u0633\u0628\u0627\u0628\u0629 \u0648\u0648\u0633\u0637\u0649 \u0645\u062A\u0628\u0627\u0639\u062F\u062A\u0627\u0646 (V)",
  "\u0633\u0628\u0627\u0628\u0629 \u0648\u0648\u0633\u0637\u0649 \u0648\u0628\u0646\u0635\u0631 \u0644\u0644\u0623\u0639\u0644\u0649",
  "\u0633\u0628\u0627\u0628\u0629 \u0645\u0639\u0642\u0648\u0641\u0629 \u0639\u0644\u0649 \u0634\u0643\u0644 \u062E\u0637\u0627\u0641",
  "\u0625\u0628\u0647\u0627\u0645 \u0648\u062E\u0646\u0635\u0631 \u0645\u0645\u062A\u062F\u0627\u0646",
  "\u0627\u0644\u0633\u0628\u0627\u0628\u0629 \u062A\u0631\u0633\u0645 \u062D\u0631\u0641 Z \u0641\u064A \u0627\u0644\u0647\u0648\u0627\u0621",
  "\u062D\u0631\u0643\u0629 \u0645\u0633\u062D \u0644\u0644\u062E\u0644\u0641 (\u062D\u0630\u0641)",
  "\u062A\u0648\u0642\u0641 \u0644\u0625\u0636\u0627\u0641\u0629 \u0641\u0631\u0627\u063A"
];
const AR_UNI = { "\u0639": 0, "\u0627\u0644": 1, "\u0627": 2, "\u0623": 2, "\u0625": 2, "\u0622": 2, "\u0671": 2, "\u0628": 3, "\u0636": 4, "\u062F": 5, "\u0641": 6, "\u063A": 7, "\u062D": 8, "\u0647": 9, "\u062C": 10, "\u0643": 11, "\u062E": 12, "\u0644\u0627": 13, "\u0644": 14, "\u0645": 15, "\u0646": 16, "\u0642": 17, "\u0631": 18, "\u0635": 19, "\u0633": 20, "\u0634": 21, "\u0637": 22, "\u062A": 23, "\u0629": 24, "\u0630": 25, "\u062B": 26, "\u0648": 27, "\u064A": 28, "\u0649": 28, "\u0638": 29, "\u0632": 30, "\u0621": 2 };
function nameForCls(cls, lang) {
  if (lang === "ar") return AR_NAMES[cls] || AR_CLASSES[cls] || "";
  return cls >= 0 && cls < 26 ? String.fromCharCode(65 + cls) : EN_CLASSES[cls] || "";
}
const AR_WORDS = [
  { w: "\u0645\u0631\u062D\u0628\u0627", m: "hello", t: "marhaba" },
  { w: "\u0634\u0643\u0631\u0627", m: "thanks", t: "shukran" },
  { w: "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064A\u0643\u0645", m: "peace be upon you", t: "" },
  { w: "\u0643\u064A\u0641 \u062D\u0627\u0644\u0643", m: "how are you", t: "" },
  { w: "\u0627\u0633\u0645\u064A", m: "my name is", t: "ismi" },
  { w: "\u0645\u0646 \u0641\u0636\u0644\u0643", m: "please", t: "min fadlik" },
  { w: "\u0639\u0641\u0648\u0627", m: "excuse me", t: "afwan" },
  { w: "\u0646\u0639\u0645", m: "yes", t: "naam" },
  { w: "\u0644\u0627", m: "no", t: "la" },
  { w: "\u0623\u062D\u0628\u0643", m: "I love you", t: "uhibbuka" },
  { w: "\u0635\u0628\u0627\u062D \u0627\u0644\u062E\u064A\u0631", m: "good morning", t: "" },
  { w: "\u0645\u0633\u0627\u0621 \u0627\u0644\u062E\u064A\u0631", m: "good evening", t: "" },
  { w: "\u0645\u0639 \u0627\u0644\u0633\u0644\u0627\u0645\u0629", m: "goodbye", t: "" },
  { w: "\u0645\u0627\u0621", m: "water", t: "maa" },
  { w: "\u0637\u0639\u0627\u0645", m: "food", t: "taam" }
];
const EN_WORDS = [
  { w: "hello", m: "\u0645\u0631\u062D\u0628\u0627" },
  { w: "thank you", m: "\u0634\u0643\u0631\u0627" },
  { w: "please", m: "\u0645\u0646 \u0641\u0636\u0644\u0643" },
  { w: "help", m: "\u0645\u0633\u0627\u0639\u062F\u0629" },
  { w: "good morning", m: "\u0635\u0628\u0627\u062D \u0627\u0644\u062E\u064A\u0631" },
  { w: "i love you", m: "\u0623\u062D\u0628\u0643" },
  { w: "water", m: "\u0645\u0627\u0621" },
  { w: "food", m: "\u0637\u0639\u0627\u0645" },
  { w: "yes", m: "\u0646\u0639\u0645" },
  { w: "no", m: "\u0644\u0627" },
  { w: "sorry", m: "\u0622\u0633\u0641" },
  { w: "family", m: "\u0639\u0627\u0626\u0644\u0629" },
  { w: "friend", m: "\u0635\u062F\u064A\u0642" },
  { w: "teacher", m: "\u0645\u0639\u0644\u0645" }
];
function stripAr(s) {
  return String(s || "").normalize("NFC").replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[إأآٱ]/g, "\u0627").replace(/ؤ/g, "\u0648").replace(/ئ/g, "\u064A").replace(/ى/g, "\u064A").replace(/ک/g, "\u0643").replace(/ی/g, "\u064A");
}
function normAR(w) {
  return stripAr(w).replace(/\s/g, "");
}
function isPauseChar(ch) {
  return /[.,!?;:،؛؟…\-–—()[\]{}"'«»]/.test(ch);
}
function arToken(cls) {
  return { type: "CLA", cls, glyph: AR_CLASSES[cls], name: AR_NAMES[cls], hint: AR_HINTS[cls] };
}
function enToken(cls) {
  return { type: "CLA", cls, glyph: EN_CLASSES[cls], name: EN_CLASSES[cls], hint: EN_HINTS[cls] };
}
function tokenizeAR(text) {
  const t = stripAr(text || "");
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (/\s/.test(ch)) {
      if (!out.length || out[out.length - 1].type !== "SP") out.push({ type: "SP", glyph: " " });
      continue;
    }
    if (isPauseChar(ch)) {
      out.push({ type: "SP", glyph: ch });
      continue;
    }
    if (ch === "\u0644" && t[i + 1] === "\u0627") {
      out.push(arToken(13));
      i++;
      continue;
    }
    if (ch === "\u0627" && t[i + 1] === "\u0644") {
      out.push(arToken(1));
      i++;
      continue;
    }
    const cls = AR_UNI[ch];
    if (cls !== void 0) out.push(arToken(cls));
    else out.push({ type: "TXT", glyph: ch, hint: "\u0644\u0627 \u0625\u0634\u0627\u0631\u0629 \u0645\u062A\u0627\u062D\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0631\u0645\u0632" });
  }
  return out;
}
function tokenizeEN(text) {
  const out = [];
  const normalized = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  for (const ch of normalized) {
    if (/\s/.test(ch)) {
      if (!out.length || out[out.length - 1].type !== "SP") out.push({ type: "SP", glyph: " " });
      continue;
    }
    if (isPauseChar(ch)) {
      out.push({ type: "SP", glyph: ch });
      continue;
    }
    if (ch >= "A" && ch <= "Z") {
      const cls = ch.charCodeAt(0) - 65;
      out.push(enToken(cls));
    } else out.push({ type: "TXT", glyph: ch, hint: "No sign available" });
  }
  return out;
}
function tokenizeText(text, lang) {
  return lang === "ar" ? tokenizeAR(text) : tokenizeEN(text);
}
function nextSignIndex(tokens, start) {
  let i = Math.max(0, start || 0);
  while (i < tokens.length && tokens[i].type !== "CLA") i++;
  return i;
}
function suggestWords(text, lang) {
  const parts = (text || "").trim().split(/\s+/);
  const last = parts.length ? parts[parts.length - 1] : "";
  if (!last) return [];
  const dict = lang === "ar" ? AR_WORDS : EN_WORDS;
  const key = lang === "ar" ? normAR(last) : last.toLowerCase().replace(/\s/g, "");
  const out = [];
  for (const wd of dict) {
    const nw = lang === "ar" ? normAR(wd.w) : wd.w.toLowerCase().replace(/\s/g, "");
    if (nw.startsWith(key) && nw !== key) {
      out.push(wd);
      if (out.length >= 5) break;
    }
  }
  return out;
}
function replaceLastWord(text, word) {
  const parts = (text || "").trim().split(/\s+/);
  parts[parts.length - 1] = word;
  return parts.join(" ");
}
function appendWords(text, words) {
  const base = String(text || "").trimEnd();
  const extra = String(words || "").trim();
  if (!extra) return base;
  return base ? base + " " + extra : extra;
}
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[src="' + src + '"]')) return res();
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => res();
    s.onerror = () => rej(new Error("Failed " + src));
    document.head.appendChild(s);
  });
}
async function loadMediaPipe() {
  if (window.Hands) return;
  await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
  await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/control_utils/control_utils.js");
  await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js");
  await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
}
const P = (c, s, w, m, tb, ex) => ({ c, s: s || 0, w: w || [0, 0, 0], m: m || null, tb: tb === void 0 ? null : tb, jc: ex && ex.jc || null });
const POSES_EN = [
  P([0.18, 1, 1, 1, 1], 0, null, null, 0.12),
  P([0.55, 0, 0, 0, 0], -0.5, null, null, 0.9),
  P([0.4, 0.5, 0.5, 0.5, 0.5], 0, null, null, 0.45),
  P([0.7, 0, 0.95, 0.95, 0.95], 0, null, null, 0.65),
  P([0.6, 0.92, 0.92, 0.92, 0.92], 0, null, null, 0.88),
  P([0.78, 0.78, 0, 0, 0], 0, null, null, 0.6),
  P([0.15, 0.1, 1, 1, 1], 0, [0, 0, -1.3], null, 0.15),
  P([0.88, 0.08, 0.08, 1, 1], -0.35, [0, 0, -1.3], null, 0.85),
  P([0.85, 1, 1, 1, 0], 0, null, null, 0.82),
  P([0.85, 1, 1, 1, 0], 0, null, "j", 0.82),
  P([0.55, 0, 0.22, 1, 1], 0.28, null, null, 0.55),
  P([0.05, 0, 1, 1, 1], 0, null, null, 0),
  P([0.9, 0.86, 0.86, 0.86, 1], 0, null, null, 0.92),
  P([0.9, 0.86, 0.86, 1, 1], 0, null, null, 0.92),
  P([0.6, 0.62, 0.58, 0.55, 0.52], 0, null, null, 0.55),
  P([0.55, 0, 0.22, 1, 1], 0, [1.35, 0, -0.55], null, 0.55),
  P([0.15, 0.1, 1, 1, 1], 0, [1.35, 0, -0.55], null, 0.15),
  P([0.88, 0, 0, 1, 1], -0.75, null, null, 0.85),
  P([0.8, 1, 1, 1, 1], 0, null, null, 0.95),
  P([0.72, 0.88, 0.82, 1, 1], 0, null, null, 0.72),
  P([0.88, 0, 0, 1, 1], -0.3, null, null, 0.85),
  P([0.88, 0, 0, 1, 1], 0.55, null, null, 0.85),
  P([0.85, 0, 0, 0, 1], 0.4, null, null, 0.8),
  P([0.82, 0.55, 1, 1, 1], 0, null, null, 0.82),
  P([0, 1, 1, 1, 0], 0, null, null, 0),
  P([1, 0, 1, 1, 1], 0, null, "z", 0.7),
  P([0.55, 0.55, 0.55, 0.55, 0.55], 0, null, "del", 0.6),
  P([0, 0, 0, 0, 0], 0.25, null, null, 0.15)
];
const POSES_AR = [
  P([0.9, 0.05, 0.08, 1, 1], 0.04, [0, 0, 1.25], null, 0.85),
  // 0: ع - يد أفقية، السبابة والوسطى للأمام متجاوران كفم مفتوح، الباقي مطوي
  P([0.8, 0.04, 1, 1, 0.05], 0.15, null, null, 0.6),
  // 1: ال - قرون: السبابة والخنصر للأعلى والإبهام يطوي الوسطى والبنصر
  P([0.02, 1, 1, 1, 1], 0, [0, 0, -1.57], null, 0.1),
  // 2: ا - قبضة مغلقة مع رفع الإبهام مستقيماً (Thumbs up)
  P([0.95, 0.03, 1, 1, 1], 0, null, null, 0.9),
  // 3: ب - قبضة مع رفع السبابة وحدها للأعلى (إصبع واحد)
  P([0.12, 1, 1, 1, 1], 0, null, null, 0.38),
  // 4: ض - قبضة الصاد مع مدّ الإبهام أفقياً إلى الجانب (النقطة)
  P([0.22, 0.2, 1, 1, 1], 0, [0, 0, -0.7], null, 0.5),
  // 5: د - السبابة والإبهام أفقياً بزاوية منقار صغيرة، الباقي مقبوض
  P([0.3, 0.22, 1, 1, 1], 0, null, null, 0.72),
  // 6: ف - قبضة أمامية والسبابة مثنية قليلاً للأعلى والإبهام يسندها من الجانب
  P([0.1, 0.05, 0.08, 1, 1], 0.04, [0, 0, 1.25], null, 0.7),
  // 7: غ - وضعية العين مع ميل الإبهام للأعلى (النقطة)
  P([0.97, 0.1, 0.11, 0.12, 0.13], -0.65, [1.57, 0, 1.57], null, 0.97),
  // 8: ح - كف جانبي وأصابع معاً أفقياً مثنية بزاوية قائمة للأمام
  P([0.65, 0.65, 0.65, 0.65, 0.65], 0.02, null, null, 0.88),
  // 9: هـ - أطراف الأصابع الخمسة تلتقي معاً للأعلى (قبضة الوردة)
  P([0.25, 0.32, 0.34, 0.36, 0.38], -0.65, [1.57, 0, 1.57], null, 0.25),
  // 10: ج - أربعة أصابع ممدودة أفقياً منحنية قليلاً والإبهام مطوي بمحاذاة الكف
  P([0.92, 0.06, 0.06, 0.07, 0.07], 0.04, null, null, 0.95),
  // 11: ك - كف رأسي مفتوح وأصابع مضمومة والإبهام مطوي فوق باطن الكف
  P([0.02, 0.1, 0.11, 0.12, 0.13], -0.65, [2.27, 0, 1.57], null, 0.1),
  // 12: خ - مثل الحاء مع مدّ الإبهام مائلاً للأعلى/الخلف (النقطة)
  P([0.8, 0.04, 1, 1, 0.05], 0.15, null, null, 0.6),
  // 13: لا - قرون الروك: السبابة والخنصر للأعلى والإبهام يطوي الوسطى والبنصر
  P([0.03, 0.03, 1, 1, 1], 0.05, null, null, 0.18),
  // 14: ل - L صريح: الإبهام أفقياً والسبابة رأسياً والثلاثة مطويون
  P([0.95, 1, 1, 1, 0.04], 0, null, null, 0.9),
  // 15: م - قبضة مع رفع الخنصر فقط للأعلى بمفرده
  P([0.45, 0.18, 1, 1, 1], 0, null, null, 0.62),
  // 16: ن - السبابة منحنية قليلاً والإبهام يقابلها (وعاء النون/هلال)
  P([0.42, 0.42, 0.35, 1, 1], 0, null, null, 0.85),
  // 17: ق - حلقة مقفلة بين طرفي الإبهام والسبابة والوسطى تغطيها
  P([0.92, 0.42, 1, 1, 1], 0, null, "shake", 0.85),
  // 18: ر - قبضة والسبابة خطاف مع حركة سحب/تحريك
  P([0.97, 1, 1, 1, 1], 0, null, null, 0.97),
  // 19: ص - قبضة مقفولة تواجه الأمام والإبهام فوق الأصابع
  P([0.1, 0.06, 0.06, 0.07, 0.08], 0.04, null, null, 0.35),
  // 20: س - كف رأسي مسطح وأصابع مضمومة والإبهام ممدود جانبياً
  P([0.05, 0.02, 0.03, 0.04, 0.05], 0.9, null, null, 0.3),
  // 21: ش - كف مفتوح للأمام مع تفريق الأصابع الخمسة بالكامل
  P([0.45, 0.03, 0.55, 0.92, 0.94], 0, null, null, 0.68),
  // 22: ط - السبابة قائمة عصاً وحلقة بين الإبهام والوسطى والبنصر والخنصر مغلقان
  P([0.95, 0.03, 0.06, 1, 1], 0.02, null, null, 0.9),
  // 23: ت - قبضة مع رفع السبابة والوسطى مضمومين (نقطتان)
  P([0.4, 0.4, 0.06, 0.06, 0.06], 0.18, null, null, 0.66),
  // 24: ة - حلقة بين الإبهام والسبابة ومدّ الوسطى والبنصر والخنصر للأعلى
  P([0.22, 0.2, 0.1, 1, 1], 0, [0, 0, -0.7], null, 0.5),
  // 25: ذ - مثل الدال مع مدّ الوسطى مائلاً للأعلى (النقطة)
  P([0.95, 0.03, 0.05, 0.06, 1], 0.05, null, null, 0.95),
  // 26: ث - قبضة مع رفع ثلاثة أصابع مضمومة والإبهام يطوي الخنصر
  P([0.55, 0.6, 0.7, 0.78, 0.82], 0.06, [0.55, 0, 0.2], null, 0.8),
  // 27: و - كف مائل للأسفل مقوس وأصابع شبه مطوية (قوس الواو المقلوب)
  P([0.03, 1, 1, 1, 0.05], 0.2, null, null, 0.12),
  // 28: ي - الشاكا: الإبهام والخنصر ممدودان والثلاثة الوسطى في القبضة
  P([0.45, 0.03, 0.1, 0.92, 0.94], 0.1, null, null, 0.68),
  // 29: ظ - مثل الطاء مع مدّ الوسطى للخارج (النقطة)
  P([0.92, 0.42, 0.46, 1, 1], 0.02, null, null, 0.85),
  // 30: ز - السبابة والوسطى خطاف مزدوج للأمام من القبضة
  P([0.5, 0.5, 0.5, 0.5, 0.5], 0, null, "del"),
  // 31: DEL - مسحة للخلف
  P([0, 0, 0, 0, 0], 0.3)
  // 32: SPACE - كف مفتوح ثابت
];
const ICE_CFG = { current: null };
const normalizeRoomCode = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 8);
const getIceServers = (turnU, turnUsr, turnC) => {
  const u = turnU && String(turnU).trim() || "";
  const usr = turnUsr && String(turnUsr).trim() || "";
  const cred = turnC && String(turnC).trim() || "";
  const stun = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478", "stun:stun.relay.metered.ca:80"] };
  if (u) {
    const urls = u.split(",").map((s) => s.trim()).filter(Boolean);
    const entry = { urls };
    if (usr || cred) {
      entry.username = usr || void 0;
      entry.credential = cred || void 0;
    }
    return { iceServers: [stun, entry], iceCandidatePoolSize: 4 };
  }
  if (ICE_CFG.current && Array.isArray(ICE_CFG.current.iceServers) && ICE_CFG.current.iceServers.length) {
    return { iceServers: ICE_CFG.current.iceServers.slice(), iceCandidatePoolSize: 4 };
  }
  return { iceServers: [stun], iceCandidatePoolSize: 4 };
};
function makeChain(lens, rads, mat, jmat, nailM, opts) {
  const o = opts || {};
  const root = new THREE.Group();
  const joints = [];
  let parent = root;
  const n = lens.length;
  for (let i = 0; i < n; i++) {
    const j = new THREE.Group();
    if (i > 0) {
      j.position.y = lens[i - 1];
      if (o.bowZ) j.position.z = o.bowZ * i;
    }
    parent.add(j);
    joints.push(j);
    const rB = rads[i], rT = i < n - 1 ? rads[i + 1] : rads[i] * 0.84;
    const h = lens[i], N = 26, prof = [];
    const isTip = i === n - 1;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      let r;
      if (isTip) {
        if (t < 0.5) {
          r = THREE.MathUtils.lerp(rB, rT, t / 0.5);
        } else {
          const s = (t - 0.5) / 0.5;
          r = rT * Math.pow(Math.max(0, Math.cos(s * Math.PI * 0.5)), 0.82);
        }
      } else {
        const belly = Math.sin(t * Math.PI) * rB * 0.045;
        const flare = t < 0.12 ? (0.12 - t) / 0.12 * rB * 0.05 : 0;
        r = THREE.MathUtils.lerp(rB, rT, t) + belly + flare;
      }
      prof.push(new THREE.Vector2(Math.max(r, 1e-3), (t - 0.5) * h));
    }
    const geo = new THREE.LatheGeometry(prof, 30);
    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      pos.setX(k, pos.getX(k) * 1.04);
      pos.setZ(k, pos.getZ(k) * 0.9);
    }
    const uv = new Float32Array(pos.count * 2);
    for (let k = 0; k < pos.count; k++) {
      const px = pos.getX(k), py = pos.getY(k), pz = pos.getZ(k);
      uv[k * 2] = (Math.atan2(pz, px) + Math.PI) / (2 * Math.PI);
      uv[k * 2 + 1] = (py + h * 0.5) / h;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    const seg = new THREE.Mesh(geo, mat);
    seg.position.y = h * 0.5;
    j.add(seg);
    const kn = new THREE.Mesh(new THREE.SphereGeometry(rB * 1.05, 20, 14), jmat);
    kn.scale.set(1, 0.78, 0.9);
    j.add(kn);
    if (isTip && nailM) {
      const nR = rT * (o.nailScale || 0.62);
      const nail = new THREE.Mesh(new THREE.SphereGeometry(nR, 20, 14), nailM);
      nail.scale.set(0.82, 1.32, 0.22);
      nail.position.set(0, h - rT * 0.4, -rB * 0.58);
      nail.rotation.x = o.nailRotX !== void 0 ? o.nailRotX : 0.2;
      nail.rotation.z = o.nailTilt || 0;
      j.add(nail);
    }
    parent = j;
  }
  return { group: root, joints };
}
function skinMaps() {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d");
  x.fillStyle = "#f1d6c4";
  x.fillRect(0, 0, S, S);
  const blotch = (n, rgb, amin, amax, rs, re) => {
    for (let i = 0; i < n; i++) {
      const gx = Math.random() * S, gy = Math.random() * S, r = rs + Math.random() * (re - rs);
      const a = (amin + Math.random() * (amax - amin)).toFixed(3);
      const g = x.createRadialGradient(gx, gy, 0, gx, gy, r);
      g.addColorStop(0, "rgba(" + rgb + "," + a + ")");
      g.addColorStop(1, "rgba(" + rgb + ",0)");
      x.fillStyle = g;
      x.beginPath();
      x.arc(gx, gy, r, 0, 7);
      x.fill();
    }
  };
  blotch(46, "196,112,82", 0.04, 0.1, 26, 88);
  blotch(26, "255,212,176", 0.04, 0.09, 18, 58);
  blotch(20, "148,118,116", 0.03, 0.07, 14, 48);
  for (let i = 0; i < 2400; i++) {
    const a = 0.02 + Math.random() * 0.06;
    x.fillStyle = Math.random() < 0.5 ? "rgba(176,104,80," + a + ")" : "rgba(255,236,222," + a + ")";
    const s = 0.8 + Math.random() * 1.8;
    x.fillRect(Math.random() * S, Math.random() * S, s, s);
  }
  for (let i = 0; i < 9e3; i++) {
    const a = 0.02 + Math.random() * 0.05;
    x.fillStyle = Math.random() < 0.5 ? "rgba(150,90,72," + a + ")" : "rgba(255,244,232," + a + ")";
    x.fillRect(Math.random() * S, Math.random() * S, 1, 1);
  }
  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.encoding = THREE.sRGBEncoding;
  const H = 512;
  const hc = document.createElement("canvas");
  hc.width = hc.height = H;
  const hx = hc.getContext("2d");
  hx.fillStyle = "#808080";
  hx.fillRect(0, 0, H, H);
  const bumpSpan = (n, vmin, vmax, rmin, rmax, al) => {
    for (let i = 0; i < n; i++) {
      const gx = Math.random() * H, gy = Math.random() * H, r = rmin + Math.random() * (rmax - rmin);
      const v = vmin + Math.random() * (vmax - vmin), a = al.toFixed(3);
      const g = hx.createRadialGradient(gx, gy, 0, gx, gy, r);
      g.addColorStop(0, "rgba(" + v + "," + v + "," + v + "," + a + ")");
      g.addColorStop(1, "rgba(" + v + "," + v + "," + v + ",0)");
      hx.fillStyle = g;
      hx.beginPath();
      hx.arc(gx, gy, r, 0, 7);
      hx.fill();
    }
  };
  bumpSpan(90, 60, 100, 14, 90, 0.06);
  bumpSpan(420, 160, 210, 2, 5, 0.16);
  bumpSpan(220, 90, 160, 5, 26, 0.1);
  for (let i = 0; i < 5e3; i++) {
    const v = 120 + Math.floor(Math.random() * 46);
    hx.fillStyle = "rgba(" + v + "," + v + "," + v + ",0.5)";
    hx.fillRect(Math.random() * H, Math.random() * H, 1, 1);
  }
  const img = hx.getImageData(0, 0, H, H).data;
  const nc = document.createElement("canvas");
  nc.width = nc.height = H;
  const nx = nc.getContext("2d");
  const nd = nx.createImageData(H, H);
  const str = 3;
  for (let v = 1; v < H - 1; v++) {
    for (let u = 1; u < H - 1; u++) {
      const i = (v * H + u) * 4;
      const hl = img[i - 4], hr = img[i + 4], hu = img[i - H * 4], hd = img[i + H * 4];
      let nxc = -(hr - hl) * str / 255, nyc = -(hd - hu) * str / 255, nz = 1;
      const inv = 1 / Math.sqrt(nxc * nxc + nyc * nyc + nz * nz);
      nxc *= inv;
      nyc *= inv;
      nz *= inv;
      nd.data[i] = Math.round((nxc * 0.5 + 0.5) * 255);
      nd.data[i + 1] = Math.round((nyc * 0.5 + 0.5) * 255);
      nd.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nd.data[i + 3] = 255;
    }
  }
  nx.putImageData(nd, 0, 0);
  const normal = new THREE.CanvasTexture(nc);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  const W = 128;
  const n1 = document.createElement("canvas");
  n1.width = n1.height = W;
  const z = n1.getContext("2d");
  const ng = z.createLinearGradient(0, 0, 0, W);
  ng.addColorStop(0, "#f3dcd0");
  ng.addColorStop(0.16, "#f7e3d8");
  ng.addColorStop(0.3, "#f2cdb8");
  ng.addColorStop(0.55, "#eec3ad");
  ng.addColorStop(0.82, "#e7b59e");
  ng.addColorStop(1, "#e2ab95");
  z.fillStyle = ng;
  z.fillRect(0, 0, W, W);
  z.fillStyle = "rgba(251,241,234,0.95)";
  z.beginPath();
  z.moveTo(0, 0);
  z.lineTo(W, 0);
  z.lineTo(W, W * 0.16);
  z.quadraticCurveTo(W * 0.5, W * 0.5, 0, W * 0.16);
  z.closePath();
  z.fill();
  z.fillStyle = "rgba(255,238,228,0.55)";
  z.beginPath();
  z.arc(W * 0.5, W * 0.86, W * 0.3, 0, Math.PI * 2);
  z.fill();
  z.strokeStyle = "rgba(150,90,74,0.45)";
  z.lineWidth = W * 0.05;
  z.beginPath();
  z.moveTo(0, W * 0.96);
  z.quadraticCurveTo(W * 0.5, W * 0.82, W, W * 0.96);
  z.stroke();
  for (let i = 0; i < 46; i++) {
    const sx = Math.random() * W;
    z.strokeStyle = "rgba(255,255,255," + (0.03 + Math.random() * 0.05).toFixed(3) + ")";
    z.lineWidth = 0.6;
    z.beginPath();
    z.moveTo(sx, 0);
    z.lineTo(sx - 1 + Math.random() * 2, W);
    z.stroke();
  }
  const nail = new THREE.CanvasTexture(n1);
  nail.encoding = THREE.sRGBEncoding;
  return { map, normal, nail };
}
function shapePalm(geo) {
  const p = geo.attributes.position;
  for (let k = 0; k < p.count; k++) {
    let X = p.getX(k), Y = p.getY(k), Z = p.getZ(k);
    if (Z > 0.15 && Math.abs(X) < 0.9) {
      const c = Math.max(0, 1 - Math.abs(Y) * 0.85);
      Z -= 0.055 * c * (Z - 0.15);
    }
    if (Z < -0.15) {
      const c = 1 - Math.abs(Y) * 0.5;
      Z -= 0.03 * c * (1 - Math.min(1, Math.abs(X) * 1.1));
    }
    const fl = 0.09 * Math.max(0, Y);
    X *= 1 + fl * 0.18;
    p.setX(k, X);
    p.setY(k, Y);
    p.setZ(k, Z);
  }
  geo.computeVertexNormals();
}
function buildHand() {
  const g = new THREE.Group();
  const maps = skinMaps();
  const skin = new THREE.MeshPhysicalMaterial({ color: 13207916, roughness: 0.6, metalness: 0, clearcoat: 0.05, clearcoatRoughness: 0.6, sheen: 0.28, sheenColor: new THREE.Color(16751222), sheenRoughness: 0.6, map: maps.map, normalMap: maps.normal, normalScale: new THREE.Vector2(0.55, 0.55), envMapIntensity: 0.55 });
  const skin2 = new THREE.MeshPhysicalMaterial({ color: 13799280, roughness: 0.56, metalness: 0, clearcoat: 0.05, clearcoatRoughness: 0.6, sheen: 0.26, sheenColor: new THREE.Color(16752768), sheenRoughness: 0.55, map: maps.map, normalMap: maps.normal, normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: 0.5 });
  const nailM = new THREE.MeshPhysicalMaterial({ color: 16774380, roughness: 0.1, metalness: 0.02, clearcoat: 1, clearcoatRoughness: 0.05, sheen: 0.5, sheenColor: new THREE.Color(16768200), sheenRoughness: 0.18, map: maps.nail, envMapIntensity: 1.25 });
  nailM.userData.avNail = 1;
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 30), skin);
  palm.scale.set(0.52, 0.46, 0.26);
  shapePalm(palm.geometry);
  g.add(palm);
  const heel = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 16), skin);
  heel.scale.set(0.92, 0.7, 0.74);
  heel.position.set(0.02, -0.46, 0.01);
  g.add(heel);
  const thenar = new THREE.Mesh(new THREE.SphereGeometry(0.235, 20, 16), skin2);
  thenar.scale.set(0.72, 1.22, 0.62);
  thenar.position.set(-0.375, -0.14, 0.07);
  thenar.rotation.z = 0.62;
  g.add(thenar);
  const hypothenar = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), skin2);
  hypothenar.scale.set(0.6, 1.05, 0.5);
  hypothenar.position.set(0.345, -0.2, 0.03);
  hypothenar.rotation.z = -0.55;
  g.add(hypothenar);
  const knX = [-0.315, -0.105, 0.11, 0.318];
  for (let i = 0; i < 4; i++) {
    const kb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), skin);
    kb.scale.set(0.85, 0.6, 0.55);
    kb.position.set(knX[i], 0.3, -0.045);
    g.add(kb);
  }
  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.62, 20, 1), skin);
  forearm.scale.set(0.95, 1, 0.82);
  forearm.position.set(0, -0.72, 0.02);
  forearm.rotation.x = 0.08;
  g.add(forearm);
  const ulna = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), skin);
  ulna.scale.set(0.7, 0.9, 0.55);
  ulna.position.set(0.1, -0.56, -0.05);
  g.add(ulna);
  const fingers = [];
  const fpos = [[-0.34, 0.31], [-0.115, 0.35], [0.115, 0.34], [0.34, 0.295]];
  const cfg = [
    { len: [0.39, 0.28, 0.225], r: [0.12, 0.104, 0.088] },
    { len: [0.45, 0.32, 0.255], r: [0.13, 0.112, 0.095] },
    { len: [0.42, 0.3, 0.235], r: [0.125, 0.108, 0.092] },
    { len: [0.34, 0.245, 0.2], r: [0.11, 0.095, 0.08] }
  ];
  for (let i = 0; i < 4; i++) {
    const rootG = new THREE.Group();
    rootG.position.set(fpos[i][0], fpos[i][1], 0.01);
    g.add(rootG);
    const ch = makeChain(cfg[i].len, cfg[i].r, skin, skin2, nailM, { bowZ: 0.014 });
    rootG.add(ch.group);
    fingers.push(ch);
  }
  const troot = new THREE.Group();
  troot.position.set(-0.42, -0.12, 0.04);
  g.add(troot);
  const thumb = makeChain([0.29, 0.23, 0.17], [0.178, 0.15, 0.125], skin, skin2, nailM, { bowZ: 0.028, nailRotX: 0.5, nailScale: 0.72 });
  troot.add(thumb.group);
  return { group: g, fingers, thumb, thumbRoot: troot, maps };
}
function AvatarView({ apiRef }) {
  const mountRef = useRef(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => {
    const mount = mountRef.current;
    if (typeof THREE === "undefined") {
      mount.innerHTML = '<div style="padding:20px;font:11px JetBrains Mono,monospace;color:#f87171">three.js failed to load - check internet connection.</div>';
      return void 0;
    }
    try {
      window.__AV_MOUNTS = (window.__AV_MOUNTS || 0) + 1;
      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
      cam.position.set(0, 0.42, 4.9);
      cam.lookAt(0, 0.1, 0);
      const ren = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      ren.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      ren.toneMapping = THREE.ACESFilmicToneMapping;
      ren.toneMappingExposure = 1.15;
      ren.outputEncoding = THREE.sRGBEncoding;
      ren.shadowMap.enabled = true;
      ren.shadowMap.type = THREE.PCFSoftShadowMap;
      ren.setClearColor(790552);
      ren.domElement.style.width = "100%";
      ren.domElement.style.height = "100%";
      ren.domElement.style.display = "block";
      ren.domElement.id = "avatar3d";
      mount.appendChild(ren.domElement);
      scene.add(new THREE.HemisphereLight(16773344, 1707526, 0.5));
      const keyL = new THREE.DirectionalLight(16772829, 1.15);
      keyL.position.set(2, 3.5, 4);
      keyL.castShadow = true;
      keyL.shadow.mapSize.set(1024, 1024);
      keyL.shadow.camera.left = -3;
      keyL.shadow.camera.right = 3;
      keyL.shadow.camera.top = 3;
      keyL.shadow.camera.bottom = -3;
      keyL.shadow.camera.near = 0.5;
      keyL.shadow.camera.far = 15;
      keyL.shadow.bias = -6e-4;
      keyL.shadow.radius = 5;
      keyL.shadow.camera.updateProjectionMatrix();
      scene.add(keyL);
      const fillL = new THREE.DirectionalLight(16771280, 0.45);
      fillL.position.set(-3, 0.5, 3);
      scene.add(fillL);
      const rimL = new THREE.PointLight(16766112, 0.55, 20);
      rimL.position.set(-1.5, 2, -3);
      scene.add(rimL);
      const bottomFill = new THREE.PointLight(16764074, 0.2, 12);
      bottomFill.position.set(0, -2, 2.5);
      scene.add(bottomFill);
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShadowMaterial({ opacity: 0.18 }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -2.75;
      ground.receiveShadow = true;
      scene.add(ground);
      const armPivot = new THREE.Group();
      armPivot.position.set(0, -0.55, 0);
      scene.add(armPivot);
      const wrist = new THREE.Group();
      armPivot.add(wrist);
      const hand = buildHand();
      wrist.add(hand.group);
      hand.group.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
        }
      });
      hand.group.rotation.y = -0.1;
      hand.group.rotation.x = -0.04;
      let envTex = null, pmremGen = null;
      try {
        pmremGen = new THREE.PMREMGenerator(ren);
        const envScene = new THREE.Scene();
        const skyC = document.createElement("canvas");
        skyC.width = 8;
        skyC.height = 128;
        const skyX = skyC.getContext("2d");
        const skyG = skyX.createLinearGradient(0, 0, 0, 128);
        skyG.addColorStop(0, "#fff1de");
        skyG.addColorStop(0.42, "#6e6257");
        skyG.addColorStop(1, "#120d0a");
        skyX.fillStyle = skyG;
        skyX.fillRect(0, 0, 8, 128);
        const skyTex = new THREE.CanvasTexture(skyC);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide }));
        envScene.add(dome);
        const panel = (w, h, rr, gg, bb, px, py, pz, rx, ry) => {
          const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(rr, gg, bb), side: THREE.DoubleSide }));
          m.position.set(px, py, pz);
          m.rotation.set(rx || 0, ry || 0, 0);
          envScene.add(m);
          return m;
        };
        panel(4, 2.2, 7, 6.1, 5, 1.6, 2.6, 2.4, 0, -0.6);
        panel(3, 1.4, 2.3, 2.7, 3.1, -2.4, 1, 1.8, 0, 1.1);
        panel(6, 3, 1.25, 1.05, 0.9, 0, -3, 0.4, Math.PI / 2, 0);
        envTex = pmremGen.fromScene(envScene, 0.04).texture;
        scene.environment = envTex;
        pmremGen.dispose();
        pmremGen = null;
        skyTex.dispose();
      } catch (_envErr) {
        envTex = null;
      }
      hand.group.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if ((m.isMeshPhysicalMaterial || m.isMeshStandardMaterial) && m.envMap !== envTex) {
            m.envMap = envTex;
            m.needsUpdate = true;
          }
        });
      });
      const SssWrap = 0.3, SssPower = 2.9, SssScale = 1.05, SssDistort = 0.62;
      const SssTint = [1, 0.42, 0.27];
      const sssFrom = "float dotNL = saturate( dot( geometry.normal, directLight.direction ) );\n	vec3 irradiance = dotNL * directLight.color;";
      const sssTo = "float dotNL = saturate( ( dot( geometry.normal, directLight.direction ) + " + SssWrap.toFixed(3) + " ) / " + (1 + SssWrap).toFixed(3) + " );\n	vec3 irradiance = dotNL * directLight.color;\n	{\n		vec3 SssDir = normalize( directLight.direction + geometry.normal * " + SssDistort.toFixed(3) + " );\n		float SssGlow = pow( saturate( dot( geometry.viewDir, -SssDir ) ), " + SssPower.toFixed(3) + " ) * " + SssScale.toFixed(3) + ";\n		irradiance += directLight.color * SssGlow * vec3(" + SssTint.join(",") + ");\n	}";
      hand.group.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (m.isMeshPhysicalMaterial && !m.userData.avNail && !m.userData.avSss) {
            m.onBeforeCompile = (sh) => {
              sh.fragmentShader = sh.fragmentShader.split(sssFrom).join(sssTo);
            };
            m.customProgramCacheKey = () => "skinSSS";
            m.userData.avSss = 1;
          }
        });
      });
      let motion = null, mStart = 0, alTimer = null, idleT = 0, poseW = [0, 0, 0];
      const MAXBEND = [1.5, 1.65, 1.35];
      const chains = [hand.thumb, hand.fingers[0], hand.fingers[1], hand.fingers[2], hand.fingers[3]];
      const mkS = (v) => ({ v, t: v, vel: 0 });
      const KS = [62, 96, 88, 79, 66];
      const ZETA = 0.82;
      const spr = {
        c: [mkS(0.14), mkS(0.07), mkS(0.07), mkS(0.07), mkS(0.07)],
        s: mkS(0.3),
        tb: mkS(0.45),
        w: [mkS(0), mkS(0), mkS(0)]
      };
      const step = (sp, k, zeta, dt) => {
        const dmp = 2 * Math.sqrt(k) * zeta;
        sp.vel += (-k * (sp.v - sp.t) - dmp * sp.vel) * dt;
        sp.v += sp.vel * dt;
      };
      const cur = { c: [0.14, 0.07, 0.07, 0.07, 0.07], s: 0.3, w: [0, 0, 0], tb: 0.45, jc: null };
      let curJc = null;
      const apply = () => {
        for (let f = 0; f < 5; f++) {
          const js = chains[f].joints;
          const cv = cur.c[f];
          if (f === 0) {
            js[0].rotation.z = -cv * 0.8;
            js[0].rotation.x = cv * 1.35;
            js[0].rotation.y = cv * 0.6;
            if (js[1]) {
              js[1].rotation.x = cv * 1.58;
              js[1].rotation.y = cv * 0.1;
            }
            if (js[2]) js[2].rotation.x = cv * 0.7;
          } else {
            const JC = curJc;
            for (let j = 0; j < js.length; j++) {
              const mm = JC && JC[j] != null ? 1.5708 * JC[j] : MAXBEND[Math.min(j, MAXBEND.length - 1)];
              js[j].rotation.x = cv * mm;
            }
          }
        }
        const SR = [0.13, 0.04, 0.06, 0.16];
        const SG = [0.21, 0.055, 0.09, 0.26];
        hand.fingers.forEach((ch, i) => {
          ch.group.rotation.z = (i < 2 ? 1 : -1) * (SR[i] + spr.s.v * SG[i]);
        });
        const tb = spr.tb.v;
        hand.thumbRoot.rotation.z = 1.26 - tb * 1.34;
        hand.thumbRoot.rotation.y = 0.16 + tb * 0.44;
        hand.thumbRoot.rotation.x = 0.08 - tb * 0.2;
        hand.thumbRoot.position.set(-0.42 + tb * 0.035, -0.12, 0.1 + tb * 0.14);
        const avgCurl = (cur.c[1] + cur.c[2] + cur.c[3] + cur.c[4]) * 0.25;
        wrist.rotation.set(cur.w[0] - avgCurl * 0.07, cur.w[1], cur.w[2]);
      };
      let raf = 0, last = performance.now();
      const tick = (now) => {
        const dt = Math.max(1e-3, Math.min(0.033, (now - last) / 1e3));
        last = now;
        for (let i = 0; i < 5; i++) {
          step(spr.c[i], KS[i], ZETA, dt);
          cur.c[i] = spr.c[i].v;
        }
        step(spr.s, 72, ZETA, dt);
        cur.s = spr.s.v;
        step(spr.tb, 58, ZETA + 0.06, dt);
        cur.tb = spr.tb.v;
        for (let i = 0; i < 3; i++) {
          step(spr.w[i], 84, 0.95, dt);
          cur.w[i] = spr.w[i].v;
        }
        let px = 0, py = 0, pz = 0, irx = 0, irz = 0, iy = 0, apr = 0, asx = 0, asz = 0;
        const t = (now - mStart) / 1e3;
        const env = Math.min(1, t * 3.2);
        if (motion === "shake") {
          px = Math.sin(t * 8.5) * 0.095;
          apr = Math.sin(t * 8.5 + 0.7) * 0.09 * env;
          asz = Math.sin(t * 8.5 + 0.35) * 0.06 * env;
          pz = -env * 0.05;
        } else if (motion === "up") {
          const ph = Math.max(0, Math.sin(Math.min(Math.PI, t * 2.2)));
          py = ph * 0.35;
          pz = -ph * 0.12;
          asx = -ph * 0.14;
          irz = ph * 0.05;
        } else if (motion === "down") {
          const ph = Math.max(0, Math.sin(Math.min(Math.PI, t * 2.2)));
          py = -ph * 0.28;
          pz = -ph * 0.08;
          asx = ph * 0.12;
        } else if (motion === "fwd") {
          const ph = Math.max(0, Math.sin(Math.min(Math.PI, t * 2)));
          pz = -ph * 0.45;
          py = ph * 0.1;
          asx = -ph * 0.18;
        } else if (motion === "roll") {
          const ph = t * 4.2;
          apr = Math.min(ph, Math.PI * 1.6);
          spr.w[2].t = -Math.min(1.15, ph * 0.8);
        } else if (motion === "j") {
          spr.w[2].t = -Math.min(1.25, t * 2.6);
          if (t < 0.5) {
            py = -(t / 0.5) * 0.26;
          } else {
            const u = Math.min(1, (t - 0.5) / 0.62);
            py = -0.26;
            px = -u * u * 0.26;
            irz = -u * 0.3;
            asz = u * 0.12;
          }
        } else if (motion === "z") {
          const ph = Math.min(1, t * 2.5);
          if (ph < 0.33) {
            const u = ph / 0.33;
            px = u * 0.3;
            py = 0;
          } else if (ph < 0.66) {
            const u = (ph - 0.33) / 0.33;
            px = 0.3 - u * 0.6;
            py = -u * 0.3;
          } else {
            const u = (ph - 0.66) / 0.34;
            px = -0.3 + u * 0.3;
            py = -0.3;
          }
          pz = 0;
          irz = 0;
        } else if (motion === "del") {
          const u = Math.min(1, t * 1.4);
          px = 0.55 - u * 1.15;
          py = -Math.sin(u * Math.PI) * 0.17;
          asz = u * 0.2;
        } else if (motion === "rest") {
          const ph = Math.max(0, Math.sin(Math.min(Math.PI, t * 1.9)));
          py = -ph * 0.34;
          pz = ph * 0.22;
          asx = ph * 0.1;
          apr = ph * 0.14;
          irz = -ph * 0.06;
          if (t > 1.75) motion = null;
        } else {
          idleT += dt;
          irx = (Math.sin(idleT * 1.15) + Math.sin(idleT * 0.63) * 0.6) * 0.024;
          irz = Math.sin(idleT * 0.71) * 0.026;
          iy = Math.sin(idleT * 1.05) * 0.02;
          pz = Math.sin(idleT * 0.83 + 0.9) * 0.032;
          apr = Math.sin(idleT * 0.47) * 0.05;
          asz = Math.sin(idleT * 0.39 + 1.2) * 0.026;
          for (let i = 0; i < 5; i++) cur.c[i] += Math.sin(idleT * 1.25 + i * 0.85) * 0.01;
          cur.c[0] += Math.sin(idleT * 0.95 + 2.1) * 0.012;
        }
        const motionDur = { shake: 1.15, up: 1.5, down: 1.5, fwd: 1.5, roll: 1.4, j: 1.25, z: 1.25, del: 0.9 };
        if (motionDur[motion] && t >= motionDur[motion]) {
          motion = null;
          for (let i = 0; i < 3; i++) spr.w[i].t = poseW[i];
        }
        const wn = now * 1e-3;
        px += Math.sin(wn * 1.13 + 1.7) * 6e-3 + Math.sin(wn * 2.31) * 3e-3;
        py += Math.sin(wn * 0.97 + 0.4) * 5e-3;
        pz += Math.cos(wn * 0.79 + 2.6) * 6e-3;
        wrist.position.set(px, py + 0.55 + iy, pz);
        apply();
        wrist.rotation.x += irx;
        wrist.rotation.z += irz;
        armPivot.rotation.set(asx, apr, asz);
        const fitCurl = (cur.c[1] + cur.c[2] + cur.c[3] + cur.c[4]) * 0.25;
        const fitZ = 4.72 - Math.min(1, Math.max(0, fitCurl)) * 1.12;
        cam.position.z += (fitZ - cam.position.z) * Math.min(1, dt * 5.5);
        ren.render(scene, cam);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      const resize = () => {
        const w = mount.clientWidth || 320, h = mount.clientHeight || 260;
        ren.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      };
      resize();
      const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
      if (ro) ro.observe(mount);
      else window.addEventListener("resize", resize);
      const mkT = (p) => ({ c: p.c.slice(), s: p.s, w: p.w.slice(), tb: p.tb != null ? p.tb : p.c[0] >= 0.7 ? 0.85 : 0.3, jc: p.jc || null });
      const NEUTRAL = { c: [0.14, 0.07, 0.07, 0.07, 0.07], s: 0.3, w: [0, 0, 0], tb: 0.45, jc: null };
      const setTgt = (q) => {
        for (let i = 0; i < 5; i++) spr.c[i].t = q.c[i];
        spr.s.t = q.s;
        spr.tb.t = q.tb;
        poseW = q.w.slice();
        for (let i = 0; i < 3; i++) spr.w[i].t = poseW[i];
        curJc = q.jc || null;
      };
      const snapAll = (q) => {
        setTgt(q);
        for (let i = 0; i < 5; i++) {
          spr.c[i].v = q.c[i];
          spr.c[i].vel = 0;
        }
        spr.s.v = q.s;
        spr.s.vel = 0;
        spr.tb.v = q.tb;
        spr.tb.vel = 0;
        for (let i = 0; i < 3; i++) {
          spr.w[i].v = q.w[i];
          spr.w[i].vel = 0;
        }
        poseW = q.w.slice();
        curJc = q.jc || null;
      };
      apiRef.current = {
        sign: (cls, lang) => {
          const tbl = lang === "ar" ? POSES_AR : POSES_EN;
          const p = tbl[Math.max(0, Math.min(tbl.length - 1, cls))] || tbl[0];
          if (alTimer) {
            clearTimeout(alTimer);
            alTimer = null;
          }
          if (p.m === "al") {
            motion = null;
            mStart = performance.now();
            setTgt(mkT(POSES_AR[14]));
            alTimer = setTimeout(() => {
              setTgt(mkT(POSES_AR[2]));
            }, 430);
            return;
          }
          motion = p.m || null;
          mStart = performance.now();
          setTgt(mkT(p));
          idleT = 0;
        },
        neutral: () => {
          if (alTimer) {
            clearTimeout(alTimer);
            alTimer = null;
          }
          motion = null;
          mStart = performance.now();
          setTgt(NEUTRAL);
        },
        rest: () => {
          if (alTimer) {
            clearTimeout(alTimer);
            alTimer = null;
          }
          motion = "rest";
          mStart = performance.now();
          idleT = 0;
          setTgt(NEUTRAL);
        },
        poseNow: (cls, lang) => {
          const tbl = lang === "ar" ? POSES_AR : POSES_EN;
          const p = tbl[Math.max(0, Math.min(tbl.length - 1, cls))] || tbl[0];
          if (alTimer) {
            clearTimeout(alTimer);
            alTimer = null;
          }
          motion = null;
          snapAll(mkT(p));
          idleT = 0;
          apply();
          ren.render(scene, cam);
        },
        frame: () => {
          apply();
          ren.render(scene, cam);
        },
        debug: () => {
          let m = 0, v = 0;
          scene.traverse(function(o) {
            if (o.isMesh) {
              m++;
              v += o.geometry.attributes.position.count;
            }
          });
          return { meshes: m, verts: v };
        }
      };
      window.__avatarApi = apiRef.current;
      return () => {
        cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        else window.removeEventListener("resize", resize);
        if (alTimer) clearTimeout(alTimer);
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) {
              o.material.forEach((m) => {
                if (m.map) m.map.dispose();
                if (m.normalMap) m.normalMap.dispose();
                if (m.bumpMap) m.bumpMap.dispose();
                m.dispose();
              });
            } else {
              if (o.material.map) o.material.map.dispose();
              if (o.material.normalMap) o.material.normalMap.dispose();
              if (o.material.bumpMap) o.material.bumpMap.dispose();
              o.material.dispose();
            }
          }
        });
        if (envTex) envTex.dispose();
        if (pmremGen) pmremGen.dispose();
        ren.dispose();
        if (ren.domElement && ren.domElement.parentNode) ren.domElement.parentNode.removeChild(ren.domElement);
        apiRef.current = null;
      };
    } catch (err) {
      console.warn("3D avatar disabled:", err && err.message);
      setAvatarFailed(true);
      apiRef.current = { sign: () => {
      }, neutral: () => {
      }, rest: () => {
      }, poseNow: () => {
      }, frame: () => {
      }, debug: () => ({ meshes: 0, verts: 0 }) };
      window.__avatarApi = apiRef.current;
      return void 0;
    }
  }, []);
  if (avatarFailed) {
    return /* @__PURE__ */ React.createElement("div", { className: "avatar-box", style: { display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 20, color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.8 } }, /* @__PURE__ */ React.createElement("span", null, "\u{1F9CF} 3D avatar unavailable on this device", /* @__PURE__ */ React.createElement("br", null), "(WebGL disabled or unsupported)", /* @__PURE__ */ React.createElement("br", null), "Text \u2192 sign captions still work normally."));
  }
  return /* @__PURE__ */ React.createElement("div", { ref: mountRef, className: "avatar-box" });
}
function heuristic(feats, lang, gate) {
  const FT = [4, 8, 12, 16, 20], PP = [3, 6, 10, 14, 18];
  const d = (a, b) => {
    const dx = feats[a * 3] - feats[b * 3], dy = feats[a * 3 + 1] - feats[b * 3 + 1];
    return Math.sqrt(dx * dx + dy * dy);
  };
  let open = 0;
  const states = [];
  const thumbUp = d(4, 17) > d(3, 17) * 1.05;
  states.push(thumbUp);
  if (thumbUp) open++;
  for (let i = 1; i < 5; i++) {
    const up = feats[FT[i] * 3 + 1] < feats[PP[i] * 3 + 1];
    states.push(up);
    if (up) open++;
  }
  const classes = lang === "ar" ? AR_CLASSES : EN_CLASSES;
  let idx = 0;
  if (open === 0) idx = 0;
  else if (open === 5) idx = 1;
  else if (open === 1 && states[1]) idx = 3;
  else if (open === 2 && states[1] && states[2]) idx = 7;
  else if (open === 2 && states[0] && states[1]) idx = 11;
  else if (open === 3) idx = 2;
  else if (open === 4) idx = 5;
  else idx = Math.min(open, classes.length - 1);
  const letter = classes[idx];
  const confidence = 0.75;
  return { letter, name: letter, class_id: idx, confidence: confidence >= (gate || 0.6) ? confidence : 0, top3: [{ letter, eng: letter, conf: confidence }], heuristic: true };
}
function LocalVideo({ stream, isCamOn, onVideoRef }) {
  const vRef = useRef(null);
  useEffect(() => {
    const v = vRef.current;
    if (v && stream) {
      if (v.srcObject !== stream) v.srcObject = stream;
      v.muted = true;
      v.play().catch(() => {
      });
      if (onVideoRef) onVideoRef(v);
    }
  }, [stream, onVideoRef]);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "relative", width: "100%", height: "100%", background: "#000", overflow: "hidden" } }, /* @__PURE__ */ React.createElement(
    "video",
    {
      ref: vRef,
      autoPlay: true,
      playsInline: true,
      muted: true,
      style: { width: "100%", height: "100%", objectFit: "contain", display: isCamOn !== false ? "block" : "none", transform: "scaleX(-1)" }
    }
  ), isCamOn === false && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, background: "#0b0f17", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)", fontSize: 12, fontFamily: "var(--mono)" } }, "\u{1F4F7} CAMERA OFF"));
}
function RemoteVideo({ stream, isMuted, onAutoplayBlocked, videoElementRef }) {
  const vRef = useRef(null);
  useEffect(() => {
    const v = vRef.current;
    if (!v || !stream) return;
    if (videoElementRef) videoElementRef.current = v;
    if (v.srcObject !== stream) v.srcObject = stream;
    v.muted = !!isMuted;
    v.volume = 1;
    const tryPlay = () => {
      if (!v || !v.srcObject) return;
      const p = v.play();
      if (p !== void 0) {
        p.catch(() => {
          if (!isMuted) {
            v.muted = true;
            v.play().catch(() => {
            });
            if (onAutoplayBlocked) onAutoplayBlocked(true);
          }
        });
      }
    };
    tryPlay();
    const trackHandlers = [];
    const attachTrackListeners = () => {
      trackHandlers.forEach(([t, ev, fn]) => t.removeEventListener(ev, fn));
      trackHandlers.length = 0;
      stream.getTracks().forEach((track) => {
        const onUnmute = () => {
          tryPlay();
        };
        const onEnded = () => {
          tryPlay();
        };
        track.addEventListener("unmute", onUnmute);
        track.addEventListener("ended", onEnded);
        trackHandlers.push([track, "unmute", onUnmute], [track, "ended", onEnded]);
      });
    };
    attachTrackListeners();
    const onTracksChanged = () => {
      attachTrackListeners();
      tryPlay();
    };
    stream.addEventListener("addtrack", onTracksChanged);
    stream.addEventListener("removetrack", onTracksChanged);
    return () => {
      if (videoElementRef && videoElementRef.current === v) videoElementRef.current = null;
      stream.removeEventListener("addtrack", onTracksChanged);
      stream.removeEventListener("removetrack", onTracksChanged);
      trackHandlers.forEach(([t, ev, fn]) => t.removeEventListener(ev, fn));
    };
  }, [stream, isMuted, onAutoplayBlocked, videoElementRef]);
  return /* @__PURE__ */ React.createElement("div", { style: { position: "relative", width: "100%", height: "100%", background: "#000", overflow: "hidden" } }, /* @__PURE__ */ React.createElement(
    "video",
    {
      ref: vRef,
      autoPlay: true,
      playsInline: true,
      muted: isMuted,
      style: { width: "100%", height: "100%", objectFit: "contain", display: "block" }
    }
  ));
}
const NAV_TABS = [
  ["sign", "\u{1F590}", "SIGN"],
  ["upload", "\u{1F4E4}", "UPLOAD & SIGN"],
  ["net", "\u{1F3E0}", "SIGN ROOMS"],
  ["build", "\u{1F9CF}", "TEXT TO SIGN"],
  ["quiz", "\u{1F393}", "LEARN & QUIZ"],
  ["alpha", "\u{1F524}", "ALPHABET"],
  ["history", "\u{1F4CA}", "HISTORY \u2022 STATS"]
];
function MobilePortal({ mobile, children }) {
  if (!mobile || !ReactDOM || !ReactDOM.createPortal) return children;
  return ReactDOM.createPortal(children, document.body);
}
function RemoteTile({ compact, pId, remoteStreamsMap, remoteStreamsRef, webrtcConnectedMap, remoteFrame, roomPeers, netRoom, roomMuted, onAutoplayBlocked, remoteVideoElRef }) {
  const hasWebRTC = pId && (remoteStreamsMap[pId] || remoteStreamsRef.current[pId]) && webrtcConnectedMap[pId];
  if (hasWebRTC) {
    return /* @__PURE__ */ React.createElement(
      RemoteVideo,
      {
        stream: remoteStreamsMap[pId] || remoteStreamsRef.current[pId] || null,
        isMuted: roomMuted,
        onAutoplayBlocked,
        videoElementRef: remoteVideoElRef
      }
    );
  }
  if (remoteFrame) {
    return /* @__PURE__ */ React.createElement("div", { style: { position: "relative", width: "100%", height: "100%", background: "#000", overflow: "hidden" } }, /* @__PURE__ */ React.createElement("img", { src: remoteFrame, alt: "Participant", style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }));
  }
  if (roomPeers.length === 0) {
    return /* @__PURE__ */ React.createElement("div", { className: "center-overlay", style: compact ? { position: "relative", padding: 16 } : null }, /* @__PURE__ */ React.createElement("div", { className: "logo-lg", style: compact ? { width: 50, height: 50, fontSize: 22, marginBottom: 8 } : null }, "\u231B"), compact ? /* @__PURE__ */ React.createElement("h3", { style: { fontSize: 14, fontWeight: 700 } }, "Waiting for participant\u2026") : /* @__PURE__ */ React.createElement("h2", null, "Waiting for participant\u2026"), /* @__PURE__ */ React.createElement("p", { style: compact ? { fontSize: 11, marginTop: 4 } : null }, "Share room code ", /* @__PURE__ */ React.createElement("b", null, netRoom), compact ? " to connect." : " \u2014 you can already sign or type, your draft builds below."));
  }
  return /* @__PURE__ */ React.createElement("div", { className: "center-overlay", style: compact ? { position: "relative", padding: 16 } : null }, /* @__PURE__ */ React.createElement("div", { className: "logo-lg", style: compact ? { width: 50, height: 50, fontSize: 24, marginBottom: 8, background: "rgba(38,208,255,.15)", borderColor: "rgba(38,208,255,.4)" } : { fontSize: 32 } }, "\u{1F4E1}"), compact ? /* @__PURE__ */ React.createElement("h3", { style: { fontSize: 14, fontWeight: 700, color: "#fff" } }, "Connecting Live Video\u2026") : /* @__PURE__ */ React.createElement("h2", null, "Participant in Room (", roomPeers.length, ")"), /* @__PURE__ */ React.createElement("p", { style: compact ? { fontSize: 11, color: "var(--cyan)", marginTop: 4, maxWidth: 260, lineHeight: 1.4 } : { color: "var(--cyan)", maxWidth: "44ch" } }, "Participant joined. Live video stream starting\u2026"));
}
function RoomStage(props) {
  const {
    viewMode,
    stageWrapRef,
    localStream,
    streamRef,
    roomCamOn,
    canvasRef,
    netName,
    peerIds,
    remoteStreamsMap,
    remoteStreamsRef,
    webrtcConnectedMap,
    remoteFrame,
    roomPeers,
    netRoom,
    roomMuted,
    onAutoplayBlocked,
    remoteVideoElRef,
    peerColor,
    peerNameOf,
    remotePeerInfo,
    bigCap,
    overlay,
    signOn
  } = props;
  const pId = peerIds[0];
  const tileProps = { compact: viewMode === "split", pId, remoteStreamsMap, remoteStreamsRef, webrtcConnectedMap, remoteFrame, roomPeers, netRoom, roomMuted, onAutoplayBlocked, remoteVideoElRef };
  if (viewMode === "split") {
    return /* @__PURE__ */ React.createElement("div", { className: "stage-split", ref: stageWrapRef }, /* @__PURE__ */ React.createElement("div", { className: "video-tile me" }, /* @__PURE__ */ React.createElement(LocalVideo, { stream: localStream || streamRef.current, isCamOn: roomCamOn }), /* @__PURE__ */ React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }), /* @__PURE__ */ React.createElement("span", { className: "tile-tag" }, "YOU", netName ? " \u2022 " + netName : "", " (ME)")), /* @__PURE__ */ React.createElement("div", { className: "video-tile" }, /* @__PURE__ */ React.createElement(RemoteTile, { ...tileProps }), /* @__PURE__ */ React.createElement("span", { className: "tile-tag", style: { borderColor: peerColor(pId), color: peerColor(pId) } }, (peerNameOf(pId) || "PARTICIPANT").toUpperCase(), remoteFrame ? " \u2022 LIVE" : peerIds.length > 0 ? " \u2022 LIVE" : roomPeers.length > 0 ? " \u2022 IN ROOM" : "", remotePeerInfo.role ? " \u2022 " + (remotePeerInfo.role === "hearing" ? "HEARING" : "DEAF") : "")), bigCap && /* @__PURE__ */ React.createElement("div", { role: "status", "aria-live": "polite", className: "bigcap", dir: "auto" }, bigCap.text), signOn && /* @__PURE__ */ React.createElement("div", { className: "stage-avatar", id: "av-host-net", "aria-label": "Sign language avatar" }), overlay);
  }
  return /* @__PURE__ */ React.createElement("div", { className: "stage-video", ref: stageWrapRef }, /* @__PURE__ */ React.createElement(RemoteTile, { ...tileProps }), /* @__PURE__ */ React.createElement("span", { className: "tile-tag", style: { borderColor: peerColor(pId), color: peerColor(pId) } }, (peerNameOf(pId) || "PARTICIPANT").toUpperCase(), peerIds.length > 0 ? " \u2022 LIVE" : roomPeers.length > 0 ? " \u2022 IN ROOM" : "", remotePeerInfo.role ? " \u2022 " + (remotePeerInfo.role === "hearing" ? "HEARING" : "DEAF") : ""), /* @__PURE__ */ React.createElement("div", { className: "pip-self" }, /* @__PURE__ */ React.createElement(LocalVideo, { stream: localStream || streamRef.current, isCamOn: roomCamOn }), /* @__PURE__ */ React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }), /* @__PURE__ */ React.createElement("span", { className: "self-tag" }, "YOU", netName ? " \u2022 " + netName : "")), bigCap && /* @__PURE__ */ React.createElement("div", { role: "status", "aria-live": "polite", className: "bigcap", dir: "auto" }, bigCap.text), signOn && /* @__PURE__ */ React.createElement("div", { className: "stage-avatar", id: "av-host-net", "aria-label": "Sign language avatar" }), overlay);
}
function RoomControlsBar(p) {
  const secFlip = /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn", "aria-label": "Flip camera", onClick: p.flipRoomCam }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, "\u{1F504}"), /* @__PURE__ */ React.createElement("span", null, "FLIP"));
  const secSound = /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (!p.roomMuted ? " on" : ""), "aria-label": "Toggle remote sound", "aria-pressed": !p.roomMuted, onClick: p.toggleRoomSound }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.roomMuted ? "\u{1F515}" : "\u{1F50A}"), /* @__PURE__ */ React.createElement("span", null, "SOUND ", p.roomMuted ? "OFF" : "ON"));
  const secView = /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (p.viewMode === "split" ? " on" : ""), "aria-label": "Toggle view mode", "aria-pressed": p.viewMode === "split", onClick: () => p.setViewMode((v) => v === "split" ? "pip" : "split") }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.viewMode === "split" ? "\u{1F532}" : "\u{1F5BC}\uFE0F"), /* @__PURE__ */ React.createElement("span", null, "VIEW ", p.viewMode.toUpperCase()));
  const secFull = /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn", "aria-label": "Fullscreen", onClick: p.toggleStageFullscreen }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, "\u26F6"), /* @__PURE__ */ React.createElement("span", null, "FULL"));
  const secRec = /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (p.recOn ? " rec" : ""), "aria-label": "Record locally", title: "Records YOUR camera (+mic if on) as .webm", onClick: p.toggleRec }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.recOn ? "\u23F9" : "\u23FA"), /* @__PURE__ */ React.createElement("span", null, p.recOn ? "STOP\xB7SAVE" : "REC"));
  return /* @__PURE__ */ React.createElement("div", { className: "row room-controls dock-bar" }, /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (p.roomMicOn ? " on" : ""), "aria-label": "Toggle microphone", "aria-pressed": p.roomMicOn, onClick: p.toggleRoomMic }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.roomMicOn ? "\u{1F3A4}" : "\u{1F507}"), /* @__PURE__ */ React.createElement("span", null, "MIC ", p.roomMicOn ? "ON" : "OFF")), /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (p.roomCamOn ? " on" : ""), "aria-label": "Toggle camera", "aria-pressed": p.roomCamOn, onClick: p.toggleRoomCam }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.roomCamOn ? "\u{1F4F7}" : "\u{1F6AB}"), /* @__PURE__ */ React.createElement("span", null, "CAM ", p.roomCamOn ? "ON" : "OFF")), !p.isMobile && secFlip, !p.isMobile && secSound, !p.isMobile && secView, p.isMobile && /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn only-mob-nav" + (p.chatOpen ? " on" : ""), "aria-label": "Toggle live transcript and chat", "aria-expanded": p.chatOpen, onClick: () => p.setChatOpen((o) => !o) }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, "\u{1F4AC}"), /* @__PURE__ */ React.createElement("span", null, "CHAT"), p.hasUnread ? /* @__PURE__ */ React.createElement("span", { className: "dock-dot", "aria-hidden": "true" }) : null), p.isMobile && /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn only-mob-nav" + (p.moreOpen ? " on" : ""), "aria-label": "More controls", "aria-haspopup": "true", "aria-expanded": p.moreOpen, onClick: () => p.setMoreOpen((o) => !o) }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, "\u22EF"), /* @__PURE__ */ React.createElement("span", null, "MORE")), !p.isMobile && secFull, !p.isMobile && secRec, /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn danger", "aria-label": "Leave room", onClick: p.leaveNet }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, "\u{1F4DE}"), /* @__PURE__ */ React.createElement("span", null, "LEAVE")));
}
function RoomMoreSheet(p) {
  if (!p.open) return null;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "sheet-backdrop", onClick: p.onClose, "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("div", { className: "action-sheet", role: "dialog", "aria-label": "More room controls" }, /* @__PURE__ */ React.createElement("div", { className: "sheet-head" }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim mono-up" }, "MORE CONTROLS"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", "aria-label": "Close more controls", onClick: p.onClose }, "\u2715 CLOSE")), /* @__PURE__ */ React.createElement("div", { className: "sheet-grid" }, /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn", "aria-label": "Flip camera", onClick: () => {
    p.onClose();
    p.flipRoomCam();
  } }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, "\u{1F504}"), /* @__PURE__ */ React.createElement("span", null, "FLIP")), /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (!p.roomMuted ? " on" : ""), "aria-label": "Toggle remote sound", "aria-pressed": !p.roomMuted, onClick: () => {
    p.onClose();
    p.toggleRoomSound();
  } }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.roomMuted ? "\u{1F515}" : "\u{1F50A}"), /* @__PURE__ */ React.createElement("span", null, "SOUND ", p.roomMuted ? "OFF" : "ON")), /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (p.viewMode === "split" ? " on" : ""), "aria-label": "Toggle view mode", "aria-pressed": p.viewMode === "split", onClick: () => {
    p.onClose();
    p.setViewMode((v) => v === "split" ? "pip" : "split");
  } }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.viewMode === "split" ? "\u{1F532}" : "\u{1F5BC}\uFE0F"), /* @__PURE__ */ React.createElement("span", null, "VIEW ", p.viewMode.toUpperCase())), /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (p.srActive ? " rec" : ""), "aria-label": "Speech to text draft", disabled: !p.srSupported, title: p.srSupported ? "Speech becomes a draft \u2014 review before sending" : "Not supported in this browser", onClick: () => {
    p.onClose();
    if (p.srActive) p.stopRoomSR();
    else p.startRoomSR();
  } }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.srActive ? "\u23FA" : "\u{1F399}"), /* @__PURE__ */ React.createElement("span", null, p.srActive ? "LISTENING" : "SPEAK")), /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn", "aria-label": "Fullscreen", onClick: () => {
    p.onClose();
    p.toggleStageFullscreen();
  } }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, "\u26F6"), /* @__PURE__ */ React.createElement("span", null, "FULL")), /* @__PURE__ */ React.createElement("button", { className: "ctrl-btn" + (p.recOn ? " rec" : ""), "aria-label": "Record locally", title: "Records YOUR camera (+mic if on) as .webm", onClick: () => {
    p.onClose();
    p.toggleRec();
  } }, /* @__PURE__ */ React.createElement("span", { className: "ic" }, p.recOn ? "\u23F9" : "\u23FA"), /* @__PURE__ */ React.createElement("span", null, p.recOn ? "STOP\xB7SAVE" : "REC")))));
}
function RoomChatCard(p) {
  return /* @__PURE__ */ React.createElement("div", { className: "card card-pad glow-cyan chat-card-inner", id: "room-chat-card", style: { display: "flex", flexDirection: "column", scrollMarginTop: 70 } }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "ROOM CHAT & INTERPRETER"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-sm btn-ghost", disabled: !p.netCaps.length, onClick: () => p.setNetCaps([]) }, "CLEAR")), /* @__PURE__ */ React.createElement("div", { className: "chat-list", role: "log", "aria-live": "polite" }, p.netCaps.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "empty", style: { textAlign: "center", padding: "24px 10px" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 26, marginBottom: 6 } }, "\u{1F4AC}"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: "#fff" } }, "\u0627\u0644\u062F\u0631\u062F\u0634\u0629 \u0627\u0644\u0645\u0628\u0627\u0634\u0631\u0629 \u062C\u0627\u0647\u0632\u0629"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: "var(--muted)", marginTop: 3 } }, "\u062A\u062D\u062F\u062B \u0628\u0627\u0644\u0635\u0648\u062A \u0623\u0648 \u0627\u0643\u062A\u0628 \u0631\u0633\u0627\u0644\u062A\u0643 \u0623\u0648 \u0634\u0643\u0651\u0644 \u0625\u0634\u0627\u0631\u0627\u062A\u0643 \u0644\u062A\u0638\u0647\u0631 \u0644\u0644\u0637\u0631\u0641\u064A\u0646 \u0641\u0648\u0631\u0627\u064B.")), p.netCaps.map((c, i) => {
    const mine = String(c.id).startsWith("me");
    const sys = c.name === "SYSTEM";
    const isHearing = c.role === "hearing";
    const bubbleCls = "chat-bubble " + (sys ? "sys" : mine ? "me" : "peer" + (isHearing ? " peer-hearing" : ""));
    return /* @__PURE__ */ React.createElement("div", { key: i, className: bubbleCls }, sys ? /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, c.text) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "who" }, /* @__PURE__ */ React.createElement("span", null, isHearing ? "\u{1F5E3}\uFE0F" : "\u270B"), /* @__PURE__ */ React.createElement("span", null, (c.name || "User") + (c.role ? " (" + (c.role === "hearing" ? "\u0633\u0627\u0645\u0639" : "\u0623\u0635\u0645") + ")" : ""))), /* @__PURE__ */ React.createElement("div", { className: "msg", dir: "auto" }, c.kind === "sign" ? "\u{1F91F} " : "\u{1F4AC} ", c.text)));
  })), p.srActive && /* @__PURE__ */ React.createElement("div", { className: "mono t11 cyan", style: { marginTop: 10, display: "flex", gap: 7, alignItems: "center", background: "rgba(244,63,94,.16)", padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(244,63,94,.45)" } }, /* @__PURE__ */ React.createElement("span", { className: "dot dot-red pulse" }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, "\u{1F534} \u062C\u0627\u0631\u064A \u0627\u0644\u0627\u0633\u062A\u0645\u0627\u0639 \u0644\u0635\u0648\u062A\u0643\u2026"), " ", p.srPreview ? "\u201C" + p.srPreview + "\u201D" : "\u062A\u062D\u062F\u062B \u0627\u0644\u0622\u0646\u060C \u0648\u0627\u0636\u063A\u0637 \u0632\u0631 \u0627\u0644\u0625\u064A\u0642\u0627\u0641 \u0641\u0648\u0631 \u0627\u0646\u062A\u0647\u0627\u0626\u0643")), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex sr-lang-row", style: { marginTop: 10, gap: 8, alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim", style: { letterSpacing: ".08em" } }, "\u0644\u063A\u0629 \u0627\u0644\u0635\u0648\u062A \u0648\u0627\u0644\u0625\u0634\u0627\u0631\u0629 \u2022 LANGUAGE"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (p.lang === "ar" ? "chip-cyan" : ""), style: { fontWeight: 700 }, onClick: () => {
    if (p.lang !== "ar") p.setLang("ar");
  } }, "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 AR"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (p.lang === "en" ? "chip-cyan" : ""), style: { fontWeight: 700 }, onClick: () => {
    if (p.lang !== "en") p.setLang("en");
  } }, "ENGLISH EN"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, p.lang === "ar" ? "ar-SA" : "en-US", p.srActive ? " \u2022 LISTENING" : "")), /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "textarea",
      dir: "auto",
      style: { marginTop: 10, fontSize: 16, lineHeight: 1.45 },
      value: p.roomDraft,
      onChange: (e) => p.typeRoomDraft(e.target.value),
      placeholder: p.netRole === "hearing" ? '\u{1F399}\uFE0F \u0627\u0636\u063A\u0637 "\u0627\u0628\u062F\u0623 \u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u0628\u0627\u0644\u0635\u0648\u062A" \u0628\u0627\u0644\u0623\u0633\u0641\u0644\u060C \u0623\u0648 \u0627\u0643\u062A\u0628 \u0631\u0633\u0627\u0644\u062A\u0643 \u0647\u0646\u0627 \u062B\u0645 \u0627\u0636\u063A\u0637 \u0625\u0631\u0633\u0627\u0644\u2026' : "\u270B \u0627\u0643\u062A\u0628 \u0623\u0648 \u0634\u0643\u0651\u0644 \u0625\u0634\u0627\u0631\u0627\u062A\u0643 \u0647\u0646\u0627 \u062B\u0645 \u0627\u0636\u063A\u0637 \u0625\u0631\u0633\u0627\u0644 \u0644\u0646\u0637\u0642\u0647\u0627 \u0648\u0639\u0631\u0636\u0647\u0627 \u0644\u0644\u0637\u0631\u0641 \u0627\u0644\u0622\u062E\u0631\u2026"
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex composer-rec", style: { marginTop: 10, gap: 8 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-rec-main " + (p.srActive ? "btn-danger mic-live" : "btn-primary"), disabled: !p.srSupported, title: p.srSupported ? "\u0627\u0644\u0643\u0644\u0627\u0645 \u064A\u062A\u062D\u0648\u0644 \u0641\u0648\u0631\u0627\u064B \u0644\u0646\u0635 \u0641\u064A \u0627\u0644\u062E\u0627\u0646\u0629 \u0644\u0645\u0631\u0627\u062C\u0639\u062A\u0647 \u0648\u0625\u0631\u0633\u0627\u0644\u0647" : "\u0627\u0644\u0645\u062A\u0635\u0641\u062D \u0644\u0627 \u064A\u062F\u0639\u0645 \u0627\u0644\u062A\u0639\u0631\u0641 \u0639\u0644\u0649 \u0627\u0644\u0635\u0648\u062A", onClick: () => p.srActive ? p.stopRoomSR() : p.startRoomSR() }, p.srActive ? "\u23F9\uFE0F \u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u0648\u0627\u0639\u062A\u0645\u0627\u062F \u0627\u0644\u0646\u0635" : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { className: "btn-label-full" }, "\u{1F399}\uFE0F \u0627\u0628\u062F\u0623 \u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u0628\u0627\u0644\u0635\u0648\u062A (START RECORDING)"), /* @__PURE__ */ React.createElement("span", { className: "btn-label-short" }, "\u{1F399}\uFE0F \u0627\u0628\u062F\u0623 \u0627\u0644\u062A\u0633\u062C\u064A\u0644"))), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", "aria-label": "\u0645\u0633\u062D \u0627\u0644\u062E\u0627\u0646\u0629", disabled: !p.roomDraft, onClick: p.clearRoomDraft }, /* @__PURE__ */ React.createElement("span", { className: "btn-label-full" }, "\u2715 \u0645\u0633\u062D \u0627\u0644\u062E\u0627\u0646\u0629"), /* @__PURE__ */ React.createElement("span", { className: "btn-label-short", "aria-hidden": "true" }, "\u2715"))), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex composer-send", style: { marginTop: 8, gap: 8 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-cyan grow btn-send-main", style: { flex: "1 1 140px", minWidth: 120, fontWeight: 700, padding: "9px 14px" }, disabled: !p.netOn || !p.roomDraft.trim(), onClick: () => p.sendRoomDraft("msg") }, "\u{1F4E4} \u0625\u0631\u0633\u0627\u0644 \u0644\u0644\u062F\u0631\u062F\u0634\u0629 (SEND)"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", style: { flex: "1 1 100px" }, disabled: !p.netOn || !p.roomDraft.trim(), title: "\u0625\u0631\u0633\u0627\u0644 \u0645\u0639 \u0646\u0637\u0642 \u0627\u0644\u0631\u0633\u0627\u0644\u0629 \u0628\u0635\u0648\u062A \u0645\u0633\u0645\u0648\u0639 \u0639\u0646\u062F \u0627\u0644\u0637\u0631\u0641 \u0627\u0644\u0622\u062E\u0631", onClick: () => p.sendRoomDraft("speak") }, "\u{1F50A} \u0625\u0631\u0633\u0627\u0644 \u0645\u0639 \u0646\u0637\u0642"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", style: { flex: "1 1 100px" }, disabled: !p.netOn || !p.roomDraft.trim(), title: "\u0625\u0631\u0633\u0627\u0644 \u0644\u064A\u0642\u0648\u0645 \u0627\u0644\u0623\u0641\u0627\u062A\u0627\u0631 \u0628\u062A\u0645\u062B\u064A\u0644\u0647\u0627 \u0625\u0634\u0627\u0631\u064A\u0627\u064B \u0644\u0644\u0637\u0631\u0641 \u0627\u0644\u0623\u0635\u0645", onClick: () => p.sendRoomDraft("sign") }, "\u{1F9CF} \u0644\u063A\u0629 \u0625\u0634\u0627\u0631\u0629 (Avatar)")), !p.netOn && /* @__PURE__ */ React.createElement("div", { className: "mono t10 dim", style: { marginTop: 8 } }, "\u0627\u0646\u0636\u0645 \u0625\u0644\u0649 \u0627\u0644\u063A\u0631\u0641\u0629 \u0644\u0628\u062F\u0621 \u0627\u0644\u062A\u0648\u0627\u0635\u0644 \u0628\u0627\u0644\u0635\u0648\u062A \u0648\u0627\u0644\u0641\u064A\u062F\u064A\u0648 \u0648\u0627\u0644\u0625\u0634\u0627\u0631\u0629."));
}
function RoomStatusBar(p) {
  return /* @__PURE__ */ React.createElement("div", { className: "row room-status", style: { gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "chip chip-cyan", style: { flex: "0 0 auto" } }, "\u{1F3E0} ", p.netRoom), /* @__PURE__ */ React.createElement("span", { className: "dot " + (p.pcNote ? "dot-amber pulse" : p.peerIds.length ? "dot-green" : p.roomPeers.length ? "dot-green" : "dot-amber pulse"), "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim room-status-txt", style: { minWidth: 0, flex: 1 } }, p.pcNote || (p.peerIds.length ? "Participant video connected" : p.roomPeers.length ? "Participant in room (" + p.roomPeers.length + ")" : "Waiting for participant\u2026")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-sm btn-ghost", style: { flex: "0 0 auto" }, onClick: p.onInvite }, "\u{1F4CB} INVITE"));
}
function ChatSheet({ open, setOpen, caps, unread, children }) {
  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (e.button !== void 0 && e.button !== 0) return;
    drag.current = { y: e.clientY, t: Date.now(), dy: 0 };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {
    }
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    d.dy = d.y - e.clientY;
  };
  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const dt = Math.max(1, Date.now() - d.t);
    const v = (d.dy || 0) / dt;
    if (v > 0.35 || d.dy > 36) setOpen(true);
    else if (v < -0.35 || d.dy < -36) setOpen(false);
  };
  let last = null;
  for (let i = caps.length - 1; i >= 0; i--) {
    const c = caps[i];
    if (c.name !== "SYSTEM" && !String(c.id).startsWith("me")) {
      last = c;
      break;
    }
  }
  return /* @__PURE__ */ React.createElement("section", { className: "chat-sheet" + (open ? " open" : ""), "aria-label": "Live interpreter and chat" }, /* @__PURE__ */ React.createElement("div", { className: "chat-grab", onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag }, /* @__PURE__ */ React.createElement("i", { "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("span", { className: "peek mono t10 dim" }, "\u{1F91F} LIVE TRANSLATION", unread > 0 ? " \u2022 " + unread + " NEW" : ""), /* @__PURE__ */ React.createElement("button", { className: "btn btn-sm btn-ghost", "aria-expanded": open, onClick: () => setOpen((o) => !o) }, /* @__PURE__ */ React.createElement("span", { className: "sheet-toggle-txt-closed" }, "\u25B2 OPEN"), /* @__PURE__ */ React.createElement("span", { className: "sheet-toggle-txt-open" }, "\u25BC CLOSE"))), !open && last && /* @__PURE__ */ React.createElement("div", { className: "chat-peek-msg", dir: "auto" }, (last.name === "SYSTEM" ? "\u2699\uFE0F " : last.kind === "sign" ? "\u{1F91F} " : "\u{1F4AC} ") + last.text), /* @__PURE__ */ React.createElement("div", { className: "chat-sheet-body", hidden: !open }, children));
}
function App() {
  const [apiUrl, setApiUrl] = useState(window.location.origin);
  const [backend, setBackend] = useState("checking");
  const [serverOnline, setServerOnline] = useState(false);
  const [running, setRunning] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [fps, setFps] = useState(0);
  const [bufferLen, setBufferLen] = useState(0);
  const [predicting, setPredicting] = useState(false);
  const [pred, setPred] = useState(null);
  const [sentence, setSentence] = useState("");
  const [lang, setLang] = useState("ar");
  const [log, setLog] = useState("");
  const [tab, setTab] = useState("sign");
  const [debug, setDebug] = useState(false);
  const [builderText, setBuilderText] = useState("");
  const [buildPos, setBuildPos] = useState(0);
  const [quizPhase, setQuizPhase] = useState("config");
  const [quizVer, setQuizVer] = useState(0);
  const [history, setHistory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("slp_history_v1")) || [];
    } catch (e) {
      return [];
    }
  });
  const [stats, setStats] = useState(() => {
    const empty = { commits: 0, confSum: 0, confN: 0, by: {}, startTs: Date.now() };
    try {
      const v2 = JSON.parse(localStorage.getItem("slp_stats_v2"));
      if (v2 && typeof v2 === "object") return { ...empty, ...v2, by: v2.by || {} };
      const v1 = JSON.parse(localStorage.getItem("slp_stats_v1"));
      if (v1 && typeof v1 === "object") {
        return { ...empty, commits: v1.commits || 0, confSum: v1.confSum || 0, confN: v1.confN || 0, startTs: v1.startTs || Date.now(), by: {} };
      }
      return empty;
    } catch (e) {
      return empty;
    }
  });
  const [savedFlash, setSavedFlash] = useState(0);
  const [mic, setMic] = useState(false);
  const [micMsg, setMicMsg] = useState("");
  const [modelInfo, setModelInfo] = useState(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [confGate, setConfGate] = useState(0.6);
  const [raw, setRaw] = useState([]);
  const [nowTs, setNowTs] = useState(Date.now());
  const [quizConfig, setQuizConfig] = useState({ lang: "ar", mode: "quiz", count: 8, time: 10, src: "all" });
  const [speed, setSpeed] = useState("fast");
  const [avPlaying, setAvPlaying] = useState(false);
  const [avCur, setAvCur] = useState(null);
  const [avHold, setAvHold] = useState(650);
  const [avAuto, setAvAuto] = useState(false);
  const [netRoom, setNetRoom] = useState("ROOM1");
  const [netOn, setNetOn] = useState(false);
  const [peerIds, setPeerIds] = useState([]);
  const [roomPeers, setRoomPeers] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreamsMap, setRemoteStreamsMap] = useState({});
  const [webrtcConnectedMap, setWebrtcConnectedMap] = useState({});
  const [remoteFrame, setRemoteFrame] = useState(null);
  const [remotePeerInfo, setRemotePeerInfo] = useState({ name: "", role: "", id: "" });
  const [netCaps, setNetCaps] = useState([]);
  const [roomDraft, setRoomDraft] = useState("");
  const [srActive, setSrActive] = useState(false);
  const [srPreview, setSrPreview] = useState("");
  const [roomCamOn, setRoomCamOn] = useState(true);
  const [roomMicOn, setRoomMicOn] = useState(false);
  const [pcNote, setPcNote] = useState("");
  const [netRole, setNetRole] = useState(() => {
    try {
      return localStorage.getItem("slp_role") === "hearing" ? "hearing" : "deaf";
    } catch (e) {
      return "deaf";
    }
  });
  const [netName, setNetName] = useState(() => {
    try {
      return localStorage.getItem("slp_name") || "";
    } catch (e) {
      return "";
    }
  });
  const [roomMuted, setRoomMuted] = useState(false);
  const [viewMode, setViewMode] = useState(() => {
    try {
      return window.innerWidth <= 640 ? "pip" : "split";
    } catch (e) {
      return "split";
    }
  });
  const [connecting, setConnecting] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(() => {
    try {
      return localStorage.getItem("slp_autospeak") !== null ? localStorage.getItem("slp_autospeak") === "1" : (() => {
        try {
          return localStorage.getItem("slp_role") === "hearing";
        } catch (e) {
          return false;
        }
      })();
    } catch (e) {
      return false;
    }
  });
  const [bigCap, setBigCap] = useState(null);
  const [roomSignOn, setRoomSignOn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [avatarHost, setAvatarHost] = useState(null);
  const avatarKeeperRef = useRef(null);
  const [avatarKeeper, setAvatarKeeper] = useState(null);
  const [autoSpace, setAutoSpace] = useState(() => {
    try {
      return localStorage.getItem("slp_autospace") !== "0";
    } catch (e) {
      return true;
    }
  });
  const [autoWord, setAutoWord] = useState(() => {
    try {
      return localStorage.getItem("slp_autoword") === "1";
    } catch (e) {
      return false;
    }
  });
  const [smoothConf, setSmoothConf] = useState(() => {
    try {
      return localStorage.getItem("slp_smooth") !== "0";
    } catch (e) {
      return true;
    }
  });
  const [netPin, setNetPin] = useState("");
  const [recOn, setRecOn] = useState(false);
  const [peerNames, setPeerNames] = useState({});
  const [turnUrl, setTurnUrl] = useState(() => {
    try {
      return localStorage.getItem("slp_turn_url") || "";
    } catch (e) {
      return "";
    }
  });
  const [turnUser, setTurnUser] = useState(() => {
    try {
      return localStorage.getItem("slp_turn_user") || "";
    } catch (e) {
      return "";
    }
  });
  const [turnCred, setTurnCred] = useState(() => {
    try {
      return localStorage.getItem("slp_turn_cred") || "";
    } catch (e) {
      return "";
    }
  });
  const [isMobile, setIsMobile] = useState(() => {
    try {
      return (window.innerWidth || 1280) <= 767;
    } catch (e) {
      return false;
    }
  });
  const [navOpen, setNavOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeen, setChatSeen] = useState(0);
  const [upFile, setUpFile] = useState(null);
  const [upUrl, setUpUrl] = useState(null);
  const [upDuration, setUpDuration] = useState(0);
  const [upCurrentTime, setUpCurrentTime] = useState(0);
  const [upPlaying, setUpPlaying] = useState(false);
  const [upPlaybackRate, setUpPlaybackRate] = useState(1);
  const [upDragOver, setUpDragOver] = useState(false);
  const [upLog, setUpLog] = useState("");
  const [upFps, setUpFps] = useState(0);
  const [upBufferLen, setUpBufferLen] = useState(0);
  const [upPred, setUpPred] = useState(null);
  const [upSentence, setUpSentence] = useState("");
  const [upTracking, setUpTracking] = useState(false);
  const [upTimeline, setUpTimeline] = useState([]);
  const [upProcessing, setUpProcessing] = useState(false);
  const [upMirror, setUpMirror] = useState("auto");
  const upVideoRef = useRef(null);
  const upCanvasRef = useRef(null);
  const upFileInputRef = useRef(null);
  const upHandsRef = useRef(null);
  const upBufferRef = useRef([]);
  const upStabRef = useRef(newStab());
  const upPredictingRef = useRef(false);
  const upFpsRef = useRef({ last: performance.now(), frames: 0 });
  const upFrameRef = useRef(0);
  const upEmaRef = useRef({});
  const upLastTrackRef = useRef(false);
  const upLastBufRef = useRef(-1);
  const upHandLostAtRef = useRef(0);
  const upRecentPredsRef = useRef([]);
  const upLastStdFeatsRef = useRef([]);
  const upRafRef = useRef(null);
  const upRvfcIdRef = useRef(null);
  const upSeekRef = useRef(null);
  const upGenerationRef = useRef(0);
  const upSendBusyRef = useRef(false);
  const upMirrorRef = useRef("auto");
  const upMotionRef = useRef({ prev: null, value: 0 });
  const upTravelRef = useRef({ n: 0, flushed: false });
  const upSendErrorsRef = useRef(0);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const handsRef = useRef(null);
  const rafRef = useRef(null);
  const streamCanvasRef = useRef(null);
  const lastSendFrameRef = useRef(0);
  const bufferRef = useRef([]);
  const stabRef = useRef(newStab());
  const frameRef = useRef(0);
  const fpsRef = useRef({ last: performance.now(), frames: 0 });
  const lastTrackRef = useRef(false);
  const lastBufRef = useRef(-1);
  const langRef = useRef("ar");
  const speedNowRef = useRef("fast");
  const backendRef = useRef("checking");
  const predictingRef = useRef(false);
  const flipWinRef = useRef(1);
  const predShowRef = useRef({ v: false, t: 0 });
  const predShownRef = useRef({ l: null, c: -1 });
  const showPredicting = useCallback((v) => {
    const s = predShowRef.current;
    const now = performance.now();
    if (s.v === v || now - s.t < 400) return;
    s.v = v;
    s.t = now;
    setPredicting(v);
  }, []);
  const apiUrlRef = useRef(window.location.origin);
  const buildActiveRef = useRef(false);
  const buildPosRef = useRef(0);
  const builderTokensRef = useRef([]);
  const quizRef = useRef(null);
  const quizPhaseRef = useRef("config");
  const quizPrevRef = useRef(null);
  const sessionStartRef = useRef(Date.now());
  const sessionRef = useRef({ commits: 0, confSum: 0, confN: 0, by: {} });
  const lastSaveRef = useRef("");
  const recRef = useRef(null);
  const micWantRef = useRef(false);
  const micGenRef = useRef(0);
  const micRestartTimerRef = useRef(0);
  const builderTextRef = useRef("");
  const builderVoiceBaseRef = useRef("");
  const builderVoiceFinalRef = useRef("");
  const avAutoTimerRef = useRef(0);
  const lastFeatsRef = useRef([]);
  const lastStdFeatsRef = useRef([]);
  const recentPredsRef = useRef([]);
  const avatarApiRef = useRef({});
  const avCancelRef = useRef(false);
  const avHoldRef = useRef(650);
  const avAutoRef = useRef(false);
  const avPlayingRef = useRef(false);
  const avSleepTimerRef = useRef(0);
  const avSleepResolveRef = useRef(null);
  const netOnRef = useRef(false);
  const wsRef = useRef(null);
  const srWantedRef = useRef(false);
  const pcsRef = useRef({});
  const dcsRef = useRef({});
  const remoteStreamsRef = useRef({});
  const webrtcConnectedRef = useRef({});
  const pendingCandidatesRef = useRef({});
  const micStreamRef = useRef(null);
  const connectingRef = useRef(false);
  const autoSpeakRef = useRef(autoSpeak);
  const autoSpeakTouchedRef = useRef((() => {
    try {
      return localStorage.getItem("slp_autospeak") !== null;
    } catch (e) {
      return false;
    }
  })());
  const bigCapTimerRef = useRef(0);
  const roomSignTimerRef = useRef(0);
  const roomSRRef = useRef(null);
  const srRestartTimerRef = useRef(0);
  const srGenRef = useRef(0);
  const srFinalRef = useRef("");
  const baseDraftRef = useRef("");
  const draftSignRef = useRef(false);
  const tabRef = useRef("sign");
  const stageWrapRef = useRef(null);
  const selfRef = useRef("");
  const roomMutedRef = useRef(false);
  const remoteVideoElRef = useRef(null);
  const seenCapRef = useRef(/* @__PURE__ */ new Map());
  const smoothRef = useRef(true);
  const emaRef = useRef({});
  const handLostRef = useRef(0);
  const motionRef = useRef({ prev: null, value: 0 });
  const travelRef = useRef({ n: 0, flushed: false });
  const handComplexityRef = useRef(1);
  const lowFpsRef = useRef(0);
  const autoSpaceRef = useRef(true);
  const autoWordRef = useRef(false);
  const recRef2 = useRef(null);
  const recChunksRef = useRef([]);
  const recMimeRef = useRef("");
  const recSaveRef = useRef(true);
  const camFacingRef = useRef("user");
  const reconAttemptsRef = useRef(0);
  const reconnectWantedRef = useRef(false);
  const reconnectTimerRef = useRef(0);
  const hbTimerRef = useRef(0);
  const wdTimerRef = useRef(0);
  const lastPongRef = useRef(0);
  const peerNamesRef = useRef({});
  const netNameRef = useRef(netName);
  const netRoleRef = useRef(netRole);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);
  useEffect(() => {
    emaRef.current = {};
    upEmaRef.current = {};
    recentPredsRef.current = [];
    upRecentPredsRef.current = [];
    stabRef.current = newStab();
    upStabRef.current = newStab();
    motionRef.current = { prev: null, value: 0 };
    upMotionRef.current = { prev: null, value: 0 };
    travelRef.current = { n: 0, flushed: false };
    upTravelRef.current = { n: 0, flushed: false };
  }, [lang]);
  useEffect(() => {
    speedNowRef.current = speed;
  }, [speed]);
  useEffect(() => {
    upMirrorRef.current = upMirror;
  }, [upMirror]);
  useEffect(() => {
    backendRef.current = backend;
  }, [backend]);
  useEffect(() => {
    apiUrlRef.current = apiUrl;
  }, [apiUrl]);
  useEffect(() => {
    quizPhaseRef.current = quizPhase;
  }, [quizPhase]);
  useEffect(() => {
    buildActiveRef.current = tab === "build" && running;
  }, [tab, running]);
  useEffect(() => {
    buildPosRef.current = buildPos;
  }, [buildPos]);
  useEffect(() => {
    netOnRef.current = netOn;
  }, [netOn]);
  useEffect(() => {
    netNameRef.current = netName;
  }, [netName]);
  useEffect(() => {
    netRoleRef.current = netRole;
  }, [netRole]);
  useEffect(() => {
    try {
      localStorage.setItem("slp_history_v1", JSON.stringify(history));
    } catch (e) {
    }
  }, [history]);
  useEffect(() => {
    try {
      localStorage.setItem("slp_role", netRole);
      localStorage.setItem("slp_name", netName);
    } catch (e) {
    }
  }, [netRole, netName]);
  useEffect(() => {
    try {
      localStorage.setItem("slp_turn_url", turnUrl);
      localStorage.setItem("slp_turn_user", turnUser);
      localStorage.setItem("slp_turn_cred", turnCred);
    } catch (e) {
    }
  }, [turnUrl, turnUser, turnCred]);
  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
  }, [autoSpeak]);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    builderTextRef.current = builderText;
  }, [builderText]);
  useEffect(() => {
    roomMutedRef.current = roomMuted;
  }, [roomMuted]);
  useEffect(() => {
    smoothRef.current = smoothConf;
  }, [smoothConf]);
  useEffect(() => {
    autoSpaceRef.current = autoSpace;
  }, [autoSpace]);
  useEffect(() => {
    autoWordRef.current = autoWord;
  }, [autoWord]);
  useEffect(() => {
    try {
      localStorage.setItem("slp_autospace", autoSpace ? "1" : "0");
    } catch (e) {
    }
  }, [autoSpace]);
  useEffect(() => {
    try {
      localStorage.setItem("slp_autoword", autoWord ? "1" : "0");
    } catch (e) {
    }
  }, [autoWord]);
  useEffect(() => {
    try {
      localStorage.setItem("slp_smooth", smoothConf ? "1" : "0");
    } catch (e) {
    }
  }, [smoothConf]);
  const handleRemoteAutoplayBlocked = useCallback(() => {
    roomMutedRef.current = true;
    setRoomMuted(true);
  }, []);
  const toggleRoomSound = useCallback(() => {
    const nextMuted = !roomMutedRef.current;
    const video = remoteVideoElRef.current;
    roomMutedRef.current = nextMuted;
    setRoomMuted(nextMuted);
    if (!video) return;
    video.muted = nextMuted;
    const playAttempt = video.play();
    if (playAttempt && typeof playAttempt.catch === "function") {
      playAttempt.catch(() => {
        video.muted = true;
        roomMutedRef.current = true;
        setRoomMuted(true);
      });
    }
  }, []);
  useEffect(() => {
    try {
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    } catch (e) {
    }
  }, [lang]);
  useEffect(() => {
    if (avatarKeeper === null) return;
    const id = tab === "build" ? "av-host-build" : tab === "alpha" ? "av-host-alpha" : tab === "net" ? "av-host-net" : null;
    const el = id ? document.getElementById(id) : null;
    setAvatarHost(el);
  }, [tab, avatarKeeper, roomSignOn]);
  useEffect(() => {
    setAvatarKeeper(avatarKeeperRef.current);
  }, []);
  useEffect(() => {
    try {
      const r = normalizeRoomCode(new URLSearchParams(location.search).get("room"));
      if (r) {
        setNetRoom(r);
        setTab("net");
      }
    } catch (e) {
    }
  }, []);
  useEffect(() => () => {
    clearTimeout(bigCapTimerRef.current);
  }, []);
  useEffect(() => {
    if (!netOn) return;
    let lock = null;
    const acquire = async () => {
      try {
        if (navigator.wakeLock && !lock) {
          lock = await navigator.wakeLock.request("screen");
          lock.addEventListener("release", () => {
            lock = null;
          });
        }
      } catch (e) {
      }
    };
    acquire();
    const onVis = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      try {
        if (lock) lock.release();
      } catch (e) {
      }
      lock = null;
    };
  }, [netOn]);
  const navCloseRef = useRef(null);
  const settingsCloseRef = useRef(null);
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      if (settingsCloseRef.current && settingsCloseRef.current.focus) settingsCloseRef.current.focus();
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
    };
  }, [showSettings]);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          setIsMobile((window.innerWidth || 1280) <= 767);
        } catch (e) {
        }
      });
    };
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("resize", on);
      cancelAnimationFrame(raf);
    };
  }, []);
  useEffect(() => {
    if (!navOpen && !moreOpen && !chatOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setNavOpen(false);
        setMoreOpen(false);
        setChatOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen, moreOpen, chatOpen]);
  useEffect(() => {
    if (!(navOpen || chatOpen)) return;
    const prevOverflow = document.body.style.overflow;
    if (prevOverflow !== "hidden") document.body.style.overflow = "hidden";
    const t = setTimeout(() => {
      if (navCloseRef.current && navCloseRef.current.focus) navCloseRef.current.focus();
    }, 0);
    return () => {
      if (prevOverflow !== "hidden") document.body.style.overflow = prevOverflow;
      clearTimeout(t);
    };
  }, [navOpen, chatOpen]);
  useEffect(() => {
    if (chatOpen) setChatSeen(netCaps.length);
  }, [chatOpen, netCaps.length]);
  useEffect(() => {
    if (!netOn) {
      setChatOpen(false);
      setMoreOpen(false);
    }
  }, [netOn]);
  useEffect(() => {
    const id = setInterval(() => {
      if (!autoSpaceRef.current || !running) return;
      if (tabRef.current === "net" || quizPhaseRef.current === "run") return;
      const lost = handLostRef.current;
      if (!lost || performance.now() - lost < 900) return;
      handLostRef.current = 0;
      setSentence((s) => !s || /\s$/.test(s) ? s : s + " ");
    }, 300);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => {
    if (!autoWordRef.current || !sentence) return;
    if (/\s$/.test(sentence)) return;
    const last = sentence.trim().split(/\s+/).pop() || "";
    if (!last) return;
    const dict = lang === "ar" ? AR_WORDS : EN_WORDS;
    const key = lang === "ar" ? normAR(last) : last.toLowerCase().replace(/\s/g, "");
    const hit = dict.some((wd) => {
      const nw = lang === "ar" ? normAR(wd.w) : wd.w.toLowerCase().replace(/\s/g, "");
      return nw === key && nw.length > 1;
    });
    if (hit) setSentence((s) => /\s$/.test(s) ? s : s + " ");
  }, [sentence, lang]);
  useEffect(() => {
    try {
      localStorage.setItem("slp_stats_v2", JSON.stringify(stats));
    } catch (e) {
    }
  }, [stats]);
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 1e3);
    return () => clearInterval(id);
  }, []);
  const checkHealth = useCallback(async () => {
    setBackend("checking");
    backendRef.current = "checking";
    try {
      const h = await fetch(apiUrlRef.current + "/health", { method: "GET" });
      if (h.ok) {
        setServerOnline(true);
        let ready = true;
        try {
          const info = await h.json();
          const loaded = langRef.current === "ar" ? info.ar_loaded : info.en_loaded;
          if (typeof loaded === "boolean") ready = loaded;
        } catch (e) {
        }
        const st = ready ? "online" : "offline";
        setBackend(st);
        backendRef.current = st;
        return;
      }
      const r = await fetch(apiUrlRef.current + "/", { method: "GET" });
      setServerOnline(r.ok);
      setBackend("offline");
      backendRef.current = "offline";
    } catch (e) {
      try {
        const o = await fetch(apiUrlRef.current + "/predict", { method: "OPTIONS" });
        setServerOnline(o.ok);
        setBackend("offline");
        backendRef.current = "offline";
      } catch (e2) {
        setServerOnline(false);
        setBackend("offline");
        backendRef.current = "offline";
      }
    }
  }, []);
  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, 8e3);
    return () => clearInterval(id);
  }, [checkHealth]);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(apiUrlRef.current + "/models");
        if (r.ok) setModelInfo(await r.json());
      } catch (e) {
      }
    })();
  }, [apiUrl]);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(apiUrlRef.current + "/api/ice-servers");
        if (r.ok && !dead) {
          const d = await r.json();
          if (d && Array.isArray(d.iceServers) && d.iceServers.length) ICE_CFG.current = d;
        }
      } catch (e) {
      }
    })();
    return () => {
      dead = true;
    };
  }, [apiUrl]);
  const recordStat = useCallback((p) => {
    if (isNonLetter(p.letter)) return;
    const k = statKey(p.lang || langRef.current, p.class_id);
    const c0 = sessionRef.current.by[k] || { c: 0, conf: 0, n: 0 };
    sessionRef.current.by[k] = { c: c0.c + 1, conf: c0.conf + p.confidence, n: c0.n + 1 };
    sessionRef.current.commits++;
    sessionRef.current.confSum += p.confidence;
    sessionRef.current.confN++;
    setStats((prev) => {
      const by = { ...prev.by || {} };
      const c = by[k] || { c: 0, conf: 0, n: 0 };
      by[k] = { c: c.c + 1, conf: c.conf + p.confidence, n: c.n + 1 };
      return { ...prev, commits: (prev.commits || 0) + 1, confSum: (prev.confSum || 0) + p.confidence, confN: (prev.confN || 0) + 1, by };
    });
  }, []);
  const armForExpected = useCallback((q2) => {
    if (!q2 || q2.pos >= q2.goal.length) return;
    const table = q2.lang === "ar" ? AR_CLASSES : EN_CLASSES;
    armLatch(stabRef.current, table[q2.goal[q2.pos]]);
  }, []);
  const feedQuiz = useCallback((p) => {
    const q2 = quizRef.current;
    if (!q2 || quizPhaseRef.current !== "run") return;
    const expected = q2.goal[q2.pos];
    if (expected === void 0) return;
    if (p.class_id === expected) {
      q2.results.push({ cls: expected, ok: true, ms: performance.now() - q2.qStart, conf: p.confidence });
      q2.pos++;
      q2.okCount++;
      q2.lastResult = "ok";
      q2.missCls = null;
      q2.qStart = performance.now();
      q2.remaining = q2.timeLimit;
      if (q2.pos >= q2.goal.length) {
        quizPhaseRef.current = "done";
        setQuizPhase("done");
      } else armForExpected(q2);
    } else {
      q2.lastResult = "miss";
      q2.missCls = p.class_id;
      q2.missAt = performance.now();
    }
    setQuizVer((v) => v + 1);
  }, [armForExpected]);
  const applyCommit = useCallback((p) => {
    const L = p.letter || "";
    const isSpace = L === "SPACE" || L === " " || L === "space";
    const isDel = L === "DEL" || L === "del";
    setSentence((s) => {
      if (isSpace) return s + " ";
      if (isDel) return s.slice(0, -1);
      return s + L;
    });
    if (netOnRef.current && tabRef.current === "net") {
      draftSignRef.current = true;
      setRoomDraft((d) => isSpace ? d + " " : isDel ? d.slice(0, -1) : d + L);
    }
    recordStat(p);
    if (buildActiveRef.current && !avPlayingRef.current) {
      const toks = builderTokensRef.current;
      const idx = nextSignIndex(toks, buildPosRef.current);
      if (toks && idx < toks.length && toks[idx].type === "CLA" && toks[idx].cls === p.class_id) {
        const next = nextSignIndex(toks, idx + 1);
        buildPosRef.current = next;
        setBuildPos(next);
      }
    }
    feedQuiz(p);
  }, [recordStat, feedQuiz]);
  const commit = useCallback((p) => {
    const st = stabRef.current;
    const sp = SPEED_PRESETS[speedNowRef.current] || SPEED_PRESETS.fast;
    const roomFast = netOnRef.current && tabRef.current === "net" && netRoleRef.current === "deaf";
    const stab = roomFast ? ROOM_SIGN_STAB : sp.stab;
    const gapv = roomFast ? ROOM_SIGN_GAP : sp.gap;
    const relNeed = roomFast ? ROOM_SIGN_RELEASE : releaseFrames(sp);
    if (p.confidence < confGate) {
      st.rel++;
      if (p.confidence < confGate * RELEASE_CONF_RATIO) addRelease(st, relNeed);
      if (st.rel >= gapv) {
        st.cur = null;
        st.count = 0;
      }
      return;
    }
    st.rel = 0;
    if (motionRef.current.value > MOTION_SETTLED) {
      addRelease(st, relNeed);
      st.cur = null;
      st.count = 0;
      return;
    }
    if (holdsLatch(st, p.letter)) st.away = 0;
    if (p.letter === st.last && !st.armed) {
      st.cur = null;
      st.count = 0;
      return;
    }
    if (p.letter === st.cur) {
      st.count++;
    } else {
      st.cur = p.letter;
      st.count = 1;
    }
    if (st.count < framesNeeded(stab, p.letter === st.last)) return;
    const partners = (langRef.current === "ar" ? CONFUSABLE_AR : CONFUSABLE_EN)[p.letter];
    if (partners && partners.length) {
      const arb = langRef.current === "ar" ? JHK_AR[p.letter] ? jhkArbitrate : null : p.letter === "A" || p.letter === "T" ? atArbitrate : null;
      if (arb) {
        const torn = Array.isArray(p.top3) && p.top3.some((t) => partners.indexOf(t.letter) >= 0);
        if (torn) {
          const g = arb(lastStdFeatsRef.current);
          if (g && g !== p.letter && partners.indexOf(g) >= 0) {
            if (g === st.last && !st.armed) {
              st.cur = null;
              st.count = 0;
              return;
            }
            const cls = langRef.current === "ar" ? AR_UNI[g] : g.charCodeAt(0) - 65;
            if (typeof cls === "number") {
              latch(st, g);
              emaRef.current = {};
              applyCommit({ letter: g, name: nameForCls(cls, langRef.current), confidence: p.confidence, class_id: cls, top3: p.top3, lang: langRef.current });
              return;
            }
          }
        }
      }
      const { sX, sP } = pairMass(recentPredsRef.current, p.letter, partners);
      for (const y of partners) {
        if (sP[y] > sX && sP[y] - sX > 0.25) return;
      }
    }
    latch(st, p.letter);
    emaRef.current = {};
    applyCommit({ ...p, lang: langRef.current });
  }, [applyCommit, confGate]);
  const feedPrediction = useCallback((p) => {
    const shownL = p ? p.letter : null;
    const shownC = p ? Math.round((p.confidence || 0) * 100) : -1;
    const s = predShownRef.current;
    if (s.l !== shownL || s.c !== shownC) {
      s.l = shownL;
      s.c = shownC;
      setPred(p);
    }
    lastFeatsRef.current = [];
    if (p && p.heuristic) return;
    recentPredsRef.current.push(p);
    if (recentPredsRef.current.length > 6) recentPredsRef.current.shift();
    commit(p);
  }, [commit]);
  const predictOne = useCallback(async (seq, isRetry) => {
    if (predictingRef.current) return;
    predictingRef.current = true;
    showPredicting(true);
    let p = null;
    const mirrored = isRetry ? flipWinRef.current !== -1 : flipWinRef.current === -1;
    const useSeq = mirrored ? mirrorSeq(seq) : seq;
    let maxVal = 0;
    for (const f of useSeq) {
      for (const v of f) {
        const a = v < 0 ? -v : v;
        if (a > maxVal) maxVal = a;
      }
    }
    const payload = maxVal > 0 ? useSeq.map((f) => f.map((v) => Math.round(v / maxVal * 1e4) / 1e4)) : useSeq;
    try {
      const res = await fetch(apiUrlRef.current + "/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequence: payload, language: langRef.current })
      });
      if (!res.ok) throw new Error("backend error");
      const d = await res.json();
      if (d.status === "warming_up") {
        backendRef.current = "online";
        setBackend("online");
        predictingRef.current = false;
        showPredicting(false);
        return;
      }
      p = {
        letter: d.letter || "?",
        name: d.english_name || d.name || d.letter || "",
        confidence: typeof d.confidence === "number" ? d.confidence : 0.9,
        class_id: typeof d.class_id === "number" ? d.class_id : 0,
        top3: Array.isArray(d.top3) ? d.top3 : []
      };
      if (smoothRef.current && typeof p.confidence === "number") {
        const prev = emaRef.current[p.class_id];
        const c = typeof prev === "number" ? 0.6 * p.confidence + 0.4 * prev : p.confidence;
        emaRef.current[p.class_id] = c;
        p.confidence = c;
      }
      let cid;
      if (langRef.current === "ar") {
        cid = p.letter === "DEL" ? 31 : p.letter === "SPACE" ? 32 : AR_UNI[p.letter];
      } else {
        cid = p.letter === "DEL" ? 26 : p.letter === "SPACE" ? 27 : p.letter && p.letter.length === 1 && p.letter >= "A" && p.letter <= "Z" ? p.letter.charCodeAt(0) - 65 : void 0;
      }
      if (typeof cid === "number") p.class_id = cid;
      backendRef.current = "online";
      setBackend("online");
    } catch (e) {
      if (backendRef.current !== "offline") {
        backendRef.current = "offline";
        setBackend("offline");
      }
      predictingRef.current = false;
      showPredicting(false);
      return;
    }
    predictingRef.current = false;
    showPredicting(false);
    if (p && p.confidence >= confGate) flipWinRef.current = mirrored ? -1 : 1;
    if (!isRetry && p && p.confidence < confGate) return predictOne(seq, true);
    feedPrediction(p);
  }, [feedPrediction, confGate]);
  const onResults = useCallback(async (r) => {
    const video = videoRef.current, cvs = canvasRef.current;
    if (!video) return;
    const ctx = cvs && cvs.getContext ? cvs.getContext("2d") : null;
    if (ctx) {
      cvs.width = video.videoWidth || 640;
      cvs.height = video.videoHeight || 480;
      ctx.save();
      ctx.clearRect(0, 0, cvs.width, cvs.height);
      ctx.translate(cvs.width, 0);
      ctx.scale(-1, 1);
    }
    const fr = frameRef.current++;
    if (r.multiHandLandmarks && r.multiHandLandmarks.length) {
      if (!lastTrackRef.current) {
        lastTrackRef.current = true;
        setTracking(true);
      }
      handLostRef.current = 0;
      const lm = r.multiHandLandmarks[0];
      if (ctx && window.drawConnectors && window.drawLandmarks) {
        window.drawConnectors(ctx, lm, window.HAND_CONNECTIONS, { color: "#1E7FE0", lineWidth: 2 });
        window.drawLandmarks(ctx, lm, { color: "#00D4FF", lineWidth: 1, radius: 3 });
        window.drawLandmarks(ctx, lm, { color: "rgba(0,212,255,0.35)", lineWidth: 6, radius: 6 });
      }
      let flip = false;
      const mh = r.multiHandedness && r.multiHandedness[0];
      if (mh && mh.classification && mh.classification[0]) {
        flip = mh.classification[0].label === "Left";
      } else {
        flip = lm[5].x < lm[17].x;
      }
      const feats = [];
      for (const L of lm) {
        const mx = flip ? 1 - L.x : L.x;
        feats.push(mx, L.y, L.z);
      }
      motionRef.current.value = motionRef.current.prev ? featMotion(feats, motionRef.current.prev) : 1;
      motionRef.current.prev = feats;
      lastFeatsRef.current = feats;
      lastStdFeatsRef.current = feats;
      const travel = travelRef.current;
      if (motionRef.current.value > MOTION_SETTLED) {
        travel.n++;
        if (travel.n >= SIGN_BOUNDARY_FRAMES && !travel.flushed) {
          travel.flushed = true;
          if (bufferRef.current.length) {
            bufferRef.current = [];
            lastBufRef.current = -1;
            setBufferLen(0);
          }
          emaRef.current = {};
          recentPredsRef.current = [];
        }
      } else {
        travel.n = 0;
        travel.flushed = false;
      }
      const travelling = travel.n >= SIGN_BOUNDARY_FRAMES;
      if (!travelling) {
        bufferRef.current.push(feats);
        if (bufferRef.current.length > WINDOW) bufferRef.current.shift();
      }
      if (fr % 2 === 0 && lastBufRef.current !== bufferRef.current.length) {
        lastBufRef.current = bufferRef.current.length;
        setBufferLen(bufferRef.current.length);
      }
      if (fr % 30 === 0) setRaw(feats.slice(0, 63));
      const n = performance.now();
      fpsRef.current.frames++;
      if (n - fpsRef.current.last >= 1e3) {
        const f = fpsRef.current.frames;
        setFps(f);
        fpsRef.current.frames = 0;
        fpsRef.current.last = n;
        if (handComplexityRef.current === 1) {
          if (f > 0 && f < LOW_FPS_LIMIT) lowFpsRef.current++;
          else lowFpsRef.current = 0;
          if (lowFpsRef.current >= LOW_FPS_STRIKES) {
            handComplexityRef.current = 0;
            try {
              if (handsRef.current) handsRef.current.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
            } catch (e) {
            }
          }
        }
      }
      const roomFast = netOnRef.current && tabRef.current === "net" && netRoleRef.current === "deaf";
      const minFill = roomFast ? ROOM_SIGN_MIN_FILL : MIN_FILL;
      if (!travelling && bufferRef.current.length >= minFill) {
        const st = backendRef.current;
        if (st === "online") {
          const seq = [...bufferRef.current];
          while (seq.length < WINDOW) {
            seq.push(seq[seq.length - 1]);
          }
          predictOne(seq);
        } else if (st !== "online" && fr % (roomFast ? ROOM_SIGN_HEURISTIC_STRIDE : 4) === 0) {
          feedPrediction(heuristic(feats, langRef.current, confGate));
        }
      }
    } else {
      if (lastTrackRef.current) {
        lastTrackRef.current = false;
        setTracking(false);
      }
      if (!handLostRef.current) handLostRef.current = performance.now();
      const lostMs = performance.now() - handLostRef.current;
      stabRef.current.cur = null;
      stabRef.current.count = 0;
      addRelease(stabRef.current, releaseFrames(SPEED_PRESETS[speedNowRef.current] || SPEED_PRESETS.fast));
      motionRef.current.prev = null;
      motionRef.current.value = 0;
      travelRef.current = { n: 0, flushed: false };
      lastFeatsRef.current = [];
      if (lostMs > 350) {
        stabRef.current = newStab();
        emaRef.current = {};
        recentPredsRef.current = [];
        if (bufferRef.current.length) {
          bufferRef.current = [];
          lastBufRef.current = -1;
          setBufferLen(0);
        }
      }
    }
    if (ctx) ctx.restore();
  }, [predictOne, feedPrediction]);
  const startCamera = useCallback(async () => {
    try {
      await loadMediaPipe();
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      } catch (camErr) {
        try {
          const c = document.createElement("canvas");
          c.width = 640;
          c.height = 480;
          const cx = c.getContext("2d");
          cx.fillStyle = "#0f172a";
          cx.fillRect(0, 0, 640, 480);
          cx.fillStyle = "#00d4ff";
          cx.font = "bold 22px monospace";
          cx.fillText("Camera Active (Tab 2)", 170, 240);
          stream = c.captureStream ? c.captureStream(15) : null;
        } catch (ce) {
        }
      }
      streamRef.current = stream;
      setLocalStream(stream);
      const video = videoRef.current;
      if (video && stream) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch (e) {
        }
      }
      const Hands = window.Hands;
      if (Hands) {
        const hands = new Hands({ locateFile: (f) => "https://cdn.jsdelivr.net/npm/@mediapipe/hands/" + f });
        hands.setOptions({ maxNumHands: 1, modelComplexity: handComplexityRef.current, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        hands.onResults(onResults);
        handsRef.current = hands;
        let aiInFlight = false;
        let lastAiTime = 0;
        const tick = () => {
          const v = videoRef.current;
          const videoTrack = streamRef.current && streamRef.current.getVideoTracks()[0];
          if (v && v.readyState >= 2 && videoTrack && videoTrack.enabled) {
            const now = performance.now();
            const speakerRoom = netOnRef.current && tabRef.current === "net" && netRoleRef.current === "hearing";
            if (!speakerRoom && handsRef.current && !aiInFlight && now - lastAiTime > 36) {
              lastAiTime = now;
              aiInFlight = true;
              handsRef.current.send({ image: v }).catch(() => {
              }).finally(() => {
                aiInFlight = false;
              });
            }
            let webrtcActive = false;
            for (const [id, connected] of Object.entries(webrtcConnectedRef.current)) {
              if (connected && pcsRef.current[id] && (pcsRef.current[id].connectionState === "connected" || pcsRef.current[id].iceConnectionState === "connected")) {
                webrtcActive = true;
                break;
              }
            }
            if (!webrtcActive && wsRef.current && wsRef.current.readyState === 1 && now - lastSendFrameRef.current > 55) {
              lastSendFrameRef.current = now;
              try {
                if (!streamCanvasRef.current) {
                  const sc2 = document.createElement("canvas");
                  sc2.width = 320;
                  sc2.height = 240;
                  streamCanvasRef.current = sc2;
                }
                const sc = streamCanvasRef.current;
                const sctx = sc.getContext("2d");
                sctx.drawImage(v, 0, 0, 320, 240);
                const frameData = sc.toDataURL("image/jpeg", 0.38);
                wsRef.current.send(JSON.stringify({
                  type: "stream_frame",
                  image: frameData,
                  name: netNameRef.current || "Participant",
                  role: netRole
                }));
              } catch (e) {
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      }
      handLostRef.current = 0;
      setRunning(true);
      setLog("");
    } catch (e) {
      setLog(String(e && e.message || e) || "Camera failed. Allow permissions.");
    }
  }, [onResults]);
  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setLocalStream(null);
    if (handsRef.current) {
      try {
        handsRef.current.close();
      } catch (e) {
      }
      handsRef.current = null;
    }
    setRunning(false);
    setTracking(false);
    handLostRef.current = 0;
    stabRef.current = newStab();
    motionRef.current = { prev: null, value: 0 };
    travelRef.current = { n: 0, flushed: false };
    emaRef.current = {};
    recentPredsRef.current = [];
  }, []);
  useEffect(() => () => stopCamera(), [stopCamera]);
  const formatTime = (s) => {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
  };
  const clearUpBuffer = useCallback(() => {
    upBufferRef.current = [];
    upStabRef.current = newStab();
    upEmaRef.current = {};
    upRecentPredsRef.current = [];
    upMotionRef.current = { prev: null, value: 0 };
    upTravelRef.current = { n: 0, flushed: false };
    setUpBufferLen(0);
    setUpPred(null);
    setUpTracking(false);
  }, []);
  const clearUpSentence = useCallback(() => {
    const t = upSentence.trim();
    if (t && history.length >= 0) {
      const last = history[0]?.text || "";
      if (t !== last) {
        const item = { id: Date.now() + "" + Math.floor(Math.random() * 1e4), text: t, lang, ts: Date.now() };
        setHistory((h) => [item, ...h]);
      }
    }
    setUpSentence("");
    setUpTimeline([]);
  }, [upSentence, history, lang]);
  const saveUpSentence = useCallback(() => {
    const t = upSentence.trim();
    if (!t) return;
    const item = { id: Date.now() + "" + Math.floor(Math.random() * 1e4), text: t, lang, ts: Date.now() };
    setHistory((h) => [item, ...h]);
    setSavedFlash(Date.now());
  }, [upSentence, lang]);
  const handleUpFile = useCallback((file) => {
    if (!file) {
      setUpLog("No file selected");
      return;
    }
    const okTypes = ["video/mp4", "video/webm", "video/quicktime"];
    const okExts = [".mp4", ".webm", ".mov"];
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    const typeOk = okTypes.includes(file.type) || file.type.startsWith("video/") || okExts.includes(ext);
    if (!typeOk) {
      setUpLog("Unsupported format \u2014 please use .mp4, .webm or .mov");
      return;
    }
    if (file.size > 120 * 1024 * 1024) {
      setUpLog("File too large (>120MB). Please use a shorter clip.");
      return;
    }
    if (upUrl) try {
      URL.revokeObjectURL(upUrl);
    } catch (e) {
    }
    if (upHandsRef.current) {
      try {
        upHandsRef.current.close();
      } catch (e) {
      }
      upHandsRef.current = null;
    }
    if (upRafRef.current) cancelAnimationFrame(upRafRef.current);
    if (upRvfcIdRef.current && upVideoRef.current && upVideoRef.current.cancelVideoFrameCallback) {
      try {
        upVideoRef.current.cancelVideoFrameCallback(upRvfcIdRef.current);
      } catch (e) {
      }
    }
    upRvfcIdRef.current = null;
    upRafRef.current = null;
    upGenerationRef.current++;
    clearUpBuffer();
    setUpTimeline([]);
    setUpPred(null);
    setUpLog("");
    setUpTracking(false);
    setUpFps(0);
    setUpCurrentTime(0);
    setUpDuration(0);
    setUpPlaying(false);
    setUpProcessing(false);
    upFpsRef.current = { last: performance.now(), frames: 0 };
    upFrameRef.current = 0;
    upEmaRef.current = {};
    const url = URL.createObjectURL(file);
    setUpFile(file);
    setUpUrl(url);
  }, [upUrl, clearUpBuffer]);
  const handleUpFileChange = useCallback((e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleUpFile(f);
    if (e.target) e.target.value = "";
  }, [handleUpFile]);
  const handleUpDragOver = useCallback((e) => {
    e.preventDefault();
    setUpDragOver(true);
  }, []);
  const handleUpDragLeave = useCallback((e) => {
    e.preventDefault();
    setUpDragOver(false);
  }, []);
  const handleUpDrop = useCallback((e) => {
    e.preventDefault();
    setUpDragOver(false);
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleUpFile(f);
  }, [handleUpFile]);
  const upApplyCommit = useCallback((p) => {
    const L = p.letter || "";
    const isSpace = L === "SPACE" || L === " " || L === "space";
    const isDel = L === "DEL" || L === "del";
    setUpSentence((s) => {
      if (isSpace) return s + " ";
      if (isDel) return s.slice(0, -1);
      return s + L;
    });
    recordStat(p);
    const t = upVideoRef.current ? upVideoRef.current.currentTime : 0;
    setUpTimeline((tl) => [...tl.slice(-(UP_TIMELINE_MAX - 1)), { t, letter: L, confidence: p.confidence || 0 }]);
  }, [recordStat]);
  const upCommit = useCallback((p) => {
    const st = upStabRef.current;
    const sp = SPEED_PRESETS[speedNowRef.current] || SPEED_PRESETS.fast;
    const stab = sp.stab;
    const gapv = sp.gap;
    const relNeed = releaseFrames(sp);
    if (p.confidence < confGate) {
      st.rel++;
      if (p.confidence < confGate * RELEASE_CONF_RATIO) addRelease(st, relNeed);
      if (st.rel >= gapv) {
        st.cur = null;
        st.count = 0;
      }
      return;
    }
    st.rel = 0;
    if (upMotionRef.current.value > MOTION_SETTLED) {
      addRelease(st, relNeed);
      st.cur = null;
      st.count = 0;
      return;
    }
    if (holdsLatch(st, p.letter)) st.away = 0;
    if (p.letter === st.last && !st.armed) {
      st.cur = null;
      st.count = 0;
      return;
    }
    if (p.letter === st.cur) {
      st.count++;
    } else {
      st.cur = p.letter;
      st.count = 1;
    }
    if (st.count < framesNeeded(stab, p.letter === st.last)) return;
    const partners = (langRef.current === "ar" ? CONFUSABLE_AR : CONFUSABLE_EN)[p.letter];
    if (partners && partners.length) {
      const arb = langRef.current === "ar" ? JHK_AR[p.letter] ? jhkArbitrate : null : p.letter === "A" || p.letter === "T" ? atArbitrate : null;
      if (arb) {
        const torn = Array.isArray(p.top3) && p.top3.some((t) => partners.indexOf(t.letter) >= 0);
        if (torn) {
          const g = arb(upLastStdFeatsRef.current);
          if (g && g !== p.letter && partners.indexOf(g) >= 0) {
            if (g === st.last && !st.armed) {
              st.cur = null;
              st.count = 0;
              return;
            }
            const cls = langRef.current === "ar" ? AR_UNI[g] : g.charCodeAt(0) - 65;
            if (typeof cls === "number") {
              latch(st, g);
              upEmaRef.current = {};
              upApplyCommit({ letter: g, name: nameForCls(cls, langRef.current), confidence: p.confidence, class_id: cls, top3: p.top3, lang: langRef.current });
              return;
            }
          }
        }
      }
      const { sX, sP } = pairMass(upRecentPredsRef.current, p.letter, partners);
      for (const y of partners) {
        if (sP[y] > sX && sP[y] - sX > 0.25) return;
      }
    }
    latch(st, p.letter);
    upEmaRef.current = {};
    upApplyCommit({ ...p, lang: langRef.current });
  }, [upApplyCommit, confGate]);
  const upFeedPrediction = useCallback((p) => {
    setUpPred(p);
    upLastTrackRef.current = true;
    setUpTracking(true);
    if (p && p.heuristic) return;
    upRecentPredsRef.current.push(p);
    if (upRecentPredsRef.current.length > 6) upRecentPredsRef.current.shift();
    upCommit(p);
  }, [upCommit]);
  const upPredictOne = useCallback(async (seq, isRetry) => {
    if (upPredictingRef.current) return;
    upPredictingRef.current = true;
    const generation = upGenerationRef.current;
    let p = null;
    let maxVal = 0;
    for (const f of seq) {
      for (const v of f) {
        const a = v < 0 ? -v : v;
        if (a > maxVal) maxVal = a;
      }
    }
    const payload = maxVal > 0 ? seq.map((f) => f.map((v) => Math.round(v / maxVal * 1e4) / 1e4)) : seq;
    try {
      const res = await fetch(apiUrlRef.current + "/predict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sequence: payload, language: langRef.current }) });
      if (generation !== upGenerationRef.current) {
        upPredictingRef.current = false;
        return;
      }
      if (!res.ok) throw new Error("backend error");
      const d = await res.json();
      if (generation !== upGenerationRef.current) {
        upPredictingRef.current = false;
        return;
      }
      if (d.status === "warming_up") {
        backendRef.current = "online";
        setBackend("online");
        upPredictingRef.current = false;
        return;
      }
      p = { letter: d.letter || "?", name: d.english_name || d.name || d.letter || "", confidence: typeof d.confidence === "number" ? d.confidence : 0.9, class_id: typeof d.class_id === "number" ? d.class_id : 0, top3: Array.isArray(d.top3) ? d.top3 : [] };
      if (smoothRef.current && typeof p.confidence === "number") {
        const prev = upEmaRef.current[p.class_id];
        const c = typeof prev === "number" ? 0.6 * p.confidence + 0.4 * prev : p.confidence;
        upEmaRef.current[p.class_id] = c;
        p.confidence = c;
      }
      let cid;
      if (langRef.current === "ar") {
        cid = p.letter === "DEL" ? 31 : p.letter === "SPACE" ? 32 : AR_UNI[p.letter];
      } else {
        cid = p.letter === "DEL" ? 26 : p.letter === "SPACE" ? 27 : p.letter && p.letter.length === 1 && p.letter >= "A" && p.letter <= "Z" ? p.letter.charCodeAt(0) - 65 : void 0;
      }
      if (typeof cid === "number") p.class_id = cid;
      backendRef.current = "online";
      setBackend("online");
    } catch (e) {
      if (backendRef.current !== "offline") {
        backendRef.current = "offline";
        setBackend("offline");
      }
      upPredictingRef.current = false;
      return;
    }
    upPredictingRef.current = false;
    if (!isRetry && p && p.confidence < confGate) {
      const mseq = mirrorSeq(seq);
      return upPredictOne(mseq, true);
    }
    upFeedPrediction(p);
  }, [upFeedPrediction, confGate]);
  const upOnResults = useCallback(async (r) => {
    const video = upVideoRef.current, cvs = upCanvasRef.current;
    if (!video || !cvs) return;
    const ctx = cvs.getContext("2d");
    cvs.width = video.videoWidth || 640;
    cvs.height = video.videoHeight || 480;
    if (ctx) {
      ctx.save();
      ctx.clearRect(0, 0, cvs.width, cvs.height);
    }
    const fr = upFrameRef.current++;
    const n = performance.now();
    upFpsRef.current.frames++;
    if (n - upFpsRef.current.last >= 1e3) {
      setUpFps(upFpsRef.current.frames);
      upFpsRef.current.frames = 0;
      upFpsRef.current.last = n;
    }
    if (r.multiHandLandmarks && r.multiHandLandmarks.length) {
      if (!upLastTrackRef.current) {
        upLastTrackRef.current = true;
        setUpTracking(true);
      }
      const lm = r.multiHandLandmarks[0];
      if (ctx && window.drawConnectors && window.drawLandmarks) {
        window.drawConnectors(ctx, lm, window.HAND_CONNECTIONS, { color: "#1E7FE0", lineWidth: 2 });
        window.drawLandmarks(ctx, lm, { color: "#00D4FF", lineWidth: 1, radius: 3 });
        window.drawLandmarks(ctx, lm, { color: "rgba(0,212,255,0.35)", lineWidth: 6, radius: 6 });
      }
      let flip = false;
      const mode = upMirrorRef.current;
      const mhU = r.multiHandedness && r.multiHandedness[0];
      if (mhU && mhU.classification && mhU.classification[0]) {
        const label = mhU.classification[0].label;
        flip = mode === "mirrored" ? label === "Right" : label === "Left";
      } else {
        const geo = lm[5].x < lm[17].x;
        flip = mode === "mirrored" ? !geo : geo;
      }
      const feats = [];
      for (const L of lm) {
        const mx = flip ? 1 - L.x : L.x;
        feats.push(mx, L.y, L.z);
      }
      upMotionRef.current.value = upMotionRef.current.prev ? featMotion(feats, upMotionRef.current.prev) : 1;
      upMotionRef.current.prev = feats;
      upLastTrackRef.current = true;
      upHandLostAtRef.current = 0;
      upLastStdFeatsRef.current = feats;
      const upTravel = upTravelRef.current;
      if (upMotionRef.current.value > MOTION_SETTLED) {
        upTravel.n++;
        if (upTravel.n >= SIGN_BOUNDARY_FRAMES && !upTravel.flushed) {
          upTravel.flushed = true;
          if (upBufferRef.current.length) {
            upBufferRef.current = [];
            setUpBufferLen(0);
          }
          upEmaRef.current = {};
          upRecentPredsRef.current = [];
        }
      } else {
        upTravel.n = 0;
        upTravel.flushed = false;
      }
      const upTravelling = upTravel.n >= SIGN_BOUNDARY_FRAMES;
      if (!upTravelling) {
        upBufferRef.current.push(feats);
        if (upBufferRef.current.length > WINDOW) upBufferRef.current.shift();
      }
      if (fr % 2 === 0) {
        setUpBufferLen(upBufferRef.current.length);
      }
      if (!upTravelling && upBufferRef.current.length >= MIN_FILL) {
        const st = backendRef.current;
        if (st === "online") {
          const seq = [...upBufferRef.current];
          while (seq.length < WINDOW) {
            seq.push(seq[seq.length - 1]);
          }
          upPredictOne(seq);
        } else if (st !== "online" && fr % 4 === 0) {
          upFeedPrediction(heuristic(feats, langRef.current, confGate));
        }
      }
    } else {
      if (upLastTrackRef.current) {
        upLastTrackRef.current = false;
        setUpTracking(false);
      }
      if (!upHandLostAtRef.current) upHandLostAtRef.current = performance.now();
      const upLostMs = performance.now() - upHandLostAtRef.current;
      upStabRef.current.cur = null;
      upStabRef.current.count = 0;
      addRelease(upStabRef.current, releaseFrames(SPEED_PRESETS[speedNowRef.current] || SPEED_PRESETS.fast));
      upMotionRef.current.prev = null;
      upMotionRef.current.value = 0;
      upTravelRef.current = { n: 0, flushed: false };
      if (upLostMs > 350) {
        upStabRef.current = newStab();
        upEmaRef.current = {};
        upRecentPredsRef.current = [];
        if (upBufferRef.current.length) {
          upBufferRef.current = [];
          setUpBufferLen(0);
        }
      }
    }
    if (ctx) ctx.restore();
  }, [upPredictOne, upFeedPrediction, confGate]);
  const ensureUpHands = useCallback(async () => {
    if (upHandsRef.current) return upHandsRef.current;
    await loadMediaPipe();
    const Hands = window.Hands;
    if (!Hands) throw new Error("MediaPipe Hands not loaded");
    const hands = new Hands({ locateFile: (f) => "https://cdn.jsdelivr.net/npm/@mediapipe/hands/" + f });
    hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.35, minTrackingConfidence: 0.35 });
    hands.onResults(upOnResults);
    upHandsRef.current = hands;
    return hands;
  }, [upOnResults]);
  const stopUpLoop = useCallback(() => {
    if (upRvfcIdRef.current !== null && upVideoRef.current && upVideoRef.current.cancelVideoFrameCallback) {
      try {
        upVideoRef.current.cancelVideoFrameCallback(upRvfcIdRef.current);
      } catch (e) {
      }
    }
    upRvfcIdRef.current = null;
    if (upRafRef.current) cancelAnimationFrame(upRafRef.current);
    upRafRef.current = null;
    setUpProcessing(false);
  }, []);
  const clearUpVideo = useCallback(() => {
    stopUpLoop();
    if (upHandsRef.current) {
      try {
        upHandsRef.current.close();
      } catch (e) {
      }
      upHandsRef.current = null;
    }
    if (upUrl) try {
      URL.revokeObjectURL(upUrl);
    } catch (e) {
    }
    setUpUrl(null);
    setUpFile(null);
    setUpPlaying(false);
    setUpDuration(0);
    setUpCurrentTime(0);
    setUpFps(0);
    setUpLog("");
    clearUpBuffer();
    setUpTimeline([]);
    setUpSentence("");
  }, [clearUpBuffer, stopUpLoop, upUrl]);
  const startUpLoop = useCallback(async () => {
    const v = upVideoRef.current;
    if (!v || !upUrl) return;
    try {
      await ensureUpHands();
    } catch (e) {
      setUpLog(String(e.message || e));
      return;
    }
    if (upVideoRef.current !== v || v.paused || v.ended || !upUrl) return;
    stopUpLoop();
    upFpsRef.current = { last: performance.now(), frames: 0 };
    upSendErrorsRef.current = 0;
    setUpProcessing(true);
    let last = 0;
    const tick = () => {
      const vv = upVideoRef.current;
      if (!vv || vv.paused || vv.ended) {
        stopUpLoop();
        return;
      }
      const now = performance.now();
      if (vv.readyState >= 2 && now - last > 36 && upHandsRef.current && !upSendBusyRef.current) {
        last = now;
        upSendBusyRef.current = true;
        upHandsRef.current.send({ image: vv }).then(() => {
          upSendErrorsRef.current = 0;
        }).catch((e) => {
          upSendErrorsRef.current++;
          if (upSendErrorsRef.current === 3) setUpLog("Video analysis error: " + String(e && e.message || e || "MediaPipe failed"));
        }).finally(() => {
          upSendBusyRef.current = false;
        });
      }
      upRafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [upUrl, ensureUpHands, stopUpLoop]);
  const upOnLoadedMetadata = useCallback(() => {
    const v = upVideoRef.current;
    if (!v) return;
    setUpDuration(v.duration || 0);
    setUpCurrentTime(0);
    const c = upCanvasRef.current;
    if (c) {
      c.width = v.videoWidth || 640;
      c.height = v.videoHeight || 480;
    }
    clearUpBuffer();
    setUpTimeline([]);
    setUpLog("");
  }, [clearUpBuffer]);
  const upOnTimeUpdate = useCallback(() => {
    const v = upVideoRef.current;
    if (v) setUpCurrentTime(v.currentTime);
  }, []);
  const upOnPlay = useCallback(() => {
    setUpPlaying(true);
    startUpLoop();
  }, [startUpLoop]);
  const upOnPause = useCallback(() => {
    upGenerationRef.current++;
    setUpPlaying(false);
    stopUpLoop();
  }, [stopUpLoop]);
  const upOnEnded = useCallback(() => {
    upGenerationRef.current++;
    setUpPlaying(false);
    stopUpLoop();
  }, [stopUpLoop]);
  const upOnSeeked = useCallback(() => {
    upGenerationRef.current++;
    clearUpBuffer();
    setUpLog("Seeked \u2014 buffer reset");
  }, [clearUpBuffer]);
  const upOnVideoError = useCallback(() => {
    const v = upVideoRef.current;
    const msg = v && v.error ? "Video error: " + v.error.message + " (code " + v.error.code + ")" : "Unreadable video codec \u2014 try re-encoding to H.264 .mp4";
    setUpLog(msg);
    setUpPlaying(false);
    stopUpLoop();
  }, [stopUpLoop]);
  const upTogglePlay = useCallback(() => {
    const v = upVideoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch((e) => setUpLog(String(e.message || e)));
    else v.pause();
  }, []);
  const upHandleSeek = useCallback((val) => {
    const v = upVideoRef.current;
    if (!v) return;
    const t = parseFloat(val);
    if (isFinite(t)) {
      v.currentTime = t;
      setUpCurrentTime(t);
    }
  }, []);
  const upHandleSpeed = useCallback((val) => {
    const v = parseFloat(val);
    setUpPlaybackRate(v);
    const vid = upVideoRef.current;
    if (vid) vid.playbackRate = v;
  }, []);
  const upReset = useCallback(() => {
    const v = upVideoRef.current;
    if (v) {
      v.currentTime = 0;
      v.pause();
    }
    upGenerationRef.current++;
    clearUpBuffer();
    setUpTimeline([]);
    setUpSentence("");
    setUpPred(null);
    setUpLog("");
  }, [clearUpBuffer]);
  useEffect(() => {
    if (tab !== "upload") {
      const v = upVideoRef.current;
      if (v) {
        v.pause();
      }
      stopUpLoop();
    }
  }, [tab, stopUpLoop]);
  useEffect(() => {
    return () => {
      if (upUrl) try {
        URL.revokeObjectURL(upUrl);
      } catch (e) {
      }
      stopUpLoop();
      if (upHandsRef.current) {
        try {
          upHandsRef.current.close();
        } catch (e) {
        }
        upHandsRef.current = null;
      }
    };
  }, [stopUpLoop, upUrl]);
  useEffect(() => {
    const v = upVideoRef.current;
    if (v) v.playbackRate = upPlaybackRate;
  }, [upPlaybackRate]);
  useEffect(() => {
    upGenerationRef.current++;
    clearUpBuffer();
  }, [upMirror, clearUpBuffer]);
  const netSend = (obj) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    const payload = { ...obj };
    if (!payload.name) payload.name = netNameRef.current || "Guest";
    if (!payload.role) payload.role = netRole;
    wsRef.current.send(JSON.stringify(payload));
  };
  const markCapSeen = (mid) => {
    if (!mid) return false;
    const now = Date.now();
    const m = seenCapRef.current;
    m.forEach((t, k) => {
      if (now - t > 15e3) m.delete(k);
    });
    if (m.has(mid)) return true;
    m.set(mid, now);
    return false;
  };
  const shouldSpeakIncoming = (m) => {
    if (roomMutedRef.current) return false;
    return m.speak === true || autoSpeakRef.current === true;
  };
  const sendCap = (text, opts) => {
    if (!text) return;
    const o = opts || {};
    const payloadObj = { type: "cap", mid: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7), text, speak: !!o.speak, sign: !!o.sign, name: netNameRef.current || "You", role: netRole, kind: o.kind || "chat" };
    const payload = JSON.stringify(payloadObj);
    Object.values(dcsRef.current).forEach((dc) => {
      if (dc && dc.readyState === "open") dc.send(payload);
    });
    netSend(payloadObj);
  };
  const wireDC = (id, dc) => {
    dcsRef.current[id] = dc;
    dc.onopen = () => {
      sysNote("\u26A1 Realtime connection established with participant.");
      setPcNote("");
    };
    dc.onclose = () => {
      delete dcsRef.current[id];
    };
    dc.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "cap") {
          if (markCapSeen(m.mid)) return;
          setNetCaps((p) => [...p.slice(-40), { id, text: m.text, ts: Date.now(), name: m.name || "Peer", role: m.role || "", kind: m.kind || "chat" }]);
          if (m.kind !== "chat") {
            showBigCap((m.name ? m.name + ": " : "") + m.text);
          }
          if (shouldSpeakIncoming(m)) speak(m.text);
          if (m.sign) playRoomSign(m.text);
        }
      } catch (err) {
      }
    };
  };
  const cleanupPeer = (id) => {
    const pc = pcsRef.current[id];
    if (pc) {
      try {
        pc.close();
      } catch (e) {
      }
    }
    delete pcsRef.current[id];
    delete dcsRef.current[id];
    delete remoteStreamsRef.current[id];
    delete webrtcConnectedRef.current[id];
    delete pendingCandidatesRef.current[id];
    setPeerIds((p) => p.filter((x) => x !== id));
    setRoomPeers((p) => p.filter((x) => x !== id));
    setRemoteStreamsMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setWebrtcConnectedMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };
  const drainCandidates = async (pc, id) => {
    if (!pc || !pc.remoteDescription) return;
    const q2 = id && pendingCandidatesRef.current[id] || pc._pendingCandidates || [];
    while (q2.length > 0) {
      const cand = q2.shift();
      if (cand) {
        try {
          await pc.addIceCandidate(cand);
        } catch (e) {
        }
      }
    }
  };
  const makePC = (id, isOfferer) => {
    const pc = new RTCPeerConnection(getIceServers(turnUrl, turnUser, turnCred));
    pc._pendingCandidates = [];
    pcsRef.current[id] = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) netSend({ type: "candidate", to: id, candidate: e.candidate });
    };
    pc.ontrack = (e) => {
      let st = remoteStreamsRef.current[id];
      if (!st) {
        st = e.streams && e.streams[0] ? e.streams[0] : new MediaStream();
        remoteStreamsRef.current[id] = st;
      }
      if (e.track && !st.getTracks().includes(e.track)) {
        st.addTrack(e.track);
        setRemoteStreamsMap((prev) => ({ ...prev, [id]: st }));
      }
      setPeerIds((p) => p.includes(id) ? p : [...p, id]);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        setPcNote("");
        pc._iceRestartPending = false;
        webrtcConnectedRef.current[id] = true;
        setWebrtcConnectedMap((prev) => ({ ...prev, [id]: true }));
      } else if (s === "connecting") {
        setPcNote("Connecting live video\u2026");
      } else if (s === "disconnected") {
        setPcNote("Reconnecting\u2026");
        webrtcConnectedRef.current[id] = false;
        setWebrtcConnectedMap((prev) => ({ ...prev, [id]: false }));
        if (!pc._iceRestartPending && isOfferer) {
          pc._iceRestartPending = true;
          setTimeout(async () => {
            try {
              if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
                const off = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(off);
                netSend({ type: "offer", to: id, sdp: { type: off.type, sdp: off.sdp } });
              }
            } catch (e) {
            }
            pc._iceRestartPending = false;
          }, 2e3);
        }
      } else if (s === "failed") {
        setPcNote("Connection failed \u2014 retrying\u2026");
        webrtcConnectedRef.current[id] = false;
        setWebrtcConnectedMap((prev) => ({ ...prev, [id]: false }));
        if (isOfferer && !pc._iceRestartPending) {
          pc._iceRestartPending = true;
          (async () => {
            try {
              const off = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(off);
              netSend({ type: "offer", to: id, sdp: { type: off.type, sdp: off.sdp } });
            } catch (e) {
              cleanupPeer(id);
            }
            pc._iceRestartPending = false;
          })();
        }
      } else if (s === "closed") {
        cleanupPeer(id);
        setPcNote("");
      }
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === "connected" || st === "completed") {
        setPcNote("");
        pc._iceRestartPending = false;
        webrtcConnectedRef.current[id] = true;
        setWebrtcConnectedMap((prev) => ({ ...prev, [id]: true }));
      } else if (st === "checking") {
        setPcNote("Negotiating connection\u2026");
      } else if (st === "failed") {
        webrtcConnectedRef.current[id] = false;
        setWebrtcConnectedMap((prev) => ({ ...prev, [id]: false }));
        if (isOfferer && !pc._iceRestartPending) {
          setPcNote("ICE failed \u2014 retrying\u2026");
          pc._iceRestartPending = true;
          (async () => {
            try {
              const off = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(off);
              netSend({ type: "offer", to: id, sdp: { type: off.type, sdp: off.sdp } });
            } catch (e) {
            }
            pc._iceRestartPending = false;
          })();
        }
      }
    };
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => pc.addTrack(t, streamRef.current));
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, micStreamRef.current));
    if (isOfferer) {
      wireDC(id, pc.createDataChannel("cap"));
    } else {
      pc.ondatachannel = (e) => wireDC(id, e.channel);
    }
    return pc;
  };
  const renegotiate = async (id) => {
    const pc = pcsRef.current[id];
    if (!pc || pc._negoBusy) return;
    if (pc.signalingState !== "stable") {
      setTimeout(() => renegotiate(id), 900);
      return;
    }
    pc._negoBusy = true;
    try {
      const off = await pc.createOffer();
      await pc.setLocalDescription(off);
      netSend({ type: "offer", to: id, sdp: { type: off.type, sdp: off.sdp } });
    } catch (e) {
    } finally {
      pc._negoBusy = false;
    }
  };
  const onPeerJoined = async (id) => {
    const pc = makePC(id, true);
    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    netSend({ type: "offer", to: id, sdp: { type: offer.type, sdp: offer.sdp } });
  };
  const onOffer = async (id, sdp) => {
    let pc = pcsRef.current[id];
    if (pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
      cleanupPeer(id);
      pc = null;
    }
    if (!pc) pc = makePC(id, false);
    if (pc.signalingState === "have-local-offer" && String(selfRef.current || "") > String(id)) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainCandidates(pc, id);
      const ans = await pc.createAnswer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
      await pc.setLocalDescription(ans);
      netSend({ type: "answer", to: id, sdp: { type: ans.type, sdp: ans.sdp } });
    } catch (e) {
      setPcNote("Handshake retry\u2026");
    }
  };
  const onAnswer = async (id, sdp) => {
    const pc = pcsRef.current[id];
    if (!pc) return;
    if (pc.signalingState !== "have-local-offer") return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainCandidates(pc, id);
    } catch (e) {
    }
  };
  const onCandidate = async (id, cand) => {
    const pc = pcsRef.current[id];
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      if (!pendingCandidatesRef.current[id]) pendingCandidatesRef.current[id] = [];
      pendingCandidatesRef.current[id].push(cand);
      return;
    }
    try {
      await pc.addIceCandidate(cand);
    } catch (e) {
    }
  };
  const applySelf = (v) => {
    selfRef.current = v || "";
  };
  const getSRClass = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const buildRoomRec = () => {
    const SRC = getSRClass();
    if (!SRC) return null;
    const gen = srGenRef.current;
    const rec = new SRC();
    rec.lang = (langRef.current || lang) === "ar" ? "ar-SA" : "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec._finalsDone = 0;
    rec._interim = "";
    const applyDraft = () => {
      const spoken = ((srFinalRef.current || "") + " " + (rec._interim || "")).replace(/\s+/g, " ").trim();
      setSrPreview(spoken);
      const base = (baseDraftRef.current || "").trim();
      if (!base) draftSignRef.current = false;
      setRoomDraft(base ? base + " " + spoken : spoken);
    };
    rec.onstart = () => {
      if (gen !== srGenRef.current) return;
      setSrActive(true);
    };
    rec.onresult = (ev) => {
      if (gen !== srGenRef.current) return;
      if (ev.results.length < rec._finalsDone) rec._finalsDone = 0;
      let interim = "";
      for (let i = rec._finalsDone; i < ev.results.length; i++) {
        const res = ev.results[i];
        const raw2 = res[0] && res[0].transcript ? res[0].transcript : "";
        const text = raw2.trim();
        if (!text) continue;
        if (res.isFinal) {
          srFinalRef.current = mergeSpeechText(srFinalRef.current, text);
          rec._finalsDone = i + 1;
        } else {
          interim = text;
        }
      }
      let cleanInterim = interim.trim();
      const finalTrim = srFinalRef.current.trim();
      if (finalTrim && cleanInterim) {
        if (cleanInterim === finalTrim) {
          cleanInterim = "";
        } else if (cleanInterim.startsWith(finalTrim + " ")) {
          cleanInterim = cleanInterim.slice(finalTrim.length + 1).trim();
        } else if (cleanInterim.startsWith(finalTrim)) {
          cleanInterim = cleanInterim.slice(finalTrim.length).trim();
        }
      }
      rec._interim = cleanInterim;
      applyDraft();
    };
    rec.onerror = (ev) => {
      if (gen !== srGenRef.current) return;
      console.warn("SR error:", ev.error);
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        sysNote("\u26A0\uFE0F \u064A\u0631\u062C\u0649 \u0627\u0644\u0633\u0645\u0627\u062D \u0628\u0635\u0644\u0627\u062D\u064A\u0629 \u0627\u0644\u0645\u064A\u0643\u0631\u0648\u0641\u0648\u0646 (Allow Microphone) \u0641\u064A \u0627\u0644\u0645\u062A\u0635\u0641\u062D.");
        srWantedRef.current = false;
        setSrActive(false);
        roomSRRef.current = null;
      }
    };
    rec.onend = () => {
      if (gen !== srGenRef.current) return;
      if (rec._interim) {
        srFinalRef.current = mergeSpeechText(srFinalRef.current, rec._interim);
        rec._interim = "";
        applyDraft();
      }
      roomSRRef.current = null;
      if (!srWantedRef.current) {
        setSrActive(false);
        return;
      }
      clearTimeout(srRestartTimerRef.current);
      srRestartTimerRef.current = setTimeout(() => {
        clearTimeout(srRestartTimerRef.current);
        if (!srWantedRef.current || gen !== srGenRef.current) return;
        const r2 = buildRoomRec();
        roomSRRef.current = r2;
        try {
          r2.start();
        } catch (e) {
          srRestartTimerRef.current = setTimeout(() => {
            if (!srWantedRef.current || gen !== srGenRef.current) return;
            try {
              r2.start();
            } catch (e2) {
            }
          }, 600);
        }
      }, 300);
    };
    return rec;
  };
  const startRoomSR = () => {
    const SRC = getSRClass();
    if (!SRC) {
      sysNote("\u26A0\uFE0F \u0645\u062A\u0635\u0641\u062D\u0643 \u0644\u0627 \u064A\u062F\u0639\u0645 \u0627\u0644\u062A\u0639\u0631\u0641 \u0627\u0644\u0635\u0648\u062A\u064A \u0627\u0644\u0645\u0628\u0627\u0634\u0631 \u2014 \u064A\u0631\u062C\u0649 \u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0645\u062A\u0635\u0641\u062D Google Chrome \u0623\u0648 Microsoft Edge.");
      return;
    }
    srGenRef.current++;
    clearTimeout(srRestartTimerRef.current);
    srRestartTimerRef.current = 0;
    if (roomSRRef.current) {
      try {
        roomSRRef.current.abort();
      } catch (e) {
      }
      roomSRRef.current = null;
    }
    baseDraftRef.current = roomDraft;
    srFinalRef.current = "";
    srWantedRef.current = true;
    setSrActive(true);
    setSrPreview("");
    const rec = buildRoomRec();
    if (!rec) {
      srWantedRef.current = false;
      setSrActive(false);
      return;
    }
    roomSRRef.current = rec;
    try {
      rec.start();
    } catch (e) {
      srWantedRef.current = false;
      setSrActive(false);
      roomSRRef.current = null;
      sysNote("\u26A0\uFE0F \u062A\u0639\u0630\u0631 \u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u0635\u0648\u062A\u064A.");
    }
  };
  const stopRoomSR = () => {
    srWantedRef.current = false;
    clearTimeout(srRestartTimerRef.current);
    srRestartTimerRef.current = 0;
    const r = roomSRRef.current;
    if (r) {
      try {
        r.stop();
      } catch (e) {
      }
    }
    roomSRRef.current = null;
    setSrActive(false);
    setSrPreview("");
  };
  useEffect(() => {
    if (!srActive || !srWantedRef.current) return;
    clearTimeout(srRestartTimerRef.current);
    if (roomSRRef.current) {
      if (roomSRRef.current._interim) {
        srFinalRef.current = mergeSpeechText(srFinalRef.current, roomSRRef.current._interim);
        roomSRRef.current._interim = "";
      }
      try {
        roomSRRef.current.abort();
      } catch (e) {
      }
      roomSRRef.current = null;
    }
    srGenRef.current++;
    const r = buildRoomRec();
    if (r) {
      roomSRRef.current = r;
      try {
        r.start();
      } catch (e) {
        setSrActive(false);
      }
    }
  }, [lang]);
  const toggleRoomCam = () => {
    const vt = streamRef.current && streamRef.current.getVideoTracks()[0];
    if (!vt) {
      sysNote("\u26A0\uFE0F Camera is not started yet.");
      return;
    }
    vt.enabled = !vt.enabled;
    setRoomCamOn(vt.enabled);
    if (!vt.enabled) {
      bufferRef.current = [];
      lastBufRef.current = -1;
      setBufferLen(0);
      stabRef.current = newStab();
      lastTrackRef.current = false;
      setTracking(false);
    }
  };
  const toggleRoomMic = async () => {
    if (!micStreamRef.current) {
      try {
        const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = ms;
        setRoomMicOn(true);
        const targets = Object.keys(pcsRef.current);
        targets.forEach((id) => {
          const pc = pcsRef.current[id];
          try {
            ms.getAudioTracks().forEach((t) => pc.addTrack(t, ms));
          } catch (e) {
          }
        });
        targets.forEach((id) => renegotiate(id));
        return;
      } catch (e) {
        setRoomMicOn(false);
        sysNote("\u26A0\uFE0F Microphone permission is required for voice input.");
        return;
      }
    }
    const mt = micStreamRef.current.getAudioTracks()[0];
    if (!mt) {
      sysNote("\u26A0\uFE0F No microphone track available on this device.");
      return;
    }
    mt.enabled = !mt.enabled;
    setRoomMicOn(mt.enabled);
  };
  const flipRoomCam = async () => {
    const oldVT = streamRef.current && streamRef.current.getVideoTracks()[0];
    const next = camFacingRef.current === "user" ? "environment" : "user";
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next, width: 640, height: 480 }, audio: false });
      const nvt = ns.getVideoTracks()[0];
      if (nvt) nvt.enabled = roomCamOn;
      const old = streamRef.current;
      if (old) {
        (old.getVideoTracks() || []).forEach((t) => {
          try {
            old.removeTrack(t);
          } catch (e) {
          }
          try {
            t.stop();
          } catch (e) {
          }
        });
      }
      streamRef.current = ns;
      camFacingRef.current = next;
      setLocalStream(ns);
      const pv = videoRef.current;
      if (pv) {
        try {
          pv.srcObject = ns;
          pv.play().catch(() => {
          });
        } catch (e) {
        }
      }
      let added = false;
      Object.keys(pcsRef.current).forEach((id) => {
        const pc = pcsRef.current[id];
        try {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
          if (sender && nvt) {
            sender.replaceTrack(nvt);
          } else if (nvt) {
            pc.addTrack(nvt, ns);
            added = true;
          }
        } catch (e) {
        }
      });
      if (added) Object.keys(pcsRef.current).forEach((id) => renegotiate(id));
      sysNote("\u{1F504} Camera flipped.");
    } catch (e) {
      sysNote("\u26A0\uFE0F \u062A\u0639\u0630\u0631 \u062A\u0628\u062F\u064A\u0644 \u0627\u0644\u0643\u0627\u0645\u064A\u0631\u0627 \u0639\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u062C\u0647\u0627\u0632.");
    }
  };
  const toggleStageFullscreen = () => {
    const el = stageWrapRef.current;
    if (!el) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      try {
        (document.exitFullscreen || document.webkitExitFullscreen || function() {
        }).call(document);
      } catch (e) {
      }
    } else if (el.requestFullscreen) {
      el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      try {
        el.webkitRequestFullscreen();
      } catch (e) {
      }
    }
  };
  const chatUnread = netCaps.slice(chatSeen).filter((c) => c.name !== "SYSTEM" && !String(c.id).startsWith("me")).length;
  let lastIncoming = null;
  for (let i = netCaps.length - 1; i >= 0; i--) {
    const c = netCaps[i];
    if (c.name !== "SYSTEM" && !String(c.id).startsWith("me")) {
      lastIncoming = c;
      break;
    }
  }
  const liveSub = !chatOpen && lastIncoming ? /* @__PURE__ */ React.createElement("div", { className: "live-sub", dir: "auto", role: "status" }, /* @__PURE__ */ React.createElement("span", { className: "ls-who" }, lastIncoming.name === "SYSTEM" ? "\u2699\uFE0F" : lastIncoming.kind === "sign" ? "\u{1F91F}" : "\u{1F4AC}", lastIncoming.name !== "SYSTEM" ? " " + lastIncoming.name + ":" : ""), " ", lastIncoming.text) : null;
  const sendRoomDraft = (mode) => {
    const t = (roomDraft || "").trim();
    if (!t) {
      sysNote("\u26A0\uFE0F \u062E\u0627\u0646\u0629 \u0627\u0644\u0646\u0635 \u0641\u0627\u0631\u063A\u0629 \u2014 \u062A\u062D\u062F\u062B \u0628\u0627\u0644\u0635\u0648\u062A \u0623\u0648 \u0627\u0643\u062A\u0628 \u0631\u0633\u0627\u0644\u0629 \u0623\u0648\u0644\u0627\u064B.");
      return;
    }
    if (!netOnRef.current) {
      sysNote("\u26A0\uFE0F \u0627\u0646\u0636\u0645 \u0625\u0644\u0649 \u0627\u0644\u063A\u0631\u0641\u0629 \u0623\u0648\u0644\u0627\u064B \u0628\u0627\u0644\u0636\u063A\u0637 \u0639\u0644\u0649 JOIN ROOM.");
      return;
    }
    const kind = mode === "sign" || draftSignRef.current ? "sign" : "chat";
    sendCap(t, { kind, speak: mode === "speak", sign: mode === "sign" });
    setNetCaps((p) => [...p.slice(-40), { id: "me" + Date.now(), text: t, ts: Date.now(), name: netNameRef.current || "You", role: netRole, kind }]);
    if (mode === "speak") speak(t);
    if (mode === "sign") playRoomSign(t);
    clearRoomDraft();
  };
  const typeRoomDraft = (v) => {
    draftSignRef.current = false;
    setRoomDraft(v);
  };
  const clearRoomDraft = () => {
    draftSignRef.current = false;
    srFinalRef.current = "";
    baseDraftRef.current = "";
    setRoomDraft("");
    setSrPreview("");
  };
  const saveRec = () => {
    if (!recChunksRef.current.length) return;
    try {
      const blob = new Blob(recChunksRef.current, { type: recMimeRef.current || "video/webm" });
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement("a");
      aEl.href = url;
      aEl.download = "slp-room-" + (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + ".webm";
      document.body.appendChild(aEl);
      aEl.click();
      aEl.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4e3);
    } catch (e) {
    }
    recChunksRef.current = [];
  };
  const stopRec = (save) => {
    const r = recRef2.current;
    recRef2.current = null;
    setRecOn(false);
    if (!r) {
      recChunksRef.current = [];
      return;
    }
    recSaveRef.current = save !== false;
    try {
      r.stop();
    } catch (e) {
      if (save !== false) saveRec();
      else recChunksRef.current = [];
    }
  };
  const toggleRec = () => {
    if (recOn) {
      stopRec(true);
      return;
    }
    const vt = streamRef.current && streamRef.current.getVideoTracks() || [];
    if (!vt.length) {
      sysNote("\u26A0\uFE0F Camera is not started.");
      return;
    }
    if (!vt[0].enabled) {
      sysNote("\u26A0\uFE0F Turn the camera on before recording.");
      return;
    }
    if (!window.MediaRecorder) {
      sysNote("\u26A0\uFE0F Recording is not supported in this browser.");
      return;
    }
    let stream = new MediaStream([vt[0]]);
    if (micStreamRef.current) {
      const at = micStreamRef.current.getAudioTracks()[0];
      if (at && at.enabled) stream.addTrack(at);
    }
    let mime = "video/webm;codecs=vp9,opus";
    if (!(MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime))) mime = "video/webm";
    try {
      const mr = new MediaRecorder(stream, { mimeType: mime });
      recMimeRef.current = mime;
      recChunksRef.current = [];
      recSaveRef.current = true;
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) recChunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        if (recSaveRef.current) saveRec();
        else recChunksRef.current = [];
      };
      mr.start(1e3);
      recRef2.current = mr;
      setRecOn(true);
    } catch (e) {
      sysNote("\u26A0\uFE0F Recording failed to start.");
    }
  };
  const genCodeValue = () => {
    const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let c = "";
    for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)];
    return c;
  };
  const genRoomCode = () => setNetRoom(genCodeValue());
  const onRoomKeyDown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!connectingRef.current) joinNet();
  };
  const setAutoSpeakChoice = (v) => {
    autoSpeakTouchedRef.current = true;
    setAutoSpeak(v);
    try {
      localStorage.setItem("slp_autospeak", v ? "1" : "0");
    } catch (e) {
    }
  };
  const pickRole = (r) => {
    netRoleRef.current = r;
    setNetRole(r);
    if (autoSpeakTouchedRef.current) return;
    const v = r === "hearing";
    setAutoSpeak(v);
    try {
      localStorage.setItem("slp_autospeak", v ? "1" : "0");
    } catch (e) {
    }
  };
  const showBigCap = (text) => {
    setBigCap({ text, ts: Date.now() });
    clearTimeout(bigCapTimerRef.current);
    bigCapTimerRef.current = setTimeout(() => setBigCap(null), 4e3);
  };
  const playRoomSign = (text) => {
    setBuilderText(text);
    setRoomSignOn(true);
    clearTimeout(roomSignTimerRef.current);
    roomSignTimerRef.current = setTimeout(() => setRoomSignOn(false), ROOM_SIGN_MAX_MS);
    setTimeout(() => playAvatarSequence(), 250);
  };
  const hasOpenDC = () => Object.values(dcsRef.current).some((dc) => dc && dc.readyState === "open");
  const sysNote = (t) => setNetCaps((p) => [...p.slice(-40), { id: "sys" + Date.now(), text: t, ts: Date.now(), name: "SYSTEM", role: "", kind: "chat" }]);
  const shareRoom = async () => {
    const code = normalizeRoomCode(netRoom);
    const txt = "Sign Room: " + code + (netPin ? " | PIN: " + netPin : "") + "\nOpen " + location.origin + "/?room=" + code + " \u2192 SIGN ROOMS \u2192 JOIN" + (netPin ? " then enter PIN " + netPin : "");
    try {
      await navigator.clipboard.writeText(txt);
    } catch (e) {
      copyText(txt);
    }
    sysNote("\u{1F4CB} Invite copied \u2014 send it to your peer.");
  };
  const peerColor = (id) => {
    let h = 0;
    const s = String(id || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return "hsl(" + h + ",80%,62%)";
  };
  const peerNameOf = (id) => peerNames[id] && peerNames[id].name || (remotePeerInfo.id === id && remotePeerInfo.name || "");
  const clearNetTimers = () => {
    if (hbTimerRef.current) {
      clearInterval(hbTimerRef.current);
      hbTimerRef.current = 0;
    }
    if (wdTimerRef.current) {
      clearInterval(wdTimerRef.current);
      wdTimerRef.current = 0;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = 0;
    }
  };
  const joinNet = async () => {
    const code = normalizeRoomCode(netRoom);
    if (!code) {
      sysNote("\u26A0\uFE0F Enter a room code first.");
      return;
    }
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    try {
      if (!running) await startCamera();
      let self = selfRef.current;
      if (!self) self = "p" + Math.floor(Math.random() * 9e3 + 1e3);
      applySelf(self);
      reconnectWantedRef.current = true;
      startRoomSocket(code, self);
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  };
  const startRoomSocket = (code, self) => {
    clearNetTimers();
    let wsUrl = apiUrlRef.current.replace(/^http/, "ws") + "/ws?room=" + encodeURIComponent(code) + "&client=" + encodeURIComponent(self);
    const pinTxt = (netPin || "").trim();
    if (pinTxt) wsUrl += "&pin=" + encodeURIComponent(pinTxt);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => {
      setNetOn(true);
      reconAttemptsRef.current = 0;
      lastPongRef.current = Date.now();
      netSend({ type: "hello" });
      hbTimerRef.current = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
        } catch (err) {
        }
      }, 15e3);
      wdTimerRef.current = setInterval(() => {
        if (ws.readyState === 1 && Date.now() - lastPongRef.current > 45e3) {
          try {
            ws.close();
          } catch (err) {
          }
        }
      }, 5e3);
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      setNetOn(false);
      if (hbTimerRef.current) {
        clearInterval(hbTimerRef.current);
        hbTimerRef.current = 0;
      }
      if (wdTimerRef.current) {
        clearInterval(wdTimerRef.current);
        wdTimerRef.current = 0;
      }
      if (reconnectWantedRef.current && !reconnectTimerRef.current) {
        const n = (reconAttemptsRef.current || 0) + 1;
        reconAttemptsRef.current = n;
        const delay = Math.min(1e4, 1e3 * Math.pow(2, Math.min(n - 1, 4)));
        sysNote("Reconnecting in " + delay / 1e3 + "s (attempt " + n + ")");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = 0;
          if (reconnectWantedRef.current && selfRef.current === self) startRoomSocket(code, self);
        }, delay);
      }
    };
    ws.onerror = () => {
      if (wsRef.current === ws) setNetOn(false);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (m.from && typeof m.name === "string" && m.name) {
        peerNamesRef.current = { ...peerNamesRef.current, [m.from]: { name: m.name.slice(0, 80), role: m.role === "hearing" ? "hearing" : "deaf" } };
        setPeerNames(peerNamesRef.current);
      }
      if (m.type === "roster") {
        applySelf(m.self);
        const rids = m.ids || [];
        setRoomPeers(rids);
        if (rids.length > 0) {
          sysNote("\u{1F465} Room participants: " + rids.join(", "));
          rids.forEach((rid) => {
            const pc = pcsRef.current[rid];
            if (!pc || pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
              if (pc) cleanupPeer(rid);
              onPeerJoined(rid);
            }
          });
          rids.forEach((rid) => netSend({ type: "hello", to: rid }));
        }
      } else if (m.type === "pong") {
        lastPongRef.current = Date.now();
      } else if (m.type === "hello") {
        peerNamesRef.current = { ...peerNamesRef.current, [m.from]: { name: m.name || "Peer", role: m.role || "" } };
        setPeerNames(peerNamesRef.current);
      } else if (m.type === "room-denied") {
        sysNote("Wrong room PIN.");
        reconnectWantedRef.current = false;
        try {
          ws.close();
        } catch (err) {
        }
      } else if (m.type === "peer-joined") {
        setRoomPeers((p) => p.includes(m.id) ? p : [...p, m.id]);
        sysNote("\u{1F464} Participant joined the room (" + m.id + ")");
        netSend({ type: "hello", to: m.id });
      } else if (m.type === "peer-left") {
        cleanupPeer(m.id);
        sysNote("\u{1F44B} Participant left the room (" + m.id + ")");
      } else if (m.type === "offer") {
        onOffer(m.from, m.sdp);
      } else if (m.type === "answer") {
        onAnswer(m.from, m.sdp);
      } else if (m.type === "candidate") {
        onCandidate(m.from, m.candidate);
      } else if (m.type === "cap") {
        if (markCapSeen(m.mid)) return;
        setNetCaps((p) => [...p.slice(-40), { id: m.from || "peer", text: m.text, ts: Date.now(), name: m.name || "Peer", role: m.role || "", kind: m.kind || "chat" }]);
        if (m.kind !== "chat") {
          showBigCap((m.name ? m.name + ": " : "") + m.text);
        }
        if (shouldSpeakIncoming(m)) speak(m.text);
        if (m.sign) playRoomSign(m.text);
      } else if (m.type === "room-full") {
        sysNote("\u26A0\uFE0F Room is full (max participants reached). Try another code.");
        try {
          ws.close();
        } catch (err) {
        }
      } else if (m.type === "stream_frame") {
        setRemoteFrame(m.image);
        setRemotePeerInfo({ name: m.name || "Participant", role: m.role || "", id: m.from || "" });
        setPeerIds((p) => p.includes(m.from) ? p : [...p, m.from]);
        if (m.from) {
          peerNamesRef.current = { ...peerNamesRef.current, [m.from]: { name: m.name || "Peer", role: m.role || "" } };
          setPeerNames(peerNamesRef.current);
        }
        setPcNote("");
      }
    };
  };
  const leaveNet = () => {
    reconnectWantedRef.current = false;
    clearNetTimers();
    if (recRef2.current) stopRec(true);
    stopRoomSR();
    Object.keys(pcsRef.current).forEach(cleanupPeer);
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {
      }
      wsRef.current = null;
    }
    stopCamera();
    clearTimeout(roomSignTimerRef.current);
    setRoomSignOn(false);
    setNetOn(false);
    setPeerIds([]);
    setRoomPeers([]);
    setNetCaps([]);
    setRemoteFrame(null);
    clearRoomDraft();
    setPcNote("");
    setRoomCamOn(true);
    setRoomMicOn(false);
    setSrActive(false);
  };
  const toggleLang = () => {
    const next = langRef.current === "ar" ? "en" : "ar";
    langRef.current = next;
    setLang(next);
    if (tab === "build") {
      stopAvatarSequence();
      if (micWantRef.current || recRef.current) cancelBuilderVoice();
      buildPosRef.current = 0;
      setBuildPos(0);
    }
  };
  const speak = (t) => {
    if (!t) return;
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(t);
        const target = (langRef.current || lang) === "ar" ? "ar" : "en";
        u.lang = target === "ar" ? "ar-SA" : "en-US";
        u.rate = 0.95;
        const voices = window.speechSynthesis.getVoices();
        if (voices && voices.length > 0) {
          const voice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(target));
          if (voice) u.voice = voice;
        }
        window.speechSynthesis.speak(u);
      } catch (e) {
      }
    }
  };
  const copyText = async (t) => {
    try {
      await navigator.clipboard.writeText(t);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e2) {
      }
      ta.remove();
    }
  };
  const shareText = async (t) => {
    if (navigator.share) {
      try {
        await navigator.share({ text: t });
        return;
      } catch (e) {
      }
    }
    await copyText(t);
  };
  const downloadText = (t, name) => {
    const blob = new Blob([t], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name || "sign-language.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const saveSentence = () => {
    const t = sentence.trim();
    if (!t) return;
    const item = { id: Date.now() + "" + Math.floor(Math.random() * 1e4), text: t, lang, ts: Date.now() };
    setHistory((h) => [item, ...h]);
    lastSaveRef.current = t;
    setSavedFlash(Date.now());
  };
  const clearSentence = () => {
    const t = sentence.trim();
    if (t && t !== lastSaveRef.current) saveSentence();
    setSentence("");
  };
  const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const stopBuilderVoice = () => {
    micWantRef.current = false;
    if (micRestartTimerRef.current) clearTimeout(micRestartTimerRef.current);
    micRestartTimerRef.current = 0;
    const rec = recRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch (e) {
      }
    }
    setMic(false);
  };
  const cancelBuilderVoice = () => {
    micGenRef.current++;
    stopBuilderVoice();
    recRef.current = null;
  };
  const clearBuilder = () => {
    cancelBuilderVoice();
    stopAvatarSequence();
    if (avAutoTimerRef.current) clearTimeout(avAutoTimerRef.current);
    avAutoTimerRef.current = 0;
    builderTextRef.current = "";
    builderVoiceBaseRef.current = "";
    builderVoiceFinalRef.current = "";
    setBuilderText("");
    buildPosRef.current = 0;
    setBuildPos(0);
  };
  const toggleMic = () => {
    if (!SR) {
      setMicMsg("Voice input not supported in this browser");
      return;
    }
    if (micWantRef.current || recRef.current) {
      stopBuilderVoice();
      return;
    }
    const gen = ++micGenRef.current;
    micWantRef.current = true;
    builderVoiceBaseRef.current = builderTextRef.current.trim();
    builderVoiceFinalRef.current = "";
    const applyVoiceText = (interim) => {
      const spoken = mergeSpeechText(builderVoiceFinalRef.current, interim || "");
      const next = appendWords(builderVoiceBaseRef.current, spoken);
      builderTextRef.current = next;
      setBuilderText(next);
    };
    const queueAutoPlay = () => {
      if (!avAutoRef.current) return;
      if (avAutoTimerRef.current) clearTimeout(avAutoTimerRef.current);
      avAutoTimerRef.current = setTimeout(() => {
        avAutoTimerRef.current = 0;
        if (avPlayingRef.current) {
          stopAvatarSequence();
          setTimeout(() => playAvatarSequence(), 0);
        } else playAvatarSequence();
      }, 500);
    };
    const startRec = () => {
      if (!micWantRef.current || gen !== micGenRef.current) return;
      const rec = new SR();
      rec.lang = (langRef.current || lang) === "ar" ? "ar-SA" : "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec._finalsDone = 0;
      rec._interim = "";
      rec.onresult = (ev) => {
        if (gen !== micGenRef.current) return;
        if (ev.results.length < rec._finalsDone) rec._finalsDone = 0;
        let interim = "";
        let gotFinal = false;
        for (let i = rec._finalsDone; i < ev.results.length; i++) {
          const r = ev.results[i];
          const text = (r[0] && r[0].transcript || "").trim();
          if (!text) continue;
          if (r.isFinal) {
            builderVoiceFinalRef.current = mergeSpeechText(builderVoiceFinalRef.current, text);
            rec._finalsDone = i + 1;
            gotFinal = true;
            if (netOnRef.current) sendCap(text, { sign: true });
          } else interim = text;
        }
        const finalText = builderVoiceFinalRef.current.trim();
        let cleanInterim = interim.trim();
        if (finalText && cleanInterim) {
          if (cleanInterim === finalText) cleanInterim = "";
          else if (cleanInterim.startsWith(finalText + " ")) cleanInterim = cleanInterim.slice(finalText.length + 1).trim();
          else if (cleanInterim.startsWith(finalText)) cleanInterim = cleanInterim.slice(finalText.length).trim();
        }
        rec._interim = cleanInterim;
        applyVoiceText(cleanInterim);
        if (gotFinal) queueAutoPlay();
      };
      rec.onerror = (e) => {
        if (gen !== micGenRef.current) return;
        const err = String(e.error || "");
        if (err === "not-allowed" || err === "service-not-allowed") {
          micWantRef.current = false;
          setMic(false);
          setMicMsg("Microphone permission denied \u2014 \u0627\u0633\u0645\u062D \u0628\u0627\u0644\u0645\u0627\u064A\u0643 \u0645\u0646 \u0627\u0644\u0645\u062A\u0635\u0641\u062D");
        } else {
          setMicMsg(err ? "mic: " + err : "");
        }
      };
      rec.onend = () => {
        if (gen !== micGenRef.current) return;
        if (rec._interim) {
          builderVoiceFinalRef.current = mergeSpeechText(builderVoiceFinalRef.current, rec._interim);
          rec._interim = "";
          applyVoiceText("");
          queueAutoPlay();
        }
        if (recRef.current === rec) recRef.current = null;
        if (micWantRef.current) {
          micRestartTimerRef.current = setTimeout(startRec, 350);
        } else {
          setMic(false);
        }
      };
      try {
        rec.start();
        recRef.current = rec;
        setMic(true);
        setMicMsg("");
      } catch (e) {
        if (micWantRef.current && gen === micGenRef.current) {
          micRestartTimerRef.current = setTimeout(startRec, 500);
        }
      }
    };
    startRec();
  };
  useEffect(() => {
    const h = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") {
        e.preventDefault();
        setSentence((s) => s + " ");
      } else if (e.key === "Backspace") {
        e.preventDefault();
        setSentence((s) => s.slice(0, -1));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const buildTokens = useMemo(() => tokenizeText(builderText, lang), [builderText, lang]);
  useEffect(() => {
    builderTokensRef.current = buildTokens;
    buildPosRef.current = 0;
    setBuildPos(0);
    avCancelRef.current = true;
    if (avSleepTimerRef.current) clearTimeout(avSleepTimerRef.current);
    avSleepTimerRef.current = 0;
    if (avSleepResolveRef.current) {
      const resolve = avSleepResolveRef.current;
      avSleepResolveRef.current = null;
      resolve();
    }
  }, [buildTokens]);
  useEffect(() => {
    avHoldRef.current = avHold;
  }, [avHold]);
  useEffect(() => {
    avAutoRef.current = avAuto;
  }, [avAuto]);
  const sleepAv = (ms) => new Promise((resolve) => {
    const finish = () => {
      if (avSleepTimerRef.current) clearTimeout(avSleepTimerRef.current);
      avSleepTimerRef.current = 0;
      avSleepResolveRef.current = null;
      resolve();
    };
    avSleepResolveRef.current = finish;
    avSleepTimerRef.current = setTimeout(finish, ms);
  });
  const stopAvatarSequence = () => {
    avCancelRef.current = true;
    if (avSleepResolveRef.current) avSleepResolveRef.current();
  };
  const playAvatarSequence = useCallback(async () => {
    if (avPlayingRef.current) return;
    const toks = builderTokensRef.current.slice();
    if (!toks.length) return;
    const playLang = langRef.current;
    avPlayingRef.current = true;
    avCancelRef.current = false;
    setAvPlaying(true);
    try {
      for (let i = 0; i < toks.length; i++) {
        if (avCancelRef.current) break;
        const tk = toks[i];
        buildPosRef.current = i;
        setBuildPos(i);
        if (tk.type === "SP") {
          if (avatarApiRef.current && avatarApiRef.current.rest) avatarApiRef.current.rest();
          else if (avatarApiRef.current && avatarApiRef.current.neutral) avatarApiRef.current.neutral();
          setAvCur(null);
          await sleepAv(Math.round(avHoldRef.current * (1.1 + Math.random() * 0.35)));
        } else if (tk.type === "TXT") {
          setAvCur(null);
          await sleepAv(220);
        } else {
          const tbl = playLang === "ar" ? POSES_AR : POSES_EN;
          const ps = tbl[tk.cls] || {};
          setAvCur({ glyph: tk.glyph, name: tk.name });
          if (avatarApiRef.current && avatarApiRef.current.sign) avatarApiRef.current.sign(tk.cls, playLang);
          await sleepAv(Math.round((avHoldRef.current + (ps.m ? 200 : 0)) * (0.88 + Math.random() * 0.28)));
        }
        if (avCancelRef.current) break;
        buildPosRef.current = i + 1;
        setBuildPos(i + 1);
      }
    } finally {
      if (avatarApiRef.current && avatarApiRef.current.neutral) avatarApiRef.current.neutral();
      setAvCur(null);
      setAvPlaying(false);
      avPlayingRef.current = false;
      clearTimeout(roomSignTimerRef.current);
      setRoomSignOn(false);
    }
  }, []);
  useEffect(() => {
    if (tab === "build") return;
    if (micWantRef.current || recRef.current) cancelBuilderVoice();
    if (avPlayingRef.current) stopAvatarSequence();
    if (avAutoTimerRef.current) {
      clearTimeout(avAutoTimerRef.current);
      avAutoTimerRef.current = 0;
    }
  }, [tab]);
  useEffect(() => {
    if (quizPhase !== "run") return;
    const q2 = quizRef.current;
    if (!q2 || q2.timeLimit <= 0) return;
    const id = setInterval(() => {
      const qq = quizRef.current;
      if (!qq) return;
      qq.remaining = Math.max(0, Math.round((qq.qStart + qq.timeLimit * 1e3 - performance.now()) / 1e3));
      if (qq.remaining <= 0) {
        if (qq.pos < qq.goal.length) {
          qq.results.push({ cls: qq.goal[qq.pos], ok: false, ms: qq.timeLimit * 1e3, conf: 0 });
          qq.pos++;
          qq.lastResult = "miss";
          qq.missCls = null;
          qq.qStart = performance.now();
          qq.remaining = qq.timeLimit;
          if (qq.pos >= qq.goal.length) {
            quizPhaseRef.current = "done";
            setQuizPhase("done");
          } else armForExpected(qq);
        }
      }
      setQuizVer((v) => v + 1);
    }, 250);
    return () => clearInterval(id);
  }, [quizPhase]);
  const pickGoals = (lang2, count) => {
    const all = lang2 === "ar" ? AR_CLASSES : EN_CLASSES;
    const cls = all.map((g, i) => g === "DEL" || g === "SPACE" ? -1 : i).filter((i) => i >= 0);
    const arr = [...cls];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return count >= arr.length ? arr : arr.slice(0, count);
  };
  const weakLetters = (lg) => {
    const maxCls = lg === "ar" ? 30 : 25;
    const entries = Object.entries(stats && stats.by || {});
    const scored = [];
    entries.forEach(([k, v]) => {
      const parsed = parseStatKey(k);
      if (!parsed || parsed.lang !== lg) return;
      const cls = parsed.cls;
      if (!(cls >= 0 && cls <= maxCls) || !v || !v.c) return;
      scored.push({ cls, avg: v.n ? v.conf / v.n : 0, c: v.c });
    });
    scored.sort((a, b) => a.avg - b.avg || a.c - b.c);
    return scored.slice(0, 10).map((s) => s.cls);
  };
  const weakCount = weakLetters(quizConfig.lang).length;
  const startQuiz = () => {
    const cfg = quizConfig;
    let goal;
    if (cfg.src === "weak") {
      const wl = weakLetters(cfg.lang).slice();
      if (wl.length >= 3) {
        for (let i = wl.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [wl[i], wl[j]] = [wl[j], wl[i]];
        }
        goal = wl;
      } else {
        goal = pickGoals(cfg.lang, cfg.mode === "practice" ? 999 : cfg.count);
      }
    } else {
      goal = pickGoals(cfg.lang, cfg.mode === "practice" ? 999 : cfg.count);
    }
    const timeLimit = cfg.mode === "practice" ? 0 : cfg.time;
    quizRef.current = { mode: cfg.mode, lang: cfg.lang, goal, pos: 0, results: [], timeLimit, qStart: performance.now(), remaining: timeLimit, okCount: 0, lastResult: null, missCls: null, missAt: 0, startedAt: Date.now() };
    langRef.current = cfg.lang;
    setLang(cfg.lang);
    armForExpected(quizRef.current);
    quizPhaseRef.current = "run";
    setQuizPhase("run");
    setQuizVer((v) => v + 1);
  };
  useEffect(() => {
    if (quizPhase !== "run") return;
    let raf;
    const draw = () => {
      const v = videoRef.current, pv = quizPrevRef.current;
      if (pv) {
        pv.width = 480;
        pv.height = 360;
        const c = pv.getContext("2d");
        c.save();
        c.clearRect(0, 0, 480, 360);
        c.translate(480, 0);
        c.scale(-1, 1);
        if (v && v.readyState >= 2) c.drawImage(v, 0, 0, 480, 360);
        c.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [quizPhase]);
  const skipQuestion = () => {
    const q2 = quizRef.current;
    if (!q2 || q2.pos >= q2.goal.length) return;
    q2.results.push({ cls: q2.goal[q2.pos], ok: false, ms: (q2.timeLimit || 8) * 1e3, conf: 0 });
    q2.pos++;
    q2.lastResult = "miss";
    q2.missCls = null;
    q2.qStart = performance.now();
    q2.remaining = q2.timeLimit;
    if (q2.pos >= q2.goal.length) {
      quizPhaseRef.current = "done";
      setQuizPhase("done");
    } else armForExpected(q2);
    setQuizVer((v) => v + 1);
  };
  const glyphFor = (cls, lang2) => {
    return (lang2 === "ar" ? AR_CLASSES : EN_CLASSES)[cls] || cls;
  };
  const nameFor = (cls, lang2) => {
    if (lang2 === "ar") return AR_NAMES[cls] || cls;
    return cls >= 0 && cls < 26 ? String.fromCharCode(65 + cls) : glyphFor(cls, lang2);
  };
  const hintFor = (cls, lang2) => {
    return lang2 === "ar" ? AR_HINTS[cls] || "" : EN_HINTS[cls] || "";
  };
  const topLetters = (by, lang2, n) => {
    return Object.entries(by || {}).map(([k, v]) => {
      const parsed = parseStatKey(k);
      return parsed ? { parsed, v } : null;
    }).filter((e) => e && e.parsed.lang === lang2).map(({ parsed, v }) => ({ cls: parsed.cls, label: glyphFor(parsed.cls, lang2), count: v.c, avg: v.n ? v.conf / v.n : 0 })).sort((a, b) => b.count - a.count).slice(0, n);
  };
  const sessionMins = Math.max(0.05, (nowTs - sessionStartRef.current) / 6e4);
  const sessionPace = Math.round(sessionRef.current.commits / sessionMins);
  const sessAvgConf = sessionRef.current.confN ? sessionRef.current.confSum / sessionRef.current.confN : 0;
  const lifeAvgConf = stats.confN ? stats.confSum / stats.confN : 0;
  const buildTotal = buildTokens.length;
  const buildCurrent = buildPos < buildTotal ? buildTokens[buildPos] : null;
  const sentenceSugg = suggestWords(sentence, lang);
  const builderSugg = suggestWords(builderText, lang);
  const upSugg = suggestWords(upSentence, lang);
  const q = quizRef.current;
  const sessionTop = topLetters(sessionRef.current.by, lang, 6);
  const lifeTop = topLetters(stats.by, lang, 6);
  return /* @__PURE__ */ React.createElement("div", { className: "app" }, /* @__PURE__ */ React.createElement(
    "video",
    {
      ref: videoRef,
      playsInline: true,
      muted: true,
      autoPlay: true,
      "aria-hidden": "true",
      tabIndex: -1,
      style: {
        position: "fixed",
        top: -9999,
        left: -9999,
        width: 640,
        height: 480,
        opacity: 0,
        pointerEvents: "none",
        zIndex: -1
      }
    }
  ), /* @__PURE__ */ React.createElement("div", { ref: avatarKeeperRef, "aria-hidden": "true", style: { position: "fixed", left: -9999, top: 0, width: 380, height: 300, overflow: "hidden", pointerEvents: "none" } }), (avatarHost || avatarKeeper) && ReactDOM.createPortal(
    /* @__PURE__ */ React.createElement(AvatarView, { apiRef: avatarApiRef }),
    avatarHost || avatarKeeper
  ), /* @__PURE__ */ React.createElement("div", { className: "grid-bg", "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("div", { className: "blob blob-a", "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("div", { className: "blob blob-b", "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("div", { className: "fade", "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("a", { className: "skip-link", href: "#main" }, "Skip to content"), /* @__PURE__ */ React.createElement("header", { className: "hdr" }, /* @__PURE__ */ React.createElement("div", { className: "hdr-in" }, /* @__PURE__ */ React.createElement("div", { className: "brand" }, /* @__PURE__ */ React.createElement("div", { className: "logo", "aria-hidden": "true" }, "DL4"), /* @__PURE__ */ React.createElement("div", { className: "brand-txt" }, /* @__PURE__ */ React.createElement("div", { className: "brand-name" }, "SIGN LANGUAGE ", /* @__PURE__ */ React.createElement("span", { className: "cyan" }, "PLATFORM"), " ", /* @__PURE__ */ React.createElement("span", { className: "badge hide-xs", style: { marginLeft: 8 } }, "PRO")), /* @__PURE__ */ React.createElement("div", { className: "brand-sub" }, "STUDIO + SIGN ROOMS \u2022 TFLITE AR/EN \u2022 WEBRTC"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } }, tab === "net" && netOn && /* @__PURE__ */ React.createElement("span", { className: "badge badge-blue hdr-room", title: "Active room: " + netRoom }, /* @__PURE__ */ React.createElement("span", { className: "dot " + (pcNote ? "dot-amber pulse" : peerIds.length || roomPeers.length ? "dot-green" : "dot-amber pulse"), "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("span", { className: "rc mono" }, netRoom)), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim hide-sm" }, apiUrl.replace(/^https?:\/\//, "")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "dot " + (backend === "online" ? "dot-green" : backend === "offline" ? "dot-red" : "dot-amber") + (backend === "checking" ? " pulse" : ""), "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("span", { className: "mono hide-xs", style: { fontSize: 11, color: "var(--muted)" } }, backend.toUpperCase()), /* @__PURE__ */ React.createElement("span", { className: "sr-only", role: "status" }, "Backend ", backend)), /* @__PURE__ */ React.createElement("button", { className: "btn btn-cyan", title: "Settings", "aria-haspopup": "dialog", onClick: () => setShowSettings(true) }, "\u2699", /* @__PURE__ */ React.createElement("span", { className: "hide-xs" }, "\xA0SETTINGS")), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost nav-toggle", "aria-label": "Open navigation menu", "aria-haspopup": "true", "aria-expanded": navOpen, title: "Menu", onClick: () => setNavOpen(true) }, "\u2630")))), navOpen && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "drawer-overlay", onClick: () => setNavOpen(false), "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("aside", { className: "nav-drawer", role: "dialog", "aria-modal": "true", "aria-label": "Navigation menu" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "MENU"), /* @__PURE__ */ React.createElement("button", { ref: navCloseRef, className: "btn btn-ghost btn-sm", onClick: () => setNavOpen(false) }, "\u2715 CLOSE")), /* @__PURE__ */ React.createElement("nav", { className: "nav-links", "aria-label": "Sections" }, NAV_TABS.map(([id, ic, label]) => /* @__PURE__ */ React.createElement("button", { key: id, className: "nav-link" + (tab === id ? " nav-on" : ""), "aria-current": tab === id ? "page" : void 0, onClick: () => {
    setTab(id);
    setNavOpen(false);
  } }, /* @__PURE__ */ React.createElement("span", { className: "nic", "aria-hidden": "true" }, ic), /* @__PURE__ */ React.createElement("span", null, label)))), /* @__PURE__ */ React.createElement("div", { className: "hr" }), /* @__PURE__ */ React.createElement("button", { className: "nav-link", onClick: () => {
    setNavOpen(false);
    setShowSettings(true);
  } }, /* @__PURE__ */ React.createElement("span", { className: "nic", "aria-hidden": "true" }, "\u2699"), /* @__PURE__ */ React.createElement("span", null, "SETTINGS")), /* @__PURE__ */ React.createElement("div", { className: "mono t10 dim", style: { marginTop: 14, wordBreak: "break-all" } }, apiUrl.replace(/^https?:\/\//, "")), /* @__PURE__ */ React.createElement("div", { className: "row", style: { marginTop: 8, gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "dot " + (backend === "online" ? "dot-green" : backend === "offline" ? "dot-red" : "dot-amber"), "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, backend.toUpperCase()), /* @__PURE__ */ React.createElement("span", { className: "sr-only", role: "status" }, "Backend ", backend)))), /* @__PURE__ */ React.createElement("div", { className: "wrap", id: "main" }, tab !== "net" && /* @__PURE__ */ React.createElement("div", { className: "banner" }, /* @__PURE__ */ React.createElement("span", { className: "tag" }, "SETUP"), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--muted)", fontSize: 12 } }, "Backend ", /* @__PURE__ */ React.createElement("b", { style: { color: "#fff" } }, "python Server.py"), " runs on ", /* @__PURE__ */ React.createElement("b", { style: { color: "#fff" } }, ":8000"), " with CORS enabled. ", /* @__PURE__ */ React.createElement("span", { className: "mono" }, "Space"), " adds a space, ", /* @__PURE__ */ React.createElement("span", { className: "mono" }, "Backspace"), " deletes. ", /* @__PURE__ */ React.createElement("span", { className: "dim" }, "Offline fallback is a diagnostic preview only \u2014 it does not build sentences.")), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim", style: { marginInlineStart: "auto" } }, "AR 33 CLS \u2022 EN 28 CLS")), /* @__PURE__ */ React.createElement("nav", { className: "tabs", "aria-label": "Sections" }, /* @__PURE__ */ React.createElement("button", { className: "tab " + (tab === "sign" ? "tab-on" : ""), "aria-current": tab === "sign" ? "page" : void 0, onClick: () => setTab("sign") }, "SIGN ", /* @__PURE__ */ React.createElement("span", null, "+")), /* @__PURE__ */ React.createElement("button", { className: "tab " + (tab === "upload" ? "tab-on" : ""), "aria-current": tab === "upload" ? "page" : void 0, onClick: () => setTab("upload") }, "UPLOAD & SIGN"), /* @__PURE__ */ React.createElement("button", { className: "tab " + (tab === "net" ? "tab-on" : ""), "aria-current": tab === "net" ? "page" : void 0, onClick: () => setTab("net") }, "SIGN ROOMS"), /* @__PURE__ */ React.createElement("button", { className: "tab " + (tab === "build" ? "tab-on" : ""), "aria-current": tab === "build" ? "page" : void 0, onClick: () => setTab("build") }, "TEXT TO SIGN"), /* @__PURE__ */ React.createElement("button", { className: "tab " + (tab === "quiz" ? "tab-on" : ""), "aria-current": tab === "quiz" ? "page" : void 0, onClick: () => setTab("quiz") }, "LEARN & QUIZ"), /* @__PURE__ */ React.createElement("button", { className: "tab " + (tab === "alpha" ? "tab-on" : ""), "aria-current": tab === "alpha" ? "page" : void 0, onClick: () => setTab("alpha") }, "ALPHABET"), /* @__PURE__ */ React.createElement("button", { className: "tab " + (tab === "history" ? "tab-on" : ""), "aria-current": tab === "history" ? "page" : void 0, onClick: () => setTab("history") }, "HISTORY \u2022 STATS")), tab === "sign" && /* @__PURE__ */ React.createElement("div", { className: "grid-main" }, /* @__PURE__ */ React.createElement("div", { className: "space-y", style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { className: "card glow", style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { className: "card-head" }, /* @__PURE__ */ React.createElement("div", { className: "head-side" }, /* @__PURE__ */ React.createElement("span", { className: "dot", style: { background: "var(--cyan)", boxShadow: "0 0 10px rgba(0,212,255,.8)" } }), /* @__PURE__ */ React.createElement("span", { className: "mono t11 mono-up", style: { color: "var(--muted)" } }, "Live MediaPipe Feed \u2022 Mirrored"), /* @__PURE__ */ React.createElement("span", { className: "badge " + (tracking ? "badge-blue" : ""), style: { background: tracking ? "var(--blueDim)" : "rgba(255,255,255,.04)", borderColor: tracking ? "rgba(30,127,224,.35)" : "var(--line)" } }, tracking ? "HAND TRACKING" : "NO HAND")), /* @__PURE__ */ React.createElement("div", { className: "head-side" }, /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, fps, " FPS"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, "BUFFER ", bufferLen, "/", WINDOW))), /* @__PURE__ */ React.createElement("div", { className: "feed" }, /* @__PURE__ */ React.createElement("div", { className: "feed-wrap" }, /* @__PURE__ */ React.createElement("canvas", { ref: canvasRef }), !running && /* @__PURE__ */ React.createElement("div", { className: "center-overlay" }, /* @__PURE__ */ React.createElement("div", { className: "logo-lg" }, "DL4"), /* @__PURE__ */ React.createElement("h2", null, "Real Backend Connected Camera"), /* @__PURE__ */ React.createElement("p", null, "Start camera \u2192 MediaPipe extracts 21 landmarks \u2192 63 features \u2192 23-frame window \u2192 POST /predict \u2192 TFLite \u2192 letter"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-white btn-lg", style: { marginTop: 18 }, onClick: startCamera }, "START CAMERA"), log && /* @__PURE__ */ React.createElement("p", { style: { color: "var(--bad)", marginTop: 12, fontSize: 11, fontFamily: "JetBrains Mono,monospace" } }, log)), /* @__PURE__ */ React.createElement("div", { className: "feed-bar" }, /* @__PURE__ */ React.createElement("i", { style: { width: bufferLen / WINDOW * 100 + "%" } })), running && pred && /* @__PURE__ */ React.createElement("div", { className: "predbadge", role: "status", "aria-live": "polite" }, /* @__PURE__ */ React.createElement("span", { className: "t10 dim" }, "PRED"), /* @__PURE__ */ React.createElement("b", null, pred.letter), /* @__PURE__ */ React.createElement("span", { className: "conf " + (pred.confidence >= 0.8 ? "conf-ok" : "conf-warn") }, Math.round(pred.confidence * 100), "%")), /* @__PURE__ */ React.createElement("div", { className: "feed-top-right" }, /* @__PURE__ */ React.createElement("span", { className: "feed-chip" }, tracking ? "21 LANDMARKS" : "\u2014 LANDMARKS"), /* @__PURE__ */ React.createElement("span", { className: "feed-chip" }, lang === "ar" ? "AR 33 CLS" : "EN 28 CLS")))), /* @__PURE__ */ React.createElement("div", { className: "feed-foot" }, running ? /* @__PURE__ */ React.createElement("button", { className: "btn btn-danger", onClick: stopCamera }, "STOP") : /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", onClick: startCamera }, "START CAMERA"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: () => {
    bufferRef.current = [];
    stabRef.current = newStab();
    travelRef.current = { n: 0, flushed: false };
    setBufferLen(0);
    predShownRef.current = { l: null, c: -1 };
    setPred(null);
  } }, "CLEAR BUFFER"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim", style: { marginInlineStart: "auto" } }, lang === "ar" ? "\u0627\u0644\u0648\u0636\u0639" : "MODE", ": ", lang === "ar" ? "ARABIC" : "ENGLISH"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: toggleLang, style: { background: lang === "ar" ? "var(--cyanDim)" : "#fff", color: lang === "ar" ? "var(--cyan)" : "#000", borderColor: lang === "ar" ? "rgba(38,208,255,.3)" : "#fff", fontWeight: 700 } }, lang === "ar" ? "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 AR" : "ENGLISH EN")), backend === "offline" && /* @__PURE__ */ React.createElement("div", { style: { margin: "0 14px 14px", padding: "10px 14px", borderRadius: 12, border: "1px solid rgba(251,191,36,.2)", background: "var(--warnDim)", fontSize: 11, color: "var(--warn)", fontFamily: "JetBrains Mono,monospace", lineHeight: 1.6 } }, "Backend offline \u2014 run ", /* @__PURE__ */ React.createElement("b", null, "python Server.py"), " on port 8000. The finger-count fallback is shown as a ", /* @__PURE__ */ React.createElement("b", null, "diagnostic preview only"), ": it cannot identify real AR/EN signs, so it never writes letters into the sentence or the stats.")), pred && pred.top3 && pred.top3.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "TOP 3 PREDICTIONS")), /* @__PURE__ */ React.createElement("div", { className: "chips" }, pred.top3.map((t, i) => /* @__PURE__ */ React.createElement("span", { key: i, className: "chip " + (i === 0 ? "chip-cyan" : "") }, t.letter, " ", t.eng || "", " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.6 } }, Math.round((t.conf || 0) * 100), "%"))))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "PIPELINE")), [["BROWSER", "MediaPipe 21 landmarks"], ["EXTRACT", "63 features flat x,y,z"], ["BUFFER", WINDOW + " frames window"], ["POST", "/predict {sequence, language}"], ["TFLITE", (lang === "ar" ? "arsl" : "asl") + "_model.tflite"], ["LETTER", "Return letter + confidence"]].map(([k, v], i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "pipe-step" }, k), /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true", style: { flex: "1 0 28px", height: 1, background: "linear-gradient(90deg,rgba(255,255,255,.1),transparent)" } }), /* @__PURE__ */ React.createElement("span", { className: "pipe-val" }, v))))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { className: "card glow-cyan card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "PREDICTION"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "LETTER \u2022 CLASS ", pred ? pred.class_id : "-")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 18 } }, /* @__PURE__ */ React.createElement("div", { role: "status", "aria-live": "polite", style: { width: 84, height: 84, borderRadius: 16, background: "var(--bg2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: pred ? 72 : 22, lineHeight: 1 }, dir: lang === "ar" ? "rtl" : "ltr" }, pred ? pred.letter : "\u2014"), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { className: "mono t11 dim" }, pred ? pred.name : "No prediction yet"), /* @__PURE__ */ React.createElement("div", { className: "prog", style: { marginTop: 12 } }, /* @__PURE__ */ React.createElement("i", { style: { width: Math.round((pred ? pred.confidence : 0) * 100) + "%" } })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 6 } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "CONFIDENCE"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, pred ? Math.round(pred.confidence * 100) : 0, "%"))))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "SENTENCE BUILDER"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", rowGap: 4, justifyContent: "flex-end" } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim", style: { marginRight: 2 } }, "SPEED"), ["smooth", "fast", "turbo"].map((spd) => /* @__PURE__ */ React.createElement("button", { key: spd, className: "btn btn-sm " + (speed === spd ? "btn-primary" : "btn-ghost"), onClick: () => setSpeed(spd), style: { textTransform: "uppercase", fontSize: 11, padding: "4px 10px" } }, spd)), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => setDebug((d) => !d) }, debug ? "HIDE DEBUG" : "DEBUG"))), /* @__PURE__ */ React.createElement("div", { dir: lang === "ar" ? "rtl" : "ltr", className: "textarea " + (sentence ? "" : ""), style: { minHeight: 72, color: sentence ? "#fff" : "var(--faint)", background: "var(--bg2)" } }, sentence || (lang === "ar" ? "\u0627\u0643\u062A\u0628 \u062C\u0645\u0644\u0629 \u0628\u0644\u063A\u0629 \u0627\u0644\u0625\u0634\u0627\u0631\u0629..." : "Start signing to build sentence...")), sentenceSugg.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10 } }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Word Suggestions"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, sentenceSugg.map((wd, i) => /* @__PURE__ */ React.createElement("button", { key: i, className: "chip chip-cyan", onClick: () => setSentence((s) => replaceLastWord(s, wd.w) + " ") }, wd.w, " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.6 } }, "\u2014 ", wd.m))))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, display: "flex", flexWrap: "wrap", gap: 7 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => setSentence((s) => s + " ") }, "SPACE"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => setSentence((s) => s.slice(0, -1)) }, "DEL"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: clearSentence }, "CLEAR"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", style: { flex: "1 1 auto", minWidth: 50 }, onClick: saveSentence }, "SAVE"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => copyText(sentence) }, "COPY"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => shareText(sentence) }, "SHARE"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-cyan", style: { flex: "1 1 auto", minWidth: 72, marginInlineStart: "auto" }, onClick: () => speak(sentence) }, "SPEAK")), savedFlash > 0 && /* @__PURE__ */ React.createElement("div", { className: "mono t10 good", style: { marginTop: 8 } }, "Saved to history"), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "dot dot-green pulse" }), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "Commit: ", SPEED_PRESETS[speed].stab, " settled frames. Every letter is taken exactly once \u2014 to repeat the same letter, release the sign (or drop the hand) and show it again. Min conf ", Math.round(confGate * 100), "%. Moving hands are skipped."))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "MODEL DETAILS \u2022 CNN+BiLSTM")), /* @__PURE__ */ React.createElement("div", { className: "grid-cols-2" }, /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "DATASET"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, "ArSL + ASL"), /* @__PURE__ */ React.createElement("div", { className: "s" }, "sobhyyy / Sign-Language-Translator")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "FEATURES"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, "21\xD73=63"), /* @__PURE__ */ React.createElement("div", { className: "s" }, "MediaPipe landmarks")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "SEQUENCE"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, WINDOW, " timesteps"), /* @__PURE__ */ React.createElement("div", { className: "s" }, "flushed at each sign boundary")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "MODEL"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, lang === "ar" ? "33 cls" : "28 cls"), /* @__PURE__ */ React.createElement("div", { className: "s" }, "TFLite quantized"))), modelInfo && /* @__PURE__ */ React.createElement("div", { className: "mono t11", style: { marginTop: 12, padding: 12, borderRadius: 12, background: "var(--bg2)", border: "1px solid var(--line)", color: "var(--muted)", lineHeight: 1.8 } }, modelInfo.ar && /* @__PURE__ */ React.createElement("div", null, "AR input ", JSON.stringify(modelInfo.ar.input), " output ", JSON.stringify(modelInfo.ar.output)), modelInfo.en && /* @__PURE__ */ React.createElement("div", null, "EN input ", JSON.stringify(modelInfo.en.input), " output ", JSON.stringify(modelInfo.en.output)))))), tab === "upload" && /* @__PURE__ */ React.createElement("div", { className: "grid-main" }, /* @__PURE__ */ React.createElement("div", { className: "space-y", style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { className: "card glow", style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { className: "card-head" }, /* @__PURE__ */ React.createElement("div", { className: "head-side" }, /* @__PURE__ */ React.createElement("span", { className: "dot", style: { background: "var(--cyan)", boxShadow: "0 0 10px rgba(0,212,255,.8)" } }), /* @__PURE__ */ React.createElement("span", { className: "mono t11 mono-up", style: { color: "var(--muted)" } }, "Upload Video \u2022 Frame-by-Frame MediaPipe"), /* @__PURE__ */ React.createElement("span", { className: "badge " + (upTracking ? "badge-blue" : ""), style: { background: upTracking ? "var(--blueDim)" : "rgba(255,255,255,.04)", borderColor: upTracking ? "rgba(30,127,224,.35)" : "var(--line)" } }, upTracking ? "HAND TRACKING" : "NO HAND")), /* @__PURE__ */ React.createElement("div", { className: "head-side" }, /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, upFps, " FPS"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, "BUFFER ", upBufferLen, "/", WINDOW))), !upUrl ? /* @__PURE__ */ React.createElement("div", { style: { padding: "16px" } }, /* @__PURE__ */ React.createElement("div", { className: "up-dropzone" + (upDragOver ? " drag-over" : ""), onDragOver: handleUpDragOver, onDragLeave: handleUpDragLeave, onDrop: handleUpDrop, onClick: () => upFileInputRef.current && upFileInputRef.current.click(), role: "button", tabIndex: 0, "aria-label": "Upload video dropzone", onKeyDown: (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      upFileInputRef.current && upFileInputRef.current.click();
    }
  } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 36, marginBottom: 10 }, "aria-hidden": "true" }, "\u{1F4E4}"), /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 800, fontSize: 15 } }, "Drag & drop video here"), /* @__PURE__ */ React.createElement("div", { className: "mono t11 dim", style: { marginTop: 4 } }, "or click to browse"), /* @__PURE__ */ React.createElement("div", { style: { display: "inline-flex", gap: 7, flexWrap: "wrap", justifyContent: "center", marginTop: 10 } }, /* @__PURE__ */ React.createElement("span", { className: "chip" }, ".mp4"), /* @__PURE__ */ React.createElement("span", { className: "chip" }, ".webm"), /* @__PURE__ */ React.createElement("span", { className: "chip" }, ".mov")), /* @__PURE__ */ React.createElement("input", { ref: upFileInputRef, type: "file", accept: ".mp4,.webm,.mov,video/mp4,video/webm,video/quicktime", onClick: (e) => e.stopPropagation(), onChange: handleUpFileChange, style: { display: "none" } }), /* @__PURE__ */ React.createElement("div", { className: "row", style: { marginTop: 12, gap: 8, justifyContent: "center", flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, lang === "ar" ? "\u0627\u0644\u0648\u0636\u0639" : "MODE", ": ", lang === "ar" ? "ARABIC" : "ENGLISH"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: (e) => {
    e.stopPropagation();
    toggleLang();
  }, title: "Switch recognition model language", style: { background: lang === "ar" ? "var(--cyanDim)" : "#fff", color: lang === "ar" ? "var(--cyan)" : "#000", borderColor: lang === "ar" ? "rgba(38,208,255,.3)" : "#fff", fontWeight: 700 } }, lang === "ar" ? "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 AR" : "ENGLISH EN")), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 12 } }, "Max ~120 MB \u2022 H.264 recommended \u2022 Same pipeline as live SIGN")), upLog && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, padding: "10px 14px", borderRadius: 12, border: "1px solid rgba(251,191,36,.2)", background: "var(--warnDim)", fontSize: 11, color: "var(--warn)", fontFamily: "JetBrains Mono,monospace" } }, upLog)) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "up-video-wrap" }, /* @__PURE__ */ React.createElement("video", { ref: upVideoRef, src: upUrl, playsInline: true, preload: "metadata", crossOrigin: "anonymous", onLoadedMetadata: upOnLoadedMetadata, onTimeUpdate: upOnTimeUpdate, onPlay: upOnPlay, onPause: upOnPause, onEnded: upOnEnded, onError: upOnVideoError, onSeeked: upOnSeeked, controls: false, style: {} }), /* @__PURE__ */ React.createElement("canvas", { ref: upCanvasRef, "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("div", { className: "feed-bar" }, /* @__PURE__ */ React.createElement("i", { style: { width: upBufferLen / WINDOW * 100 + "%" } })), upPred && /* @__PURE__ */ React.createElement("div", { className: "predbadge", role: "status", "aria-live": "polite" }, /* @__PURE__ */ React.createElement("span", { className: "t10 dim" }, "PRED"), /* @__PURE__ */ React.createElement("b", null, upPred.letter), /* @__PURE__ */ React.createElement("span", { className: "conf " + (upPred.confidence >= 0.8 ? "conf-ok" : "conf-warn") }, Math.round(upPred.confidence * 100), "%")), /* @__PURE__ */ React.createElement("div", { className: "feed-top-right" }, /* @__PURE__ */ React.createElement("span", { className: "feed-chip" }, upTracking ? "21 LANDMARKS" : "\u2014 LANDMARKS"), /* @__PURE__ */ React.createElement("span", { className: "feed-chip" }, lang === "ar" ? "AR 33 CLS" : "EN 28 CLS"), upProcessing && /* @__PURE__ */ React.createElement("span", { className: "feed-chip", style: { background: "var(--cyanDim)", borderColor: "rgba(38,208,255,.32)", color: "var(--cyan)" } }, "\u25CF ANALYZING")), !upPlaying && /* @__PURE__ */ React.createElement("div", { className: "center-overlay", style: { background: "radial-gradient(ellipse at center,rgba(0,0,0,.55),transparent 70%)", pointerEvents: "none" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 28 } }, "\u23F8"), /* @__PURE__ */ React.createElement("div", { className: "mono t11", style: { color: "#fff", marginTop: 6 } }, "Paused"))), /* @__PURE__ */ React.createElement("div", { className: "feed-foot" }, /* @__PURE__ */ React.createElement("button", { className: "btn " + (upPlaying ? "btn-danger" : "btn-primary"), onClick: upTogglePlay }, upPlaying ? "PAUSE" : "PLAY"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: upReset }, "RESET"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: clearUpBuffer }, "CLEAR BUFFER"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: clearUpVideo }, "CHANGE VIDEO"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim", style: { marginInlineStart: "auto" } }, lang === "ar" ? "\u0627\u0644\u0648\u0636\u0639" : "MODE", ": ", lang === "ar" ? "ARABIC" : "ENGLISH"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: toggleLang, title: "Switch recognition model language", style: { background: lang === "ar" ? "var(--cyanDim)" : "#fff", color: lang === "ar" ? "var(--cyan)" : "#000", borderColor: lang === "ar" ? "rgba(38,208,255,.3)" : "#fff", fontWeight: 700 } }, lang === "ar" ? "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 AR" : "ENGLISH EN"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, formatTime(upCurrentTime), " / ", formatTime(upDuration)), /* @__PURE__ */ React.createElement("select", { value: upMirror, onChange: (e) => setUpMirror(e.target.value), className: "input", style: { width: "auto", minWidth: 132, height: 32, borderRadius: 99, padding: "0 10px", fontSize: 12 }, "aria-label": "Source hand orientation", title: "Set this to MIRRORED for selfie-recorded clips if letters come out wrong" }, /* @__PURE__ */ React.createElement("option", { value: "auto" }, "HAND: AUTO"), /* @__PURE__ */ React.createElement("option", { value: "mirrored" }, "HAND: MIRRORED")), /* @__PURE__ */ React.createElement("select", { value: upPlaybackRate, onChange: (e) => upHandleSpeed(e.target.value), className: "input", style: { width: "auto", minWidth: 72, height: 32, borderRadius: 99, padding: "0 10px", fontSize: 12 }, "aria-label": "Playback speed" }, /* @__PURE__ */ React.createElement("option", { value: 0.5 }, "0.5\xD7"), /* @__PURE__ */ React.createElement("option", { value: 1 }, "1\xD7"), /* @__PURE__ */ React.createElement("option", { value: 2 }, "2\xD7"))), /* @__PURE__ */ React.createElement("div", { style: { padding: "10px 14px", background: "rgba(10,14,20,.6)", borderTop: "1px solid var(--line2)" } }, /* @__PURE__ */ React.createElement("input", { type: "range", className: "up-seek", min: 0, max: upDuration || 0, step: 0.05, value: Math.min(upCurrentTime, upDuration || 0), onChange: (e) => upHandleSeek(e.target.value), "aria-label": "Seek video" }), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 6 } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, formatTime(upCurrentTime)), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, formatTime(upDuration))), /* @__PURE__ */ React.createElement("div", { className: "up-timeline", style: { marginTop: 8 } }, /* @__PURE__ */ React.createElement("div", { className: "up-timeline-track", style: { flex: 1, position: "relative", height: 6 } }, /* @__PURE__ */ React.createElement("div", { className: "up-timeline-progress", style: { width: (upDuration ? upCurrentTime / upDuration * 100 : 0) + "%" } }), upTimeline.map((m, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "up-timeline-marker", style: { left: (upDuration ? m.t / upDuration * 100 : 0) + "%" }, title: `${m.letter} @ ${formatTime(m.t)} (${Math.round(m.confidence * 100)}%)` }, /* @__PURE__ */ React.createElement("span", { className: "up-timeline-cap" }, m.letter))))), upLog && /* @__PURE__ */ React.createElement("div", { className: "mono t11", style: { marginTop: 8, color: "var(--warn)", background: "var(--warnDim)", border: "1px solid rgba(251,191,36,.18)", padding: "6px 10px", borderRadius: 8 } }, upLog)))), upPred && upPred.top3 && upPred.top3.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "TOP 3 PREDICTIONS")), /* @__PURE__ */ React.createElement("div", { className: "chips" }, upPred.top3.map((t, i) => /* @__PURE__ */ React.createElement("span", { key: i, className: "chip " + (i === 0 ? "chip-cyan" : "") }, t.letter, " ", t.eng || "", " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.6 } }, Math.round((t.conf || 0) * 100), "%")))))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { className: "card glow-cyan card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "PREDICTION"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "LETTER \u2022 CLASS ", upPred ? upPred.class_id : "-")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 18 } }, /* @__PURE__ */ React.createElement("div", { role: "status", "aria-live": "polite", style: { width: 84, height: 84, borderRadius: 16, background: "var(--bg2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: upPred ? 72 : 22, lineHeight: 1 }, dir: lang === "ar" ? "rtl" : "ltr" }, upPred ? upPred.letter : "\u2014"), /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { className: "mono t11 dim" }, upPred ? upPred.name : "No prediction yet"), /* @__PURE__ */ React.createElement("div", { className: "prog", style: { marginTop: 12 } }, /* @__PURE__ */ React.createElement("i", { style: { width: Math.round((upPred ? upPred.confidence : 0) * 100) + "%" } })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginTop: 6 } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "CONFIDENCE"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, upPred ? Math.round(upPred.confidence * 100) : 0, "%"))))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "SENTENCE BUILDER"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", rowGap: 4, justifyContent: "flex-end" } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim", style: { marginRight: 2 } }, "SPEED"), ["smooth", "fast", "turbo"].map((spd) => /* @__PURE__ */ React.createElement("button", { key: spd, className: "btn btn-sm " + (speed === spd ? "btn-primary" : "btn-ghost"), onClick: () => setSpeed(spd), style: { textTransform: "uppercase", fontSize: 11, padding: "4px 10px" } }, spd)))), /* @__PURE__ */ React.createElement("div", { dir: lang === "ar" ? "rtl" : "ltr", className: "textarea " + (upSentence ? "" : ""), style: { minHeight: 72, color: upSentence ? "#fff" : "var(--faint)", background: "var(--bg2)" } }, upSentence || (lang === "ar" ? "\u062D\u0645\u0651\u0644 \u0641\u064A\u062F\u064A\u0648 \u0648\u0634\u063A\u0651\u0644\u0647 \u0644\u0628\u0646\u0627\u0621 \u0627\u0644\u062C\u0645\u0644\u0629..." : "Upload and play a video to build the sentence...")), upSugg.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10 } }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Word Suggestions"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, upSugg.map((wd, i) => /* @__PURE__ */ React.createElement("button", { key: i, className: "chip chip-cyan", onClick: () => setUpSentence((s) => replaceLastWord(s, wd.w) + " ") }, wd.w, " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.6 } }, "\u2014 ", wd.m))))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, display: "flex", flexWrap: "wrap", gap: 7 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => setUpSentence((s) => s + " ") }, "SPACE"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => setUpSentence((s) => s.slice(0, -1)) }, "DEL"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: clearUpSentence }, "CLEAR"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", style: { flex: "1 1 auto", minWidth: 50 }, onClick: saveUpSentence }, "SAVE"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => copyText(upSentence) }, "COPY"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 50 }, onClick: () => shareText(upSentence) }, "SHARE"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-cyan", style: { flex: "1 1 auto", minWidth: 72, marginInlineStart: "auto" }, onClick: () => speak(upSentence) }, "SPEAK")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, display: "flex", flexWrap: "wrap", gap: 7 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "1 1 auto", minWidth: 72 }, onClick: () => downloadText(upSentence, "upload-sign.txt") }, "EXPORT .TXT"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim", style: { alignSelf: "center", marginInlineStart: "auto" } }, "Letters ", upTimeline.length, " \u2022 ", lang === "ar" ? "AR" : "EN")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, display: "flex", alignItems: "center", gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "dot dot-green pulse" }), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "Commit: ", SPEED_PRESETS[speed].stab, " settled frames \u2022 each letter taken once \u2022 Min conf ", Math.round(confGate * 100), "% \u2022 Video ", upPlaying ? "playing" : "paused")), upLog && /* @__PURE__ */ React.createElement("div", { className: "mono t10", style: { marginTop: 8, color: "var(--warn)" } }, upLog)), upTimeline.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "CAPTION TRACK"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => setUpTimeline([]) }, "CLEAR TRACK")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 140, overflowY: "auto", paddingRight: 2 } }, upTimeline.map((m, i) => /* @__PURE__ */ React.createElement("button", { key: i, className: "chip chip-cyan", title: `${formatTime(m.t)} \u2014 ${Math.round(m.confidence * 100)}%`, onClick: () => {
    const v = upVideoRef.current;
    if (v) {
      v.currentTime = m.t;
    }
  } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, formatTime(m.t)), " ", m.letter))), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 8 } }, "Tap a marker to seek. Timeline is 1:1 with video progress above.")), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "PIPELINE")), [["BROWSER", "MediaPipe 21 landmarks"], ["EXTRACT", "63 features flat x,y,z"], ["BUFFER", WINDOW + " frames window"], ["POST", "/predict {sequence, language}"], ["TFLITE", (lang === "ar" ? "arsl" : "asl") + "_model.tflite"], ["LETTER", "Return letter + confidence"]].map(([k, v], i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "pipe-step" }, k), /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true", style: { flex: "1 0 28px", height: 1, background: "linear-gradient(90deg,rgba(255,255,255,.1),transparent)" } }), /* @__PURE__ */ React.createElement("span", { className: "pipe-val" }, v))), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 8 } }, "Same AI pipeline as live SIGN \u2014 23-frame sliding window, stability filter and confidence gate applied per-frame.")))), tab === "net" && /* @__PURE__ */ React.createElement("div", { className: "grid-main room-grid", dir: "ltr" }, (!isMobile || !netOn) && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, /* @__PURE__ */ React.createElement("div", { className: "card glow", style: { overflow: "hidden" } }, !netOn ? /* @__PURE__ */ React.createElement("div", { style: { padding: "22px" } }, /* @__PURE__ */ React.createElement("div", { className: "panel-title", style: { marginBottom: 6 } }, /* @__PURE__ */ React.createElement("h3", null, "SIGN ROOMS"), /* @__PURE__ */ React.createElement("span", { className: "badge" }, connecting ? "CONNECTING\u2026" : serverOnline ? "SERVER ONLINE" : "SERVER OFFLINE")), /* @__PURE__ */ React.createElement("p", { className: "muted", style: { fontSize: 13, marginBottom: 16 } }, "Live video rooms for deaf & hearing communication. Create a room, share the code, then talk with signs, voice or text."), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex", style: { marginBottom: 14, gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim mono-up", style: { width: "100%" } }, "YOU ARE"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (netRole === "deaf" ? "chip-cyan" : ""), onClick: () => pickRole("deaf") }, "\u270B DEAF \u2014 I sign"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (netRole === "hearing" ? "chip-cyan" : ""), onClick: () => pickRole("hearing") }, "\u{1F5E3} HEARING \u2014 I speak"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (autoSpeak ? "chip-green" : ""), title: "Read every incoming message from your peer aloud on this device", onClick: () => setAutoSpeakChoice(!autoSpeak) }, "\u{1F50A} AUTO-SPEAK: ", autoSpeak ? "ON" : "OFF"), /* @__PURE__ */ React.createElement("input", { className: "input grow", style: { minWidth: 140, maxWidth: 220 }, value: netName, onChange: (e) => {
    netNameRef.current = e.target.value;
    setNetName(e.target.value);
  }, placeholder: "Display name", autoCapitalize: "words", autoComplete: "off" })), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex", style: { gap: 8 } }, /* @__PURE__ */ React.createElement("input", { className: "input", style: { flex: "1 1 120px", maxWidth: 160, letterSpacing: 3, textAlign: "center", fontWeight: 700 }, maxLength: 8, value: netRoom, onChange: (e) => setNetRoom(normalizeRoomCode(e.target.value)), onKeyDown: onRoomKeyDown, placeholder: "ROOM CODE", autoCapitalize: "characters", autoCorrect: "off", spellCheck: false, enterKeyHint: "go" }), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "0 0 auto" }, onClick: genRoomCode }, "\u{1F3B2} GENERATE"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", style: { flex: "0 0 auto" }, onClick: shareRoom }, "\u{1F4CB} COPY INVITE"), /* @__PURE__ */ React.createElement("input", { className: "input", style: { flex: "1 1 110px", maxWidth: 140 }, maxLength: 12, value: netPin, onChange: (e) => setNetPin(e.target.value), onKeyDown: onRoomKeyDown, placeholder: "PIN (\u0627\u062E\u062A\u064A\u0627\u0631\u064A)", title: "Lock this room with a PIN", autoCorrect: "off", spellCheck: false, enterKeyHint: "go" }), /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary btn-lg", style: { flex: "1 1 140px" }, disabled: connecting, onClick: joinNet }, connecting ? "CONNECTING\u2026" : "\u{1F4DE} JOIN ROOM")), connecting && /* @__PURE__ */ React.createElement("div", { className: "row", style: { marginTop: 12, gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "dot dot-amber pulse" }), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, "Connecting \u2014 your camera will start automatically\u2026")), /* @__PURE__ */ React.createElement("details", { style: { marginTop: 14 } }, /* @__PURE__ */ React.createElement("summary", { className: "mono t10 dim", style: { cursor: "pointer" } }, "Advanced: TURN relay"), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10 } }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "TURN relay (for mobile / strict networks)"), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex", style: { gap: 8 } }, /* @__PURE__ */ React.createElement("input", { className: "input grow", style: { minWidth: 140 }, value: turnUrl, onChange: (e) => setTurnUrl(e.target.value), placeholder: "turn:global.turn.metered.ca:80", autoCorrect: "off", spellCheck: false }), /* @__PURE__ */ React.createElement("input", { className: "input", style: { flex: "1 1 100px", maxWidth: 140 }, value: turnUser, onChange: (e) => setTurnUser(e.target.value), placeholder: "username", autoCorrect: "off", spellCheck: false }), /* @__PURE__ */ React.createElement("input", { className: "input", style: { flex: "1 1 100px", maxWidth: 140 }, type: "password", value: turnCred, onChange: (e) => setTurnCred(e.target.value), placeholder: "credential", autoCorrect: "off", spellCheck: false })), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 6 } }, "Leave these empty to use the TURN relay configured on the server automatically (env vars). To override, create a free account at ", /* @__PURE__ */ React.createElement("b", null, "metered.ca"), " and paste your own TURN URL, username, and credential.")), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex", style: { marginTop: 12, gap: 8 } }, /* @__PURE__ */ React.createElement("span", { className: "dot " + (serverOnline ? "dot-green" : "dot-red") }), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, serverOnline ? "SERVER ONLINE" : "SERVER OFFLINE"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "\u2022 server address lives in SETTINGS"))), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 14 } }, "Camera starts automatically when you join. Share the code \u2014 your peer presses JOIN and you are connected.")) : /* @__PURE__ */ React.createElement("div", { style: { padding: "16px" } }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 10 } }, /* @__PURE__ */ React.createElement(RoomStatusBar, { netRoom, pcNote, peerIds, roomPeers, onInvite: shareRoom })), /* @__PURE__ */ React.createElement(
    RoomStage,
    {
      viewMode,
      stageWrapRef,
      localStream,
      streamRef,
      roomCamOn,
      canvasRef,
      netName,
      peerIds,
      remoteStreamsMap,
      remoteStreamsRef,
      webrtcConnectedMap,
      remoteFrame,
      roomPeers,
      netRoom,
      roomMuted,
      onAutoplayBlocked: handleRemoteAutoplayBlocked,
      remoteVideoElRef,
      peerColor,
      peerNameOf,
      remotePeerInfo,
      bigCap,
      signOn: roomSignOn
    }
  ), /* @__PURE__ */ React.createElement(
    RoomControlsBar,
    {
      isMobile: false,
      roomMicOn,
      toggleRoomMic,
      roomCamOn,
      toggleRoomCam,
      flipRoomCam,
      roomMuted,
      toggleRoomSound,
      viewMode,
      setViewMode,
      toggleStageFullscreen,
      recOn,
      toggleRec,
      leaveNet
    }
  )))), isMobile && netOn ? /* @__PURE__ */ React.createElement(MobilePortal, { mobile: isMobile }, /* @__PURE__ */ React.createElement("div", { className: "room-shell" + (chatOpen ? " chat-open" : ""), dir: "ltr" }, /* @__PURE__ */ React.createElement(RoomStatusBar, { netRoom, pcNote, peerIds, roomPeers, onInvite: shareRoom }), /* @__PURE__ */ React.createElement("div", { className: "shell-stage" }, /* @__PURE__ */ React.createElement(
    RoomStage,
    {
      viewMode,
      stageWrapRef,
      localStream,
      streamRef,
      roomCamOn,
      canvasRef,
      netName,
      peerIds,
      remoteStreamsMap,
      remoteStreamsRef,
      webrtcConnectedMap,
      remoteFrame,
      roomPeers,
      netRoom,
      roomMuted,
      onAutoplayBlocked: handleRemoteAutoplayBlocked,
      remoteVideoElRef,
      peerColor,
      peerNameOf,
      remotePeerInfo,
      bigCap,
      overlay: liveSub,
      signOn: roomSignOn
    }
  )), /* @__PURE__ */ React.createElement(ChatSheet, { open: chatOpen, setOpen: setChatOpen, caps: netCaps, unread: chatUnread }, /* @__PURE__ */ React.createElement(
    RoomChatCard,
    {
      netCaps,
      setNetCaps,
      srActive,
      srPreview,
      lang,
      setLang,
      roomDraft,
      typeRoomDraft,
      clearRoomDraft,
      srSupported: !!getSRClass(),
      startRoomSR,
      stopRoomSR,
      sendRoomDraft,
      netRole,
      netOn
    }
  )), /* @__PURE__ */ React.createElement(
    RoomControlsBar,
    {
      isMobile: true,
      chatOpen,
      setChatOpen,
      moreOpen,
      setMoreOpen,
      hasUnread: chatUnread > 0,
      roomMicOn,
      toggleRoomMic,
      roomCamOn,
      toggleRoomCam,
      flipRoomCam,
      roomMuted,
      toggleRoomSound,
      viewMode,
      setViewMode,
      srActive,
      srSupported: !!getSRClass(),
      startRoomSR,
      stopRoomSR,
      toggleStageFullscreen,
      recOn,
      toggleRec,
      leaveNet
    }
  ), /* @__PURE__ */ React.createElement(
    RoomMoreSheet,
    {
      open: moreOpen,
      onClose: () => setMoreOpen(false),
      flipRoomCam,
      roomMuted,
      toggleRoomSound,
      viewMode,
      setViewMode,
      srActive,
      srSupported: !!getSRClass(),
      startRoomSR,
      stopRoomSR,
      toggleStageFullscreen,
      recOn,
      toggleRec
    }
  ))) : /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, /* @__PURE__ */ React.createElement(
    RoomChatCard,
    {
      netCaps,
      setNetCaps,
      srActive,
      srPreview,
      lang,
      setLang,
      roomDraft,
      typeRoomDraft,
      clearRoomDraft,
      srSupported: !!getSRClass(),
      startRoomSR,
      stopRoomSR,
      sendRoomDraft,
      netRole,
      netOn
    }
  ))), tab === "build" && /* @__PURE__ */ React.createElement("div", { className: "grid-main" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad glow" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "TEXT TO SIGN \u2022 REVERSE MODE"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, lang === "ar" ? "\u0627\u0643\u062A\u0628 \u0627\u0644\u0646\u0635 \u0628\u0627\u0644\u0639\u0631\u0628\u064A\u0629" : "TYPE TEXT IN ENGLISH")), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex", style: { marginBottom: 10 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: toggleLang }, lang === "ar" ? "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 AR" : "ENGLISH EN"), /* @__PURE__ */ React.createElement("button", { className: "btn " + (mic ? "btn-danger mic-live" : "btn-ghost"), onClick: toggleMic, disabled: !SR }, mic ? "STOP VOICE" : "VOICE INPUT"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: () => speak(builderText), disabled: !builderText.trim() }, "SPEAK"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-danger", onClick: clearBuilder, disabled: !builderText && !mic }, "CLEAR"), micMsg && /* @__PURE__ */ React.createElement("span", { className: "mono t10 bad" }, micMsg)), /* @__PURE__ */ React.createElement("textarea", { className: "textarea", dir: lang === "ar" ? "rtl" : "ltr", value: builderText, onChange: (e) => {
    if (micWantRef.current || recRef.current) cancelBuilderVoice();
    builderTextRef.current = e.target.value;
    setBuilderText(e.target.value);
  }, placeholder: lang === "ar" ? "\u0627\u0643\u062A\u0628 \u062C\u0645\u0644\u0629 \u0648\u0633\u064A\u062A\u0645 \u062A\u062D\u0648\u064A\u0644\u0647\u0627 \u0644\u0633\u0644\u0633\u0644\u0629 \u0625\u0634\u0627\u0631\u0627\u062A..." : "Type a sentence to convert into a sign sequence..." }), builderSugg.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10 } }, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Word Suggestions"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, builderSugg.map((wd, i) => /* @__PURE__ */ React.createElement("button", { key: i, className: "chip chip-cyan", onClick: () => {
    if (micWantRef.current || recRef.current) cancelBuilderVoice();
    setBuilderText((prev) => replaceLastWord(prev, wd.w) + " ");
  } }, wd.w, " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.6 } }, "\u2014 ", wd.m))))), /* @__PURE__ */ React.createElement("div", { className: "tokens", dir: lang === "ar" ? "rtl" : "ltr" }, buildTokens.map((tk, i) => {
    let cls = "token";
    if (tk.type === "SP") cls = "token token-sp";
    else if (tk.type === "TXT") cls = "token token-txt";
    else if (i < buildPos) cls = "token token-done";
    else if (i === buildPos) cls = "token token-cur";
    return /* @__PURE__ */ React.createElement("div", { key: i, className: cls }, /* @__PURE__ */ React.createElement("span", null, tk.glyph), /* @__PURE__ */ React.createElement("span", { className: "lab" }, tk.type === "CLA" && tk.name && tk.name !== tk.glyph ? tk.name : ""));
  }), buildTokens.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "empty", style: { width: "100%" } }, lang === "ar" ? "\u0644\u0627 \u064A\u0648\u062C\u062F \u0646\u0635 \u0628\u0639\u062F" : "No text yet")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14 } }, /* @__PURE__ */ React.createElement("div", { className: "between row", style: { marginBottom: 6 } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "SIGNED ", Math.min(buildPos, buildTotal), "/", buildTotal), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, buildTotal ? Math.round(Math.min(buildPos, buildTotal) / buildTotal * 100) : 0, "%")), /* @__PURE__ */ React.createElement("div", { className: "prog" }, /* @__PURE__ */ React.createElement("i", { style: { width: (buildTotal ? Math.min(buildPos, buildTotal) / buildTotal * 100 : 0) + "%" } }))), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 14, minHeight: 44 }, dir: lang === "ar" ? "rtl" : "ltr" }, buildCurrent ? /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("b", { style: { color: "var(--cyan)" } }, buildCurrent.name), " \u2014 ", buildCurrent.hint) : buildTotal ? /* @__PURE__ */ React.createElement("span", { className: "muted" }, "\u0623\u0643\u0645\u0644\u062A \u0627\u0644\u0633\u0644\u0633\u0644\u0629 \u2014 All tokens signed.") : /* @__PURE__ */ React.createElement("span", { className: "dim" }, "Type text above to see its sign sequence. Turn on camera in the SIGN tab to practice \u2014 each correct sign auto-advances.")), /* @__PURE__ */ React.createElement("div", { className: "hr" }), /* @__PURE__ */ React.createElement("div", { className: "between row" }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "Suggestion: sign letter by letter. Space = new word."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => {
    setTab("sign");
  } }, "OPEN CAMERA"))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "HOW IT WORKS")), /* @__PURE__ */ React.createElement("div", { className: "mono t11 muted", style: { lineHeight: 1.9 } }, "1. Type (or speak) a sentence.", /* @__PURE__ */ React.createElement("br", null), "2. Each character becomes a sign token card.", /* @__PURE__ */ React.createElement("br", null), "3. Start the camera and sign each letter.", /* @__PURE__ */ React.createElement("br", null), "4. Matching signs are marked green and auto-advance.", /* @__PURE__ */ React.createElement("br", null), "5. Words from the dictionary appear as quick chips.", /* @__PURE__ */ React.createElement("br", null), "6. Press PLAY SIGNS and the 3D avatar performs the whole sentence."))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad glow" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "3D AVATAR \u2022 TEXT/SPEECH TO SIGN"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, lang === "ar" ? "ARSL 33 POSES" : "ASL 28 POSES")), /* @__PURE__ */ React.createElement("div", { className: "avatar-slot", id: "av-host-build" }), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex", style: { marginTop: 12 } }, !avPlaying ? /* @__PURE__ */ React.createElement("button", { className: "btn btn-cyan", onClick: playAvatarSequence, disabled: !buildTokens.some((t) => t.type === "CLA") }, "PLAY SIGNS") : /* @__PURE__ */ React.createElement("button", { className: "btn btn-danger", onClick: stopAvatarSequence }, "STOP"), /* @__PURE__ */ React.createElement("button", { className: "btn " + (avAuto ? "btn-primary" : "btn-ghost"), onClick: () => setAvAuto((a) => !a) }, avAuto ? "AUTO AFTER VOICE: ON" : "AUTO AFTER VOICE: OFF"), /* @__PURE__ */ React.createElement("div", { className: "row", style: { marginLeft: "auto", gap: 6 } }, [400, 650, 900].map((ms) => /* @__PURE__ */ React.createElement("button", { key: ms, className: "btn btn-sm " + (avHold === ms ? "btn-primary" : "btn-ghost"), onClick: () => setAvHold(ms) }, ms, "ms")))), /* @__PURE__ */ React.createElement("div", { className: "mono t10 dim", style: { marginTop: 8, minHeight: 16 } }, avCur ? "SIGNING: " + avCur.glyph + " \u2022 " + avCur.name : avPlaying ? "Preparing..." : "Type or speak a sentence, then press PLAY SIGNS"), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 6 } }, "If the camera is also running, hand tracking may advance tokens at the same time.")), /* @__PURE__ */ React.createElement("div", { className: "card card-pad glow-cyan" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "LIVE PREVIEW"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, running ? "CAMERA ON" : "CAMERA OFF")), /* @__PURE__ */ React.createElement("div", { dir: lang === "ar" ? "rtl" : "ltr", className: "textarea", style: { minHeight: 96, color: pred ? "#fff" : "var(--faint)" } }, pred ? pred.letter : "\u2014"), /* @__PURE__ */ React.createElement("div", { className: "mono t10 dim", style: { marginTop: 8 } }, tracking ? "Hand tracking active \u2014 signing will auto-advance the sequence." : "Camera not running. Open the SIGN tab to start."), !running && /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", style: { marginTop: 12 }, onClick: startCamera }, "START CAMERA")), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "QUICK WORDS")), /* @__PURE__ */ React.createElement("div", { className: "chips" }, (lang === "ar" ? AR_WORDS : EN_WORDS).map((wd, i) => /* @__PURE__ */ React.createElement("button", { key: i, className: "chip", onClick: () => {
    if (micWantRef.current || recRef.current) cancelBuilderVoice();
    setBuilderText((prev) => appendWords(prev, wd.w));
  } }, wd.w, " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.6 } }, "\u2014 ", wd.m))))))), tab === "quiz" && quizPhase === "config" && /* @__PURE__ */ React.createElement("div", { className: "card card-pad", style: { maxWidth: 640, margin: "0 auto" } }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "LEARN & QUIZ"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "PRACTICE YOUR SIGNING")), /* @__PURE__ */ React.createElement("div", { className: "grid-cols-2" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Language"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, /* @__PURE__ */ React.createElement("button", { className: "chip " + (quizConfig.lang === "ar" ? "chip-cyan" : ""), onClick: () => setQuizConfig((c) => ({ ...c, lang: "ar" })) }, "\u0627\u0644\u0639\u0631\u0628\u064A\u0629"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (quizConfig.lang === "en" ? "chip-cyan" : ""), onClick: () => setQuizConfig((c) => ({ ...c, lang: "en" })) }, "English"))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Mode"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, /* @__PURE__ */ React.createElement("button", { className: "chip " + (quizConfig.mode === "quiz" ? "chip-cyan" : ""), onClick: () => setQuizConfig((c) => ({ ...c, mode: "quiz" })) }, "TIMED QUIZ"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (quizConfig.mode === "practice" ? "chip-cyan" : ""), onClick: () => setQuizConfig((c) => ({ ...c, mode: "practice" })) }, "FREE PRACTICE"))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Source"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, /* @__PURE__ */ React.createElement("button", { className: "chip " + (quizConfig.src === "all" ? "chip-cyan" : ""), onClick: () => setQuizConfig((cc) => ({ ...cc, src: "all" })) }, "ALL SIGNS"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (quizConfig.src === "weak" ? "chip-cyan" : ""), disabled: weakCount < 3, title: weakCount < 3 ? "Need some practice stats first" : "", onClick: () => setQuizConfig((cc) => ({ ...cc, src: "weak" })) }, "MY WEAK (", weakCount, ")")), quizConfig.src === "weak" && /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 6 } }, "Built from your lowest-confidence letters in STATS."))), /* @__PURE__ */ React.createElement("div", { className: "grid-cols-2", style: { marginTop: 16 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Questions"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, [5, 8, 12].map((n) => /* @__PURE__ */ React.createElement("button", { key: n, className: "chip " + (quizConfig.count === n ? "chip-cyan" : ""), onClick: () => setQuizConfig((c) => ({ ...c, count: n })) }, n)), /* @__PURE__ */ React.createElement("button", { className: "chip " + (quizConfig.count === 99 ? "chip-cyan" : ""), onClick: () => setQuizConfig((c) => ({ ...c, count: 99 })) }, "ALL"))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Seconds / letter"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, [8, 10, 15].map((n) => /* @__PURE__ */ React.createElement("button", { key: n, className: "chip " + (quizConfig.time === n ? "chip-cyan" : ""), onClick: () => setQuizConfig((c) => ({ ...c, time: n })) }, n, "s"))))), /* @__PURE__ */ React.createElement("div", { className: "hr" }), /* @__PURE__ */ React.createElement("div", { className: "between row" }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, quizConfig.mode === "practice" ? "Practice loops through letters \u2014 advance on correct sign." : "Answer before the timer runs out. Score = correct / total."), /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary btn-lg", onClick: startQuiz }, "START"))), tab === "quiz" && quizPhase === "run" && q && /* @__PURE__ */ React.createElement("div", { className: "grid-main" }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad glow-cyan", style: { textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { className: "quiz-target " + (q.lastResult === "ok" ? "flash-ok" : q.lastResult === "miss" ? "flash-miss" : "") }, /* @__PURE__ */ React.createElement("div", { className: "mono t10 dim", style: { letterSpacing: "0.2em" } }, q.mode === "practice" ? "FREE PRACTICE" : "TIMED QUIZ", " \u2022 Q ", Math.min(q.pos + 1, q.goal.length), "/", q.goal.length), /* @__PURE__ */ React.createElement("div", { className: "glyph" }, glyphFor(q.goal[q.pos], q.lang)), /* @__PURE__ */ React.createElement("div", { className: "nm" }, nameFor(q.goal[q.pos], q.lang)), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 8 } }, hintFor(q.goal[q.pos], q.lang))), q.timeLimit > 0 && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 16 } }, /* @__PURE__ */ React.createElement("div", { className: "between row", style: { marginBottom: 6 } }, /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "TIME LEFT"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, q.remaining, "s")), /* @__PURE__ */ React.createElement("div", { className: "prog" }, /* @__PURE__ */ React.createElement("i", { style: { width: q.remaining / q.timeLimit * 100 + "%" } }))), /* @__PURE__ */ React.createElement("div", { className: "row", style: { justifyContent: "center", gap: 10, marginTop: 18 } }, pred && /* @__PURE__ */ React.createElement("span", { className: "chip" }, pred.letter, " ", Math.round(pred.confidence * 100), "%"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: skipQuestion }, "SKIP"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-danger", onClick: () => {
    quizRef.current = null;
    setQuizPhase("config");
  } }, "QUIT"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad", style: { overflow: "hidden" } }, /* @__PURE__ */ React.createElement("div", { className: "card-head" }, /* @__PURE__ */ React.createElement("div", { className: "head-side" }, /* @__PURE__ */ React.createElement("span", { className: "badge " + (tracking ? "badge-blue" : ""), style: { background: tracking ? "var(--blueDim)" : "rgba(255,255,255,.04)", borderColor: tracking ? "rgba(30,127,224,.35)" : "var(--line)" } }, tracking ? "HAND TRACKING" : "NO HAND"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, running ? "CAMERA ON" : "CAMERA OFF")), running ? /* @__PURE__ */ React.createElement("button", { className: "btn btn-danger btn-sm", onClick: stopCamera }, "STOP CAMERA") : /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary btn-sm", onClick: startCamera }, "START CAMERA")), /* @__PURE__ */ React.createElement("div", { className: "feed-wrap", style: { height: "clamp(180px, 32dvh, 270px)", background: "var(--bg2)" } }, /* @__PURE__ */ React.createElement("canvas", { ref: quizPrevRef, style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } }), !running && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, background: "rgba(10,14,20,.5)" } }, /* @__PURE__ */ React.createElement("div", { className: "mono t11 dim" }, "Camera off"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", onClick: startCamera }, "START CAMERA")))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "SCOREBOARD"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, "OK ", q.okCount, " / ", q.goal.length)), /* @__PURE__ */ React.createElement("div", { className: "prog" }, /* @__PURE__ */ React.createElement("i", { style: { width: q.okCount / Math.max(1, q.goal.length) * 100 + "%" } })), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, display: "flex", gap: 6, flexWrap: "wrap" } }, q.results.map((r, i) => /* @__PURE__ */ React.createElement("span", { key: i, className: "chip " + (r.ok ? "chip-green" : "chip-red") }, glyphFor(r.cls, q.lang))))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "LIVE")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "LAST PREDICTION"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 26 } }, pred ? pred.letter : "\u2014"), /* @__PURE__ */ React.createElement("div", { className: "s" }, tracking ? "hand detected" : "no hand"))))), tab === "quiz" && quizPhase === "done" && q && /* @__PURE__ */ React.createElement("div", { className: "card card-pad", style: { maxWidth: 680, margin: "0 auto" } }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "QUIZ RESULTS"), /* @__PURE__ */ React.createElement("span", { className: "mono t10 dim" }, q.lang === "ar" ? "ARABIC" : "ENGLISH")), /* @__PURE__ */ React.createElement("div", { style: { textAlign: "center", padding: "18px 0" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 64, fontWeight: 900, color: "var(--cyan)", letterSpacing: "-0.03em" } }, Math.round(q.okCount / q.goal.length * 100), "%"), /* @__PURE__ */ React.createElement("div", { className: "mono t12 muted" }, q.okCount, " correct out of ", q.goal.length, " \u2022 avg ", (q.results.length ? q.results.reduce((a, r) => a + (r.ms || 0), 0) / q.results.length : 0).toFixed(0), "ms/letter")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(84px,1fr))", gap: 8 } }, q.results.map((r, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { borderRadius: 12, border: "1px solid " + (r.ok ? "rgba(52,211,153,.3)" : "rgba(239,68,68,.3)"), background: r.ok ? "var(--goodDim)" : "var(--badDim)", padding: 10, textAlign: "center" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 22, fontWeight: 800 } }, glyphFor(r.cls, q.lang)), /* @__PURE__ */ React.createElement("div", { className: "mono t10 " + (r.ok ? "good" : "bad") }, r.ok ? "CORRECT" : "MISSED", " \u2022 ", (r.ms / 1e3).toFixed(1), "s")))), /* @__PURE__ */ React.createElement("div", { className: "between row", style: { marginTop: 18 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost", onClick: () => setQuizPhase("config") }, "NEW QUIZ"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary", onClick: startQuiz }, "RETRY SAME"))), tab === "alpha" && /* @__PURE__ */ React.createElement("div", { className: "grid-main" }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "SIGN ALPHABET"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, /* @__PURE__ */ React.createElement("button", { className: "chip " + (lang === "ar" ? "chip-cyan" : ""), onClick: () => {
    langRef.current = "ar";
    setLang("ar");
    setAvCur(null);
    if (avatarApiRef.current && avatarApiRef.current.neutral) avatarApiRef.current.neutral();
  } }, "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 (33)"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (lang === "en" ? "chip-cyan" : ""), onClick: () => {
    langRef.current = "en";
    setLang("en");
    setAvCur(null);
    if (avatarApiRef.current && avatarApiRef.current.neutral) avatarApiRef.current.neutral();
  } }, "ENGLISH (26)"))), /* @__PURE__ */ React.createElement("p", { className: "hint", style: { marginBottom: 14 } }, "\u0627\u0636\u063A\u0637 \u0623\u064A \u062D\u0631\u0641 \u0648\u0627\u0644\u0623\u0641\u0627\u062A\u0627\u0631 \u0647\u064A\u0645\u062B\u0651\u0644\u0647 \u0641\u0648\u0631\u064B\u0627 \u2014 Click any card and the avatar performs the sign."), /* @__PURE__ */ React.createElement("div", { className: "alpha-grid", dir: lang === "ar" ? "rtl" : "ltr" }, (lang === "ar" ? AR_ALPHA_ORDER : EN_ALPHA_ORDER).map((cls, i) => {
    const g = (lang === "ar" ? AR_CLASSES : EN_CLASSES)[cls];
    return /* @__PURE__ */ React.createElement("button", { key: i, className: "alpha-card" + (avCur && avCur.glyph === g ? " alpha-on" : ""), onClick: () => {
      if (avatarApiRef.current && avatarApiRef.current.sign) avatarApiRef.current.sign(cls, lang);
      setAvCur({ glyph: g, name: nameFor(cls, lang) });
    } }, /* @__PURE__ */ React.createElement("span", { className: "ag" }, g), /* @__PURE__ */ React.createElement("span", { className: "an" }, nameFor(cls, lang)), /* @__PURE__ */ React.createElement("span", { className: "ah" }, (lang === "ar" ? AR_HINTS : EN_HINTS)[cls]));
  }))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad glow" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "LIVE PREVIEW"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, avCur ? avCur.glyph + " \u2022 " + avCur.name : "\u2014")), /* @__PURE__ */ React.createElement("div", { className: "avatar-slot", id: "av-host-alpha" }), /* @__PURE__ */ React.createElement("div", { className: "mono t10 dim", style: { marginTop: 8, minHeight: 16 } }, avCur ? "SIGNING: " + avCur.glyph + " \u2022 " + avCur.name : "Pick a letter from the gallery.")))), tab === "history" && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 20 } }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad", style: { maxWidth: 820, margin: "0 auto", width: "100%" } }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "TRANSLATION HISTORY ", history.length ? "\u2022 " + history.length : ""), /* @__PURE__ */ React.createElement("div", { className: "row" }, history.length > 0 && /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => downloadText(history.map((h) => "[" + new Date(h.ts).toLocaleString() + "] (" + (h.lang === "ar" ? "AR" : "EN") + ") " + h.text).join("\n"), "sign-language-history.txt") }, "DOWNLOAD .TXT"), history.length > 0 && /* @__PURE__ */ React.createElement("button", { className: "btn btn-danger btn-sm", onClick: () => setHistory([]) }, "CLEAR ALL"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, history.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "empty" }, "No saved sentences yet. Sign and hit SAVE in the Sign tab."), history.map((h) => /* @__PURE__ */ React.createElement("div", { key: h.id, className: "hist-item" }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 180 } }, /* @__PURE__ */ React.createElement("div", { className: "hist-text", dir: h.lang === "ar" ? "rtl" : "ltr" }, h.text), /* @__PURE__ */ React.createElement("div", { className: "hist-meta", style: { marginTop: 4 } }, h.lang === "ar" ? "\u0627\u0644\u0639\u0631\u0628\u064A\u0629" : "ENGLISH", " \u2022 ", new Date(h.ts).toLocaleString())), /* @__PURE__ */ React.createElement("div", { className: "row", style: { flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => copyText(h.text) }, "COPY"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => speak(h.text) }, "SPEAK"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => {
    const hl = h.lang === "en" ? "en" : "ar";
    langRef.current = hl;
    setLang(hl);
    setBuilderText(h.text);
    buildPosRef.current = 0;
    setBuildPos(0);
    setTab("build");
  } }, "TO SIGNS"), /* @__PURE__ */ React.createElement("button", { className: "btn btn-danger btn-sm", onClick: () => setHistory((prev) => prev.filter((x) => x.id !== h.id)) }, "DEL")))))), /* @__PURE__ */ React.createElement("div", { className: "grid-3" }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "SESSION TIME")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "ACTIVE"), /* @__PURE__ */ React.createElement("div", { className: "v" }, Math.floor(sessionMins), ":", String(Math.floor((nowTs - sessionStartRef.current) % 6e4 / 1e3)).padStart(2, "0")), /* @__PURE__ */ React.createElement("div", { className: "s" }, "this session"))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "SESSION COMMITS")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "SIGNS"), /* @__PURE__ */ React.createElement("div", { className: "v" }, sessionRef.current.commits), /* @__PURE__ */ React.createElement("div", { className: "s" }, "pace ", sessionPace, "/min"))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "AVG CONFIDENCE")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "SESSION"), /* @__PURE__ */ React.createElement("div", { className: "v" }, Math.round(sessAvgConf * 100), "%"), /* @__PURE__ */ React.createElement("div", { className: "s" }, "lifetime ", Math.round(lifeAvgConf * 100), "%")))), /* @__PURE__ */ React.createElement("div", { className: "grid-3" }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "LETTERS USED")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "SESSION"), /* @__PURE__ */ React.createElement("div", { className: "v" }, Object.keys(sessionRef.current.by).length), /* @__PURE__ */ React.createElement("div", { className: "s" }, "distinct signs"))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "LIFETIME")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "ALL TIME"), /* @__PURE__ */ React.createElement("div", { className: "v" }, stats.commits), /* @__PURE__ */ React.createElement("div", { className: "s" }, "commits"))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "BUFFER")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "WINDOW"), /* @__PURE__ */ React.createElement("div", { className: "v" }, bufferLen, "/", WINDOW), /* @__PURE__ */ React.createElement("div", { className: "s" }, fps, " fps \u2022 ", tracking ? "hand" : "no hand")))), /* @__PURE__ */ React.createElement("div", { className: "grid-main", style: { margin: 0 } }, /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "TOP SIGNED LETTERS \u2022 SESSION")), sessionTop.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "empty" }, "No signs this session \u2014 start signing!"), sessionTop.map((t, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "bar-row" }, /* @__PURE__ */ React.createElement("span", { className: "bar-label" }, t.label, " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.5 } }, nameFor(t.cls, lang))), /* @__PURE__ */ React.createElement("div", { className: "bar-track" }, /* @__PURE__ */ React.createElement("div", { className: "bar-fill", style: { width: t.count / sessionTop[0].count * 100 + "%" } })), /* @__PURE__ */ React.createElement("span", { className: "bar-val" }, t.count, " \u2022 ", Math.round(t.avg * 100), "%")))), /* @__PURE__ */ React.createElement("div", { className: "card card-pad" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "TOP SIGNED LETTERS \u2022 LIFETIME")), lifeTop.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "empty" }, "No lifetime data yet."), lifeTop.map((t, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "bar-row" }, /* @__PURE__ */ React.createElement("span", { className: "bar-label" }, t.label, " ", /* @__PURE__ */ React.createElement("span", { style: { opacity: 0.5 } }, nameFor(t.cls, lang))), /* @__PURE__ */ React.createElement("div", { className: "bar-track" }, /* @__PURE__ */ React.createElement("div", { className: "bar-fill", style: { width: t.count / lifeTop[0].count * 100 + "%" } })), /* @__PURE__ */ React.createElement("span", { className: "bar-val" }, t.count, " \u2022 ", Math.round(t.avg * 100), "%"))))))), showSettings && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "drawer-overlay", onClick: () => setShowSettings(false), "aria-hidden": "true" }), /* @__PURE__ */ React.createElement("aside", { className: "drawer", role: "dialog", "aria-modal": "true", "aria-label": "Settings" }, /* @__PURE__ */ React.createElement("div", { className: "panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "SETTINGS"), /* @__PURE__ */ React.createElement("button", { ref: settingsCloseRef, className: "btn btn-ghost btn-sm", onClick: () => setShowSettings(false) }, "\u2715 CLOSE")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 24 } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Commit speed"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, [["smooth", 8], ["fast", 4], ["turbo", 2]].map(([name]) => /* @__PURE__ */ React.createElement("button", { key: name, className: "chip " + (speed === name ? "chip-cyan" : ""), onClick: () => setSpeed(name) }, name.toUpperCase(), " \u2022 ", SPEED_PRESETS[name].stab, " frames")))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Confidence gate"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, [["Low", 0.5], ["Medium", 0.6], ["High", 0.8]].map(([n, v]) => /* @__PURE__ */ React.createElement("button", { key: n, className: "chip " + (confGate === v ? "chip-green" : ""), onClick: () => setConfGate(v) }, n, " \u2022 ", Math.round(v * 100), "%")))), "              ", /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Smart input"), /* @__PURE__ */ React.createElement("div", { className: "chips" }, /* @__PURE__ */ React.createElement("button", { className: "chip " + (autoSpace ? "chip-green" : ""), onClick: () => setAutoSpace((v) => !v) }, "AUTO-SPACE: ", autoSpace ? "ON" : "OFF"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (autoWord ? "chip-green" : ""), onClick: () => setAutoWord((v) => !v) }, "AUTO-WORD: ", autoWord ? "ON" : "OFF"), /* @__PURE__ */ React.createElement("button", { className: "chip " + (smoothConf ? "chip-green" : ""), onClick: () => setSmoothConf((v) => !v) }, "SMOOTHING: ", smoothConf ? "ON" : "OFF")), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 6 } }, "AUTO-SPACE adds a space when your hand pauses \xB7 AUTO-WORD completes dictionary words \xB7 SMOOTHING steadies confidence.")), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Model"), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex" }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-primary btn-sm", onClick: () => {
    setModelLoading(true);
    fetch(apiUrlRef.current + "/models").then((r) => r.json()).then((d) => {
      setModelInfo(d);
      setModelLoading(false);
    }).catch(() => {
      setModelLoading(false);
    });
  } }, "\u21BB RELOAD MODEL INFO"), modelLoading && /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, "loading\u2026")), modelInfo && /* @__PURE__ */ React.createElement("div", { className: "mono t11 dim", style: { marginTop: 10, lineHeight: 1.9 } }, modelInfo.ar && /* @__PURE__ */ React.createElement("div", null, "AR in/out: ", JSON.stringify(modelInfo.ar.input), " / ", JSON.stringify(modelInfo.ar.output)), modelInfo.en && /* @__PURE__ */ React.createElement("div", null, "EN in/out: ", JSON.stringify(modelInfo.en.input), " / ", JSON.stringify(modelInfo.en.output)))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Server address (API URL)"), /* @__PURE__ */ React.createElement("div", { className: "row wrap-flex" }, /* @__PURE__ */ React.createElement("input", { className: "input grow", style: { minWidth: 170 }, value: apiUrl, onChange: (e) => setApiUrl(e.target.value), placeholder: "https://your-app.onrender.com" }), /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: checkHealth }, "CHECK")), /* @__PURE__ */ React.createElement("div", { className: "hint", style: { marginTop: 6 } }, "Default is this page's own origin. Change it only to point at a different backend server.")), /* @__PURE__ */ React.createElement("details", null, /* @__PURE__ */ React.createElement("summary", { className: "mono t11 dim", style: { cursor: "pointer" } }, "Developer diagnostics"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14, marginTop: 12 } }, /* @__PURE__ */ React.createElement("div", { className: "grid-cols-2" }, /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "PIPELINE"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, running ? "RUNNING" : "STOPPED"), /* @__PURE__ */ React.createElement("div", { className: "s" }, "tracking ", tracking ? "yes" : "no", " \u2022 predicting ", predicting ? "yes" : "no")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "BUFFER"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, bufferLen, "/", WINDOW), /* @__PURE__ */ React.createElement("div", { className: "s" }, "stability ", stabRef.current.cur ? '"' + stabRef.current.cur + '" x' + stabRef.current.count : "none")), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "LANGUAGE"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, lang === "ar" ? "AR (33)" : "EN (28)"), /* @__PURE__ */ React.createElement("div", { className: "s" }, "reverse pos ", buildPos, "/", buildTotal)), /* @__PURE__ */ React.createElement("div", { className: "stat-tile" }, /* @__PURE__ */ React.createElement("span", { className: "k" }, "BACKEND"), /* @__PURE__ */ React.createElement("div", { className: "v", style: { fontSize: 16 } }, backend.toUpperCase()), /* @__PURE__ */ React.createElement("div", { className: "s" }, apiUrl))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "label" }, "Raw features \u2022 last 63"), /* @__PURE__ */ React.createElement("div", { className: "mono t11", style: { color: "var(--muted)", lineHeight: 1.8, wordBreak: "break-all", maxHeight: 160, overflow: "auto", background: "var(--bg2)", border: "1px solid var(--line)", borderRadius: 12, padding: 10 } }, raw.length ? raw.map((v) => v.toFixed(3)).join(", ") : "No hand data yet."), /* @__PURE__ */ React.createElement("div", { className: "row", style: { marginTop: 8 } }, /* @__PURE__ */ React.createElement("button", { className: "btn btn-ghost btn-sm", onClick: () => setRaw([]) }, "REFRESH"), /* @__PURE__ */ React.createElement("span", { className: "mono t11 dim" }, modelInfo ? "model info ok" : "model info fetching..."))))), /* @__PURE__ */ React.createElement("div", { className: "hint" }, "Speed and confidence control when a signed letter is committed into the sentence (SIGN tab). Higher confidence = fewer wrong letters.")))), /* @__PURE__ */ React.createElement("footer", { className: "footer" }, /* @__PURE__ */ React.createElement("div", { className: "wrap", style: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 } }, /* @__PURE__ */ React.createElement("span", null, "DIGILIANS LAB4 \u2022 Sign Language Platform \u2022 Studio + Sign Rooms \u2022 Real TFLite inference via FastAPI"), /* @__PURE__ */ React.createElement("span", null, "Backend ", apiUrl, "/predict"))));
}

window.__SLP_BUNDLED=1;
try {
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
} catch (e) {
  if (window.__SLP_RENDER_FATAL) { window.__SLP_RENDER_FATAL(e); } else { throw e; }
}
