'use strict';
/* Patte Ghar - online multiplayer server (koi extra package nahi chahiye, sirf Node.js 18+)
   - ../www/index.html se wahi game-engine padhta hai jo app me chalta hai (ek hi rules, ek hi bots)
   - game server par chalta hai: patte server baantta hai, har khiladi ko sirf apne patte dikhte hain
   - rooms: private (code se), quick match (khali seat par bots), disconnect par bot chal deta hai, wapas judne par control mil jata hai
   - 5 game: Call Break ('cb'), Kot Piece ('kot', 4 khiladi, seat 0&2 ek team, 1&3 doosri), Rang Bid ('rang', 4 khiladi, sab alag),
   Seep ('seep', 2 ya 4 khiladi, 4 me seat 0&2 ek team) aur Bhabhi-Devar ('bhabhi', 3 se 8 khiladi, sab alag) */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const T = {                                   // samay (ms). test ke liye env se chhota kar sakte hain
  turn: +process.env.TURN_MS || 20000,        // khiladi ke paas chal ke liye
  hold: +process.env.HOLD_MS || 1900,         // hath poora hone ke baad clients patte dikhate hain
  round: +process.env.ROUND_WAIT_MS || 8000,  // round ke beech ka score-screen
  quick: +process.env.QUICK_WAIT_MS || 12000, // quick match me doosre khiladi ka intezaar
  botMin: +process.env.BOT_MIN_MS || 1000, botMax: +process.env.BOT_MAX_MS || 2000,
  bidMin: +process.env.BID_MIN_MS || 1300, bidMax: +process.env.BID_MAX_MS || 1900,
  emptyRoom: +process.env.EMPTY_ROOM_MS || 60000,
  play: +process.env.PLAY_MS || 15000,             // teeno game: patta chalne ke liye 15 second
  kturn: +process.env.KOT_TURN_MS || 30000,         // Kot Piece: rang bolne/badalne me sochne ka samay thoda zyada
  kround: +process.env.KOT_ROUND_WAIT_MS || 10000   // Kot Piece: round ke beech ka score-screen
};

