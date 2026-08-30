const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'app.html'),'utf8');
const match=html.match(/<script type="text\/plain" id="app-source">([\s\S]*?)<\/script>/);
if(!match) throw new Error('app-source not found');
const src=match[1];
let fails=0;
const ok=m=>console.log('PASS: '+m);
const bad=m=>{fails++;console.log('FAIL: '+m);};

function grab(name){
  const start=src.indexOf('function '+name+'(');
  if(start<0) return '';
  let depth=0,opened=false;
  for(let i=start;i<src.length;i++){
    if(src[i]==='{'){depth++;opened=true;}
    else if(src[i]==='}' && opened && --depth===0) return src.slice(start,i+1);
  }
  return '';
}

const mergeSrc=grab('mergeSpeechText');
const sandbox={}; vm.createContext(sandbox);
vm.runInContext(mergeSrc+';this.mergeSpeechText=mergeSpeechText;',sandbox);
const merge=sandbox.mergeSpeechText;
merge('','hello')==='hello' ? ok('speech starts with first phrase') : bad('first phrase lost');
merge('hello','hello')==='hello' ? ok('duplicate final removed') : bad('duplicate final repeated');
merge('hello','hello world')==='hello world' ? ok('expanded final replaces prefix') : bad('expanded final duplicated');
merge('one two','two three')==='one two three' ? ok('restart overlap merged') : bad('restart overlap repeated');
merge('السلام','السلام عليكم')==='السلام عليكم' ? ok('Arabic expanded final merged') : bad('Arabic final duplicated');

src.includes('const ROOM_SIGN_MIN_FILL = 4;') && src.includes('const ROOM_SIGN_STAB = 2;')
  ? ok('deaf room uses low-latency recognition thresholds') : bad('room thresholds missing');
src.includes("fr%(roomFast?ROOM_SIGN_HEURISTIC_STRIDE:4)===0")
  ? ok('deaf room heuristic runs at higher cadence') : bad('room heuristic cadence unchanged');
src.includes("netRoleRef.current==='hearing'") && src.includes('!speakerRoom && handsRef.current')
  ? ok('hearing room skips hand inference') : bad('hearing room still runs hand inference');
// Only the explicit "send with speech" mode may FORCE the peer to speak a
// message. Assert the rule itself rather than one particular spelling of it.
src.includes("speak: mode==='speak'") || src.includes("speak: mode === 'speak'")
  ? ok('plain chat does not force remote speech') : bad('plain chat still forces speech');
// AUTO-SPEAK is a receiver-side opt-in and must not be tied to the message kind:
// gating it on kind!=='chat' silenced everything a deaf user signed.
src.includes('const shouldSpeakIncoming') && !src.includes("autoSpeakRef.current && m.kind!=='chat'")
  ? ok('auto-speak applies to every incoming peer message') : bad('auto-speak still restricted by message kind');
// Signed text must be sent as sign-provenance so the peer speaks/captions it.
src.includes("(mode==='sign' || draftSignRef.current) ? 'sign' : 'chat'")
  ? ok('signed drafts keep sign provenance when sent') : bad('signed drafts are still sent as plain chat');
src.includes('mergeSpeechText(srFinalRef.current,rec._interim)')
  ? ok('interim speech banked before stop/restart') : bad('trailing interim speech can be lost');
const stopSrc=grab('stopRoomSR');
!stopSrc.includes('srGenRef.current++')
  ? ok('graceful stop accepts final recognition event') : bad('stop invalidates final recognition event');
src.includes("typeof loaded==='boolean'") && src.includes("const st=ready?'online':'offline'")
  ? ok('model readiness controls inference fallback') : bad('health check interrupts fallback');
const soundStart=src.indexOf('const toggleRoomSound');
const soundSrc=soundStart<0?'':src.slice(soundStart,src.indexOf('// Full RTL flip',soundStart));
soundSrc.includes('video.play()') && soundSrc.includes('video.muted = nextMuted')
  ? ok('sound toggle retries playback from user gesture') : bad('sound toggle does not directly resume remote media');
soundSrc.includes('roomMutedRef.current = true') && soundSrc.includes('setRoomMuted(true)') &&
  src.includes('onAutoplayBlocked={handleRemoteAutoplayBlocked}')
  ? ok('autoplay rejection synchronizes SOUND OFF state') : bad('autoplay rejection leaves sound UI out of sync');

console.log(fails===0?'ALL ROOM MODE CHECKS PASSED':fails+' ROOM MODE CHECKS FAILED');
process.exit(fails===0?0:1);