/* ---------- game engine: index.html se ---------- */
const WWW = [path.join(__dirname, 'index.html'), path.join(__dirname, '..', 'www', 'index.html')].find(f => fs.existsSync(f)) || path.join(__dirname, 'index.html');   // dono tarah chalta hai: sab ek hi folder me, ya www/ alag
const ENG_NOTE = [];   // engine load me koi dikkat hui to yahan likhi jayegi (/healthz me dikhti hai)
function loadEngine() {
  const h = fs.readFileSync(WWW, 'utf8');
  const a = h.indexOf('/* ============ 1. CARD LIBRARY'), b = h.indexOf('/* ============ 4. DATA');
  if (a < 0 || b < 0) throw new Error('engine markers index.html me nahi mile');
  const sl = (m1, m2) => { const x = h.indexOf(m1), y = h.indexOf(m2); if (x < 0 || y < 0 || y < x) throw new Error('marker nahi mila: ' + m1); return h.slice(x, y); };
  const opt = (name, m1, m2, stub) => { try { return sl(m1, m2); } catch (e) { ENG_NOTE.push(name + ': ' + e.message); console.error('engine adhura:', name, e.message); return stub; } };   // koi ek engine na mile to baaki chalte rahein
  const power = opt('powerHand', 'function powerHand(h,st){', '/* ---- Rang Bol: bade bid ke ank', 'function powerHand(){return 0}');
  const seep = opt('seep', 'const SeepEng=(()=>{', '/* ============ SEEP: SCREEN', 'const SeepEng=null;');
  const bhab = opt('bhabhi', 'const BhEng=(()=>{', '/* ============ BHABHI: SCREEN', 'const BhEng=null;');
  return new Function(h.slice(a, b) + '\n' + power + '\n' + seep + '\n' + bhab + ';return {CallBreak,Bots,KotPiece,KotBots,RangBid,RangBots,SeepEng,BhEng}')();
}
let CallBreak = null, Bots = null, KotPiece = null, KotBots = null, RangBid = null, RangBots = null, SeepEng = null, BhEng = null;
try { ({ CallBreak, Bots, KotPiece, KotBots, RangBid, RangBots, SeepEng, BhEng } = loadEngine()); }
catch (e) { ENG_NOTE.push('engine load nahi hua: ' + e.message); console.error('ENGINE LOAD FAIL (server phir bhi chalega, sirf online khel band):', e); }
process.on('uncaughtException', e => console.error('uncaughtException (server chalta rahega):', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

/* Seep aur Bhabhi ke engine ko wahi interface dete hain jo baaki teen engine ka hai: createInitialState / getValidMoves / applyMove / nextRound */
const SeepOL = {
  createInitialState: r => SeepEng.create({ variant: r.sv, n: r.n, target: 100, minSeep: r.sm }),
  getValidMoves: (G, p) => G.phase === 'bid' ? (p === G.bidder ? SeepEng.bidOptions(G).map(v => ({ t: 'bid', v })) : [])
    : G.phase === 'play' && p === G.turn ? SeepEng.getMoves(G, p) : [],
  applyMove: (G, p, m) => SeepEng.applyMove(G, p, m),
  nextRound: G => SeepEng.nextDeal(G)
};
const BhOL = {
  createInitialState: r => BhEng.create({ n: r.n, fr: r.fr, ask: r.ask, so: r.so }),
  getValidMoves: (G, p) => BhEng.getMoves(G, p),
  applyMove: (G, p, m) => BhEng.applyMove(G, p, m),
  nextRound: G => G
};
const SeepBots = {}, BhBots = {};
['easy', 'medium', 'hard'].forEach(l => {
  SeepBots[l] = (G, p) => G.phase === 'bid' ? { t: 'bid', v: SeepEng.bots.bid(G) } : SeepEng.bots.move(G, p, l);
  BhBots[l] = (G, p, mv) => BhEng.best(G, p, l, mv);
});
const ENG = r => r.game === 'kot' ? KotPiece : r.game === 'rang' ? RangBid : r.game === 'seep' ? SeepOL : r.game === 'bhabhi' ? BhOL : CallBreak;      // is room ka engine
const BOTS_OF = r => r.game === 'kot' ? KotBots : r.game === 'rang' ? RangBots : r.game === 'seep' ? SeepBots : r.game === 'bhabhi' ? BhBots : Bots;
const rnd = n => crypto.randomInt(Math.max(1, n));

/* ---------- minimal WebSocket (RFC 6455) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WS {
  constructor(sock) {
    this.s = sock; this.buf = Buffer.alloc(0); this.open = true; this.onmsg = () => {}; this.onclose = () => {};
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); if (this.buf.length > 1 << 20) return this.close(); this.parse(); });
    sock.on('close', () => this.end()); sock.on('error', () => this.end());
  }
  parse() {
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const op = b[0] & 15, masked = b[1] & 128; let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > 65536) return this.close();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), p = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) return this.close();
      if (op === 9) this.frame(10, p);
      else if (op === 1) this.onmsg(p.toString('utf8'));
    }
  }
  frame(op, p) {
    if (!this.open) return; const n = p.length; let h;
    if (n < 126) h = Buffer.from([128 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    try { this.s.write(Buffer.concat([h, p])); } catch (e) { this.end(); }
  }
  send(o) { this.frame(1, Buffer.from(JSON.stringify(o))); }
  close() { if (this.open) { try { this.frame(8, Buffer.alloc(0)); this.s.end(); } catch (e) {} this.end(); } }
  end() { if (this.open) { this.open = false; this.onclose(); } }
}

/* ---------- bots ke naam ---------- */
const POOL = [['राहुल','Rahul','m'],['अमित','Amit','m'],['विक्रम','Vikram','m'],['अर्जुन','Arjun','m'],['संदीप','Sandeep','m'],['रोहित','Rohit','m'],['करण','Karan','m'],['मनोज','Manoj','m'],['दीपक','Deepak','m'],['सुनील','Sunil','m'],['गुरप्रीत','Gurpreet','m'],['इमरान','Imran','m'],['रवि','Ravi','m'],
  ['प्रिया','Priya','f'],['नेहा','Neha','f'],['पूजा','Pooja','f'],['अंजलि','Anjali','f'],['सिमरन','Simran','f'],['कविता','Kavita','f'],['सुनीता','Sunita','f'],['मीना','Meena','f'],['रीतू','Ritu','f'],['दिव्या','Divya','f'],['फ़ातिमा','Fatima','f'],['कोमल','Komal','f']];
const FACE = { m: ['👨','🧔','👳','👱','👴','🧑'], f: ['👩','👩‍🦰','👩‍🦱','🧕','👵','👱‍♀️'] };
const EMOS = ['👍','😂','😮','🔥','👏','😡','🙏'];

/* ---------- rooms ---------- */
const clients = new Set(), rooms = new Map(), sessions = new Map();   // sessions: token -> {code, seat}
const LV = l => ['easy', 'medium', 'hard'].includes(l) ? l : 'medium';
const clampN = (v, a, b, d) => Number.isInteger(v) ? Math.max(a, Math.min(b, v)) : d;
const norm = o => o.game === 'seep'
  ? { game: 'seep', n: o.n === 2 ? 2 : 4, mode: 'rounds', rounds: 5, target: 21, ktarget: 5, sv: o.sv === 'p30' ? 'p30' : 's100', sm: o.sm === 2 ? 2 : 1, level: LV(o.level) }
  : o.game === 'bhabhi'
  ? { game: 'bhabhi', n: clampN(o.n, 3, 8, 4), mode: 'rounds', rounds: 5, target: 21, ktarget: 5, fr: o.fr !== false, ask: !!o.ask, so: !!o.so, level: LV(o.level) }
  : o.game === 'rang'
  ? { game: 'rang', n: 4, mode: o.mode === 'target' ? 'target' : 'rounds', rounds: [3, 5].includes(o.rounds) ? o.rounds : 5, target: [11, 21, 31].includes(o.target) ? o.target : 11, ktarget: 5, level: LV(o.level) }
  : o.game === 'kot'
  ? { game: 'kot', n: 4, mode: 'rounds', rounds: 5, target: 21, ktarget: [3, 5, 7].includes(o.ktarget) ? o.ktarget : 5, level: LV(o.level) }
  : {
    game: 'cb', ktarget: 5,
    n: [4, 5, 6].includes(o.n) ? o.n : 4, mode: o.mode === 'target' ? 'target' : 'rounds',
    rounds: [1, 3, 5].includes(o.rounds) ? o.rounds : 5, target: [11, 21].includes(o.target) ? o.target : 21,
    level: LV(o.level)
  };
const keyOf = o => [o.game, o.n, o.mode, o.rounds, o.target, o.ktarget, o.level, o.sv, o.sm, o.fr, o.ask, o.so].join('|');
function newCode() { const len = rooms.size > 5000 ? 5 : 4; let c; do { c = String(rnd(10 ** len - 10 ** (len - 1)) + 10 ** (len - 1)); } while (rooms.has(c)); return c; }   // PIN: sirf ginti (4 ank, bahut zyada rooms hon to 5)
function mkRoom(o, pub) {
  const q = norm(o), r = { ...q, code: newCode(), key: keyOf(q), pub: !!pub, phase: 'lobby', seats: Array.from({ length: q.n }, () => ({ k: 'empty' })),
    G: null, host: -1, tn: 0, timer: null, startAt: 0, holdUntil: 0, deadline: 0, emptyT: null };
  rooms.set(r.code, r); return r;
}
const humans = r => r.seats.filter(s => s.k === 'human');
const liveClient = s => s.k === 'human' && s.c && s.c.ws.open ? s.c : null;
function roomMsg(r, you) {
  return { t: 'room', game: r.game, ktarget: r.ktarget, code: r.code, you, host: r.host, n: r.n, mode: r.mode, rounds: r.rounds, target: r.target, level: r.level, phase: r.phase, pub: r.pub, sv: r.sv, sm: r.sm, fr: r.fr, ask: r.ask, so: r.so,
    startIn: r.startAt ? Math.max(0, r.startAt - Date.now()) : 0, seats: r.seats.map(s => ({ k: s.k, name: s.name, e: s.e, away: !!s.away })) };
}
function bcastRoom(r) { r.seats.forEach((s, i) => { const c = liveClient(s); if (c) c.ws.send(roomMsg(r, i)); }); }
function view(G, seat, game) {
  const v = JSON.parse(JSON.stringify(G));
  if (game === 'seep' || game === 'bhabhi') {                       // doosron ke patte (aur Seep ki gaddi) kabhi nahi bhejte
    v.hands = G.hands.map((h, i) => i === seat ? h : h.map(() => 0));
    if (game === 'seep') { v.deck = G.deck.map(() => 0); if (G.hidden) v.table = G.table.map(i => ({ ...i, val: 0, cards: i.cards.map(() => ({ s: 0, r: 2 })) })); }
    return v;
  }
  // Kot Piece: apne bhi sirf utne patte bhejte hain jitne abhi dikhne chahiye (pehle 5, rang badalne par 13)
  v.hands = G.hands.map((h, i) => i === seat ? ((game === 'kot' || game === 'rang') ? h.slice(0, G.vis[i]) : h) : h.map(() => 0));
  // Rang Bid: bolti (call) ke samay doosron ka rang chhupa rehta hai; bolti khatam hone par trump sabko dikhta hai
  if (game === 'rang' && G.phase === 'call') {
    if (v.call.hi && v.call.hi.p !== seat) v.call.hi.s = null;
    v.log = v.log.map(x => (!x.pass && x.p !== seat) ? { ...x, s: null } : x);
  }
  delete v.seed; return v;
}
function sendState(r, s, i) {
  const c = liveClient(s); if (!c) return;
  c.ws.send({ t: 'state', seat: i, G: view(r.G, i, r.game), tn: r.tn, ms: Math.max(0, r.deadline - Date.now()) });
}
function sendStates(r) { r.seats.forEach((s, i) => sendState(r, s, i)); }
function pickBot(r) {
  const used = new Set(r.seats.filter(s => s.name).map(s => s.name[1]));
  let x; do { x = POOL[rnd(POOL.length)]; } while (used.has(x[1]));
  const usedE = new Set(r.seats.filter(q => q.e).map(q => q.e)), f0 = FACE[x[2]], f = f0.filter(z => !usedE.has(z));   // bots ke avatar alag-alag
  const ff = f.length ? f : f0; return { k: 'bot', name: [x[0], x[1]], e: ff[rnd(ff.length)], away: false };
}
function destroy(r) { clearTimeout(r.timer); clearTimeout(r.emptyT); rooms.delete(r.code); r.seats.forEach(s => { if (s.tok) sessions.delete(s.tok); }); }

function addHuman(r, c) {
  const order = (r.game === 'kot' || (r.game === 'seep' && r.n === 4)) ? [0, 2, 1, 3] : r.seats.map((_, j) => j);      // Kot Piece: doosra khiladi saamne (saathi) baithta hai
  const i = order.find(j => r.seats[j].k === 'empty'); if (i === undefined) return false;
  r.seats[i] = { k: 'human', c, tok: c.token, name: [c.name, c.name], e: c.e, away: false, idle: 0 };
  c.room = r; c.seat = i; sessions.set(c.token, { code: r.code, seat: i }); if (r.host < 0) r.host = i;
  clearTimeout(r.emptyT); return true;
}
function leave(c) {
  const r = c.room; if (!r) return;
  const i = c.seat; c.room = null; c.seat = -1; sessions.delete(c.token);
  const s = r.seats[i]; if (!s || s.c !== c) return;
  if (r.phase === 'lobby') { r.seats[i] = { k: 'empty' }; }
  else { r.seats[i] = { k: 'bot', name: s.name, e: s.e, away: false, left: true }; }   // chal ke beech me chhodne par bot baith jata hai
  if (!humans(r).length) return destroy(r);
  if (r.host === i) r.host = r.seats.findIndex(x => x.k === 'human');
  if (r.phase === 'lobby') bcastRoom(r);
}
function start(r) {
  if (r.phase !== 'lobby') return; clearTimeout(r.timer); r.startAt = 0;
  if (!humans(r).length) return destroy(r);
  r.seats = r.seats.map(s => s.k === 'empty' ? pickBot(r) : s);
  r.G = r.game === 'rang' ? RangBid.createInitialState(r.mode === 'target' ? { target: r.target } : { rounds: r.rounds })
    : r.game === 'seep' ? SeepOL.createInitialState(r)
    : r.game === 'bhabhi' ? BhOL.createInitialState(r)
    : r.game === 'kot' ? KotPiece.createInitialState({ target: r.ktarget })
    : CallBreak.createInitialState({ players: r.n, rounds: r.rounds, target: r.mode === 'target' ? r.target : 0 });
  r.phase = 'playing'; r.tn = 0; r.holdUntil = 0; bcastRoom(r); advance(r);
}
function advance(r) { sched(r); sendStates(r); }
function sched(r) {
  clearTimeout(r.timer); const G = r.G; if (!G) return;
  if (G.phase === 'roundEnd' || G.phase === 'dealEnd') {
    const rw = r.game === 'cb' ? T.round : T.kround;
    r.deadline = Date.now() + rw;
    r.timer = setTimeout(() => { r.G = ENG(r).nextRound(r.G); r.holdUntil = 0; advance(r); }, rw); return;
  }
  if (G.phase === 'over') { r.phase = 'over'; r.deadline = 0; return; }
  const seat = G.turn, s = r.seats[seat], auto = s.k === 'bot' || s.away;
  let ms = auto ? (G.phase !== 'play' ? T.bidMin + rnd(T.bidMax - T.bidMin) : T.botMin + rnd(T.botMax - T.botMin)) : (G.phase === 'play' ? T.play : (r.game === 'kot' ? T.kturn : T.turn));   // Rang Bid: 20 second (client ka ring bhi yahi dikhata hai)
  ms += Math.max(0, r.holdUntil - Date.now());
  r.deadline = Date.now() + ms;
  r.timer = setTimeout(() => autoMove(r, seat, !auto), ms);
}
function applyMove(r, seat, m) {
  const G = r.G, done = !!G.trick && r.game !== 'bhabhi' && G.phase === 'play' && G.trick.length === G.n - 1;
  r.G = ENG(r).applyMove(G, seat, m);
  if (done) { r.tn++; r.holdUntil = Date.now() + T.hold; }
  const ev = r.G.ev;
  if (r.game === 'bhabhi' && ev && (ev.type === 'pick' || ev.type === 'discard')) { r.tn++; r.holdUntil = Date.now() + T.hold; }   // thulla / discard: clients chaal 1.8 sec dikhate hain
  advance(r);
}
function autoMove(r, seat, idle) {
  const G = r.G; if (!G || G.turn !== seat) return;
  const s = r.seats[seat], mv = ENG(r).getValidMoves(G, seat); if (!mv.length) return;
  const B = BOTS_OF(r);
  const bot = s.k === 'bot' ? (B[r.level] || B.medium) : B.medium;
  if (idle && s.k === 'human') { s.idle = (s.idle || 0) + 1; if (s.idle >= 2) s.away = true; }   // 2 baar time khatam: bot kheleg
  if (r.game === 'rang' && idle && s.k === 'human' && G.phase === 'call') return applyMove(r, seat, { t: 'pass' });   // samay khatam: rang nahi bolega
  if (r.game === 'bhabhi' && idle && s.k === 'human' && G.phase === 'ask') return applyMove(r, seat, { t: 'refuse' });   // samay khatam: patte nahi dega
  applyMove(r, seat, bot(G, seat, mv) || mv[0]);
}
function onMove(c, m) {
  const r = c.room; if (!r || r.phase !== 'playing' || !m) return c.ws.send({ t: 'err', msg: 'game chal nahi raha' });
  const G = r.G; if (G.turn !== c.seat) return c.ws.send({ t: 'err', msg: 'abhi aapki baari nahi hai', code: 'turn' });
  const mv = ENG(r).getValidMoves(G, c.seat);
  let ok = null;
  if (r.game === 'rang') {
    const sv = x => x == null ? null : x;
    ok = mv.find(x => x.t === m.t && (m.t === 'play' ? !!m.c && x.c.s === m.c.s && x.c.r === m.c.r : (m.t === 'call' || m.t === 'bid') ? x.n === m.n && sv(x.s) === sv(m.s) : true)) || null;
  } else if (r.game === 'seep') {
    const sig = x => JSON.stringify([x.a, x.take, x.use, x.hid, x.h]);
    ok = m.t === 'bid' ? mv.find(x => x.t === 'bid' && x.v === m.v)
      : m.t === 'play' && m.c ? mv.find(x => x.t === 'play' && x.c.s === m.c.s && x.c.r === m.c.r && sig(x) === sig(m)) : null;
  } else if (r.game === 'bhabhi') {
    ok = mv.find(x => x.t === m.t && (m.t === 'play' ? !!m.c && x.c.s === m.c.s && x.c.r === m.c.r : m.t === 'ask' ? x.to === m.to : true)) || null;
  } else if (r.game === 'kot') {
    ok = mv.find(x => x.t === m.t && (m.t === 'play' ? !!m.c && x.c.s === m.c.s && x.c.r === m.c.r : (m.t === 'call' || m.t === 'trump') ? x.s === m.s : true)) || null;
  } else {
    ok = m.t === 'bid' ? mv.find(x => x.t === 'bid' && x.n === m.n)
      : m.t === 'play' && m.c ? mv.find(x => x.t === 'play' && x.c.s === m.c.s && x.c.r === m.c.r) : null;
  }
  if (!ok) return c.ws.send({ t: 'err', msg: 'ye chal sahi nahi hai', code: 'illegal' });
  const s = r.seats[c.seat]; s.idle = 0; s.away = false;
  applyMove(r, c.seat, ok);
}

/* ---------- client messages ---------- */
const clean = (s, n) => String(s || '').replace(/[<>"'&\\]/g, '').trim().slice(0, n);
function handle(c, m) {
  if (!m || typeof m !== 'object') return;
  const now = Date.now(); c.rate = (c.rate || []).filter(t => now - t < 1000); c.rate.push(now); if (c.rate.length > 25) return;
  switch (m.t) {
    case 'hello': {
      c.name = clean(m.name, 12) || 'Guest'; c.e = [...clean(m.e, 8)].slice(0, 2).join('') || '🙂';
      let tok = typeof m.token === 'string' && sessions.has(m.token) ? m.token : '', resumed = false;
      if (tok) {                                           // wapas judna: apni seat wapas
        const ss = sessions.get(tok), r = rooms.get(ss.code), s = r && r.seats[ss.seat];
        if (s && s.k === 'human' && s.tok === tok) {
          if (s.c && s.c !== c && s.c.ws.open) { s.c.room = null; s.c.ws.close(); }
          s.c = c; s.away = false; s.idle = 0; c.token = tok; c.room = r; c.seat = ss.seat; resumed = true; clearTimeout(r.emptyT);
        } else { sessions.delete(tok); tok = ''; }
      }
      if (!tok) { c.token = crypto.randomUUID(); }
      c.ws.send({ t: 'hi', token: c.token, resumed });
      if (resumed) { c.ws.send(roomMsg(c.room, c.seat)); if (c.room.phase !== 'lobby') sendState(c.room, c.room.seats[c.seat], c.seat); }
      break;
    }
    case 'create': { if (!c.token) return; leave(c); const r = mkRoom(m, false); addHuman(r, c); bcastRoom(r); break; }
    case 'quick': {
      if (!c.token) return; leave(c); const q = norm(m), key = keyOf(q);
      let r = [...rooms.values()].find(x => x.pub && x.phase === 'lobby' && x.key === key && x.seats.some(s => s.k === 'empty'));
      if (!r) { r = mkRoom(q, true); r.startAt = Date.now() + T.quick; r.timer = setTimeout(() => start(r), T.quick); }
      addHuman(r, c);
      if (!r.seats.some(s => s.k === 'empty')) start(r); else bcastRoom(r);
      break;
    }
    case 'join': {
      if (!c.token) return; const pin = String(m.code == null ? '' : m.code).replace(/\D/g, '').slice(0, 5);
      if (pin.length < 4) return c.ws.send({ t: 'err', msg: 'PIN 4 ank ka hona chahiye', code: 'badpin' });
      const r = rooms.get(pin);
      if (!r) return c.ws.send({ t: 'err', msg: 'galat PIN — ye room nahi mila', code: 'noroom' });
      if (r.phase !== 'lobby') return c.ws.send({ t: 'err', msg: 'is room ka game shuru ho chuka hai', code: 'started' });
      if (!r.seats.some(s => s.k === 'empty')) return c.ws.send({ t: 'err', msg: 'room bhar chuka hai', code: 'full' });
      leave(c); addHuman(r, c); bcastRoom(r); break;
    }
    case 'start': { const r = c.room; if (r && r.phase === 'lobby' && r.host === c.seat) start(r); break; }
    case 'move': onMove(c, m.m); break;
    case 'av': { c.e = [...clean(m.e, 8)].slice(0, 2).join('') || c.e; const r = c.room, s = r && r.seats[c.seat]; if (s && s.k === 'human' && r.phase === 'lobby') { s.e = c.e; bcastRoom(r); } break; }   // room ke andar avatar badalna
    case 'emo': { const r = c.room; const okq = typeof m.e === 'string' && /^q\d{1,2}$/.test(m.e) && +m.e.slice(1) < 14;   // taiyaar sandesh q0..q13
      if (c.lastEmo && Date.now() - c.lastEmo < 700) break; c.lastEmo = Date.now();
      const to = r && Number.isInteger(m.to) && m.to >= 0 && m.to < r.n ? m.to : -1;   // kis khiladi ko bhej rahe hain (-1 = sabko)
      if (r && (EMOS.includes(m.e) || okq)) r.seats.forEach(s => { const x = liveClient(s); if (x) x.ws.send({ t: 'emo', seat: c.seat, e: m.e, to }); }); break; }
    case 'again': {
      const r = c.room; if (!r) return;
      if (r.phase === 'over') {
        clearTimeout(r.timer); r.G = null; r.phase = 'lobby'; r.tn = 0;
        r.seats = r.seats.map(s => s.k === 'human' && liveClient(s) ? s : { k: 'empty' });
        r.seats.forEach((s, i) => { if (s.k === 'human') sessions.set(s.tok, { code: r.code, seat: i }); });
        if (!humans(r).length) return destroy(r);
        if (!r.seats[r.host] || r.seats[r.host].k !== 'human') r.host = r.seats.findIndex(x => x.k === 'human');
        if (r.pub) { r.startAt = Date.now() + T.quick; r.timer = setTimeout(() => start(r), T.quick); }
      }
      bcastRoom(r); break;
    }
    case 'leave': leave(c); break;
    case 'ping': c.ws.send({ t: 'pong' }); break;
  }
}
function onClose(c) {
  clients.delete(c); const r = c.room; if (!r) return;
  const s = r.seats[c.seat];
  if (r.phase === 'lobby') return leave(c);
  if (s && s.c === c) { s.away = true; s.c = null; }                    // bot chalata rahega, wapas aane par control mil jayega
  if (!r.seats.some(x => liveClient(x))) { clearTimeout(r.emptyT); r.emptyT = setTimeout(() => destroy(r), T.emptyRoom); }
}

/* ---------- HTTP + upgrade ---------- */
let pageCache = null;
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    try {   // gzip + ETag: 400 KB ki file ~130 KB me jati hai, dobara kholne par 304 (kuch bhi download nahi)
      const st = fs.statSync(WWW);
      if (!pageCache || pageCache.m !== st.mtimeMs) { const raw = fs.readFileSync(WWW); pageCache = { m: st.mtimeMs, raw, gz: require('zlib').gzipSync(raw, { level: 9 }), etag: '"' + st.mtimeMs.toString(36) + '-' + raw.length.toString(36) + '"' }; }
      if (req.headers['if-none-match'] === pageCache.etag) { res.writeHead(304, { ETag: pageCache.etag, 'Cache-Control': 'no-cache' }); return res.end(); }
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: pageCache.etag, Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gz ? pageCache.gz : pageCache.raw);
    }
    catch (e) { res.writeHead(500); return res.end('index.html nahi mila'); }
  }
  if (u === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size, node: process.version, up: Math.round(process.uptime()), engines: ENG_NOTE.length ? ENG_NOTE : 'ok' })); }
  if (u === '/privacy' || u === '/privacy.html') {
    const f = [path.join(__dirname, 'privacy.html'), path.join(__dirname, '..', 'www', 'privacy.html')].find(x => fs.existsSync(x));
    if (f) {
      const mail = process.env.CONTACT_EMAIL || 'email-yahan-aayega@example.com';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(f, 'utf8').split('{{EMAIL}}').join(mail));
    }
  }
  /* app ki files: manifest, service worker, icon, assetlinks (sab isi folder me hone chahiye) */
  const STATIC = {
    '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
    '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
    '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
    '/.well-known/assetlinks.json': ['assetlinks.json', 'application/json']
  };
  if (STATIC[u]) {
    const f = [path.join(__dirname, STATIC[u][0]), path.join(__dirname, '..', 'www', STATIC[u][0])].find(x => fs.existsSync(x));
    if (f) { res.writeHead(200, { 'Content-Type': STATIC[u][1], 'Cache-Control': u === '/sw.js' ? 'no-cache' : 'public, max-age=3600' }); return res.end(fs.readFileSync(f)); }
  }
  res.writeHead(404); res.end('not found');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key) { sock.destroy(); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  const ws = new WS(sock), c = { ws, id: crypto.randomUUID(), room: null, seat: -1, name: 'Guest', e: '🙂', token: '' };
  clients.add(c);
  ws.onmsg = txt => { if (txt.length > 2048) return; let m; try { m = JSON.parse(txt); } catch (e) { return; } try { handle(c, m); } catch (e) { console.error('handle error', e); } };
  ws.onclose = () => onClose(c);
});
setInterval(() => { clients.forEach(c => c.ws.frame(9, Buffer.alloc(0))); }, 25000);      // keep-alive
setInterval(() => { rooms.forEach(r => { if (!humans(r).length) destroy(r); }); }, 30000);

if (require.main === module) server.listen(PORT, () => console.log('Taash Adda server chal raha hai: http://localhost:' + PORT + '  (WebSocket: /ws)'));
module.exports = { server, rooms, T };
