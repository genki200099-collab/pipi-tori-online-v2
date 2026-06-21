'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let filePath = req.url.split('?')[0];
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const safe = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, safe);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type}); res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

// 進行停止監視。タイマーが不発になった場合でも、待機状態を定期的に拾って進める。
setInterval(()=>{
  for(const room of rooms.values()){
    try { ensureRoomProgress(room); } catch(e) { console.error('progress watchdog error', e); }
  }
}, 1000);


const suits = ['♠','♥','♦','♣'];
const ranks = ['1','2','3','4','5','6','7','8','9','10','11','12','13'];
let deckSerial = 0; // 第2ラウンド補充時もカードIDが重複しないようにする。
const value = Object.fromEntries(ranks.map(r=>[r, Number(r)]));

function code(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return rooms.has(s) ? code() : s;
}
function uid(){ return crypto.randomBytes(8).toString('hex'); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeDeck(){
  let deck=[]; let id=0;
  const serial = deckSerial++;
  for(const s of suits) for(const r of ranks) deck.push({id:`D${serial}-${s}${r}-${id++}`,faceKey:`${s}${r}`,suit:s,rank:r,val:value[r],joker:false});
  deck.push({id:`D${serial}-JOKER-${id++}`,faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true});
  return deck;
}

function cardFaceKey(card){
  if(!card) return 'NULL';
  if(card.faceKey) return card.faceKey;
  if(card.joker) return 'JOKER';
  return `${card.suit}${card.rank}`;
}

function isMadPig(card){
  return !!card && !card.joker && card.suit==='♠' && card.rank==='11';
}

function cloneCardWithFreshId(card){
  if(!card) return null;
  if(card.joker) return {...card, faceKey:'JOKER', id:`D${deckSerial++}-JOKER-${Date.now()}-${Math.random().toString(16).slice(2)}`};
  return {...card, faceKey:`${card.suit}${card.rank}`, id:`D${deckSerial++}-${card.suit}${card.rank}-${Date.now()}-${Math.random().toString(16).slice(2)}`};
}

function collectActiveFaceKeys(room){
  const keys = new Set();
  if(!room || !room.players) return keys;
  for(const p of room.players){
    for(const c of p.hand || []) keys.add(cardFaceKey(c));
    for(const c of p.scorePile || []) keys.add(cardFaceKey(c));
  }
  for(const t of room.trick || []) keys.add(cardFaceKey(t.card));
  for(const c of room.stock || []) keys.add(cardFaceKey(c));
  if(room.pendingPick?.result?.card) keys.add(cardFaceKey(room.pendingPick.result.card));
  return keys;
}

function assertUniqueActiveCards(room, context=''){
  const seen = new Map();
  const duplicates = [];
  function check(card, place){
    const key = cardFaceKey(card);
    if(key === 'NULL') return;
    if(seen.has(key)) duplicates.push(`${key}: ${seen.get(key)} / ${place}`);
    else seen.set(key, place);
  }
  if(room && room.players){
    for(const p of room.players){
      for(const c of p.hand || []) check(c, `${p.name}の手札`);
      for(const c of p.scorePile || []) check(c, `${p.name}のごちそう山`);
    }
  }
  for(const t of room?.trick || []) check(t.card, `場のカード:${t.pid}`);
  for(const c of room?.stock || []) check(c, '補充山');
  if(duplicates.length){
    log(room, `⚠️ カード重複を検知しました${context ? '（'+context+'）' : ''}: ${duplicates.join(' / ')}`);
    return false;
  }
  return true;
}

function buildUniqueNormalRefillDeck(room){
  const active = collectActiveFaceKeys(room);
  const deck = [];
  for(const suit of suits){
    for(const rank of ranks){
      const base = {id:'', faceKey:`${suit}${rank}`, suit, rank, val:value[rank], joker:false};
      if(!active.has(cardFaceKey(base))) deck.push(cloneCardWithFreshId(base));
    }
  }
  shuffle(deck);
  return deck;
}

function cardText(c){ return c.joker ? '🃏ババブタ' : `${c.rank}${c.suit}`; }
function sortHand(h){
  h.sort((a,b)=>{
    if(a.joker) return 1; if(b.joker) return -1;
    const so = suits.indexOf(a.suit)-suits.indexOf(b.suit);
    if(so) return so;
    return b.val-a.val;
  });
}
function log(room, text){ room.log.unshift({time:new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'}), text}); room.log = room.log.slice(0,80); }
function say(room, pid, text){
  const p = room.players[pid]; if(!p) return;
  const item = {pid, name:p.name, text, expiresAt: Date.now()+8500};
  p.lastComment = item;
  room.commentary = room.commentary || [];
  room.commentary.unshift(item);
  room.commentary = room.commentary.slice(0,8);
  log(room, `💬 ${p.name}「${text}」`);
}

function isRoundEndHand(p){
  return !!p && (p.hand.length===0 || (p.hand.length===1 && p.hand[0].joker));
}
function activePlayerCount(room){
  return room.players ? room.players.length : 0;
}
function safeBroadcast(room){
  try { broadcast(room); } catch(e) { console.error('safeBroadcast error', e); }
}
function safeFinishBecauseNoPlayable(room, pid){
  const p = room.players[pid];
  if(!p) return false;
  if(isRoundEndHand(p)){
    log(room, `⚠️ ${p.name} の手札が終了条件を満たしたため、ラウンド終了処理へ進みます。`);
    room.pendingPick = null;
    room.trickReview = null;
    checkRoundEnd(room);
    broadcast(room);
    return true;
  }
  return false;
}

function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function cpuPlayLine(room, pid, card){
  const p = room.players[pid];
  const hand = p.hand;
  const leadSuit = room.leadSuit;
  const jokerInHand = hand.some(c=>c.joker);
  if(!leadSuit){
    if(hand.length <= 3) return sample(['ここで上がりに近づくブヒ！','ごちそう山、いただきに行くブヒ！','ラストスパート、強めにいくブヒ！']);
    if(card.val >= 12) return sample(['最初から圧をかけるブヒ！','高めで様子を見るブヒ。','これで主導権を取りたいブヒ！']);
    return sample(['まずは様子見でいくブヒ。','小さく入って様子を見るブヒ。','ここは安全運転ブヒ。']);
  }
  const hasLeadBefore = [...hand, card].some(c=>!c.joker && c.suit===leadSuit);
  if(card.suit !== leadSuit){
    if(jokerInHand) return sample(['スートがない！ババブタを隠して逃げるブヒ…','ここは別スートでかわすブヒ。ババブタだけは出せない！','よし、フォロー不能。いらないカードで逃げるブヒ。']);
    return sample(['そのスート持ってないブヒ！','自由に出せるならこれでいくブヒ。','うわっ、きついな〜。別スートで逃げるブヒ。']);
  }
  const currentHigh = room.trick.filter(x=>x.card.suit===leadSuit).reduce((m,x)=>Math.max(m,x.card.val),0);
  if(card.val > currentHigh && card.val >= 10) return sample(['まさか、ここで勝ちに行くブヒ！','ここでそれを出すブヒ！ごちそう狙い！','勝てるなら勝つしかないブヒ！']);
  if(card.val <= 5) return sample(['低めで耐えるブヒ…','うわっ、弱いのしかないブヒ。','これで最弱にならないといいブヒ…']);
  return sample(['マストフォロー、了解ブヒ。','このカードでついていくブヒ。','まだ勝負は分からないブヒ。']);
}
function cpuPickLine(room, winnerPid, weakestPid){
  const wp=room.players[winnerPid], lp=room.players[weakestPid];
  if(wp.cpu) return sample([`さて、${lp.name}の袋をのぞくブヒ…`,`そこにババブタいないでほしいブヒ…`,`勝ったのに怖い時間ブヒ。どれにするブヒ？`]);
  const cpu = room.players.find((p,i)=>p.cpu && i!==winnerPid);
  if(cpu){ const idx = room.players.indexOf(cpu); say(room, idx, sample(['このピック、空気が重いブヒ…','そこ引くの！？いや、まだ分からないブヒ！','ババブタの気配がするブヒ…'])); }
  return null;
}
function resultLine(drawn, paired){
  if(drawn.joker) return sample(['うわー！ババブタ来たブヒ！！','最悪の1枚を引いたブヒ…！','これはきついブヒ、完全に事故ブヒ！']);
  if(paired) return sample(['おそろいペア！これはうまいブヒ！','ナイス浄化ブヒ！手札が軽くなった！','そのペアは気持ちいいブヒ〜！']);
  if(drawn.val >= 11) return sample(['強いカードを拾ったブヒ。これは得かも？','高いカード、あとで効きそうブヒ。']);
  return sample(['まあまあの1枚ブヒ。','とりあえず手札に入れておくブヒ。','微妙だけどババブタじゃないだけセーフブヒ。']);
}
function publicState(room, viewerId){
  const viewerIndex = room.players.findIndex(p=>p.id===viewerId);
  return {
    code: room.code,
    hostId: room.hostId,
    you: viewerId,
    yourIndex: viewerIndex,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds || 3,
    madPigEnabled: room.madPigEnabled !== false,
    jokerPenalty: room.jokerPenalty ?? 50,
    initialPairDiscardEnabled: room.initialPairDiscardEnabled === true,
    passThreeEnabled: room.passThreeEnabled === true,
    penaltyMode: normalizePenaltyMode(room.penaltyMode),
    pickTargetCount: normalizePickTargetCount(room.pickTargetCount),
    passDone: room.passDone || [],
    passTargetPid: viewerIndex >= 0 ? passTargetPid(viewerIndex) : null,
    passSourcePid: viewerIndex >= 0 ? passSourcePid(viewerIndex) : null,
    passableCardIds: viewerIndex >= 0 && room.phase === 'passing' ? passableCardIds(room.players[viewerIndex]) : [],
    initialPairDone: room.initialPairDone || [],
    initialPairCandidateIds: viewerIndex >= 0 && room.phase === 'initialPair' ? initialPairCandidateIds(room.players[viewerIndex]) : [],
    roundStart: room.roundStart && room.roundStart.expiresAt > Date.now() ? room.roundStart : null,
    roundEndSummary: room.roundEndSummary || null,
    lead: room.lead,
    current: room.current,
    leadSuit: room.leadSuit,
    message: room.message,
    removedCard: room.removedCard ? (room.phase==='finished' ? room.removedCard : null) : null,
    trick: room.trick,
    pendingPick: room.pendingPick ? {
      winnerPid: room.pendingPick.winnerPid,
      weakestPid: room.pendingPick.weakestPid,
      readyAt: room.pendingPick.readyAt,
      // クライアントのPC時計差に依存しないため、サーバー基準の状態も送る。
      ready: Date.now() >= room.pendingPick.readyAt,
      readyInMs: Math.max(0, room.pendingPick.readyAt - Date.now()),
      targetCount: room.pendingPick.targetCount || pickCandidateLimit(room, room.players[room.pendingPick.weakestPid]),
      targetSelectionRequired: room.pendingPick.targetSelectionRequired === true,
      targetSelectionDone: room.pendingPick.targetSelectionDone !== false,
      targetCandidateCount: pickCandidateCards(room, room.pendingPick).length || pickCandidateLimit(room, room.players[room.pendingPick.weakestPid]),
      targetSelectableCardIds: (viewerIndex === room.pendingPick.weakestPid && room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) ? room.players[room.pendingPick.weakestPid].hand.map(c=>c.id) : [],
      result: room.pendingPick.result || null,
      pairChoice: room.pendingPick.pairChoice ? {
        drawn: room.pendingPick.pairChoice.drawn,
        candidates: viewerIndex === room.pendingPick.winnerPid ? room.pendingPick.pairChoice.candidates : null,
        candidateCount: room.pendingPick.pairChoice.candidates.length
      } : null
    } : null,
    players: room.players.map((p,i)=>({
      id:p.id, name:p.name, seat:i, cpu: !!p.cpu, connected: p.cpu || (p.ws && p.ws.readyState===WebSocket.OPEN),
      handCount:p.hand.length,
      hand: p.id===viewerId || room.phase==='finished' ? p.hand : null,
      scorePileCount:p.scorePile.length,
      pairsCount:p.pairs.length,
      out:p.out || false,
      final:p.final || null,
      lastComment: p.lastComment && p.lastComment.expiresAt > Date.now() ? p.lastComment.text : null,
    })),
    // クライアント側の判定ズレを防ぐため、出せるカードはサーバーで確定して送る。
    playableCardIds: viewerIndex >= 0 ? [...playableIds(room, viewerIndex)] : [],
    isYourTurn: viewerIndex >= 0 && room.current === viewerIndex && room.phase === 'playing' && !room.pendingPick && !room.trickReview,
    commentary: (room.commentary || []).filter(x=>x.expiresAt > Date.now()).slice(0,4),
    lastTrick: room.lastTrick && room.lastTrick.expiresAt > Date.now() ? room.lastTrick : null,
    trickReview: room.trickReview && room.trickReview.until > Date.now() ? room.trickReview : null,
    log: room.log,
  };
}
function send(ws, type, payload){
  if(!ws || ws.readyState!==WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({type, ...payload})); }
  catch(e){ console.error('send failed', e); }
}
function broadcast(room){
  if(!room || !room.players) return;
  for(const p of room.players){
    if(p.ws && p.ws.readyState===WebSocket.OPEN){
      send(p.ws,'state',{state: publicState(room,p.id)});
    }
  }
  scheduleCpu(room);
}

function normalizeRoundCount(n){
  const x = Number(n);
  if(!Number.isInteger(x)) return 3;
  return Math.max(1, Math.min(6, x));
}


function normalizePenaltyMode(v){
  return v === 'faceValue' ? 'faceValue' : 'flat3';
}

function handPenaltyForRoom(room, player){
  const mode = normalizePenaltyMode(room.penaltyMode);
  const useMadPig = room.madPigEnabled !== false;
  let total = 0;
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    // 数字分失点モードかつマッド・ピッグONの場合、スペード11は通常の11点ではなく40点として扱う。
    if(mode === 'faceValue' && useMadPig && c.suit==='♠' && c.rank==='11'){
      total += 40;
    } else if(mode === 'faceValue'){
      total += Number(c.val || c.rank || 0);
    } else {
      total += 3;
    }
  }
  return total;
}

function madPigPenaltyForRoom(room, player){
  const useMadPig = room.madPigEnabled !== false;
  if(!useMadPig) return 0;
  const mode = normalizePenaltyMode(room.penaltyMode);
  const cards = [...(player.hand || []), ...(player.scorePile || [])];
  const madPigs = cards.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11');

  if(mode === 'faceValue'){
    // 手札にあるマッド・ピッグは handPenaltyForRoom 側で40点として計算済み。
    // ごちそう山にあるマッド・ピッグは +1点を得たうえで、ここで40点失点。
    return madPigs.filter(c => (player.scorePile || []).some(p=>p.id===c.id)).length * 40;
  }

  // 従来モードでは、手札・ごちそう山のどちらでも追加 -13点。
  return madPigs.length * 13;
}

function normalizePassThreeEnabled(v){
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}

function normalizeInitialPairDiscardEnabled(v){
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}

function normalizeJokerPenalty(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return 50;
  const abs = Math.abs(Math.trunc(n));
  return Math.max(0, Math.min(999, abs));
}

function normalizeMadPigEnabled(v){
  if(v === false || v === 'false' || v === 0 || v === '0' || v === 'off') return false;
  return true;
}


function roomByWs(ws){ return rooms.get(ws.roomCode); }

function isOpenWs(ws){
  return ws && ws.readyState === WebSocket.OPEN;
}

function findReconnectCandidate(room, playerId, name){
  if(!room) return null;
  const clean = cleanName(name);
  // 最優先：保存されたplayerIdで復帰。
  let idx = room.players.findIndex(p=>!p.cpu && p.id === playerId);
  if(idx >= 0) return {player:room.players[idx], idx, reason:'id'};

  // 次点：同名で現在切断中のプレイヤーへ復帰。
  idx = room.players.findIndex(p=>!p.cpu && p.name === clean && !isOpenWs(p.ws));
  if(idx >= 0) return {player:room.players[idx], idx, reason:'name'};

  return null;
}

function reconnectRoom(ws, c, playerId, name){
  c = String(c||'').toUpperCase().trim();
  const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'復帰する部屋が見つかりません。'});
  const found = findReconnectCandidate(room, playerId, name);
  if(!found) return send(ws,'errorMsg',{message:'復帰できる席が見つかりません。同じ部屋コードと名前で入り直してください。'});

  const {player, idx} = found;
  if(player.ws && player.ws !== ws && isOpenWs(player.ws)){
    try { player.ws.close(4000, 'reconnected elsewhere'); } catch(e){}
  }
  player.ws = ws;
  ws.roomCode = c;
  ws.playerId = player.id;
  log(room, `${player.name} が再接続しました。`);
  send(ws,'reconnected',{code:c, playerId:player.id, name:player.name});
  broadcast(room);
}



function normalizePickTargetCount(v){
  const n = Number(v);
  if(!Number.isFinite(n) || n <= 0) return 0; // 0 = 絞らない
  return Math.max(1, Math.min(13, Math.floor(n)));
}

function pickTargetLabel(room){
  const n = normalizePickTargetCount(room.pickTargetCount);
  return n > 0 ? `候補${n}枚` : '絞らない';
}

function pickCandidateLimit(room, weakestPlayer){
  const n = normalizePickTargetCount(room.pickTargetCount);
  const handCount = weakestPlayer && Array.isArray(weakestPlayer.hand) ? weakestPlayer.hand.length : 0;
  return n > 0 ? Math.min(n, handCount) : handCount;
}

function pickCandidateCards(room, pp){
  if(!room || !pp) return [];
  const lp = room.players[pp.weakestPid];
  if(!lp || !Array.isArray(lp.hand)) return [];
  if(Array.isArray(pp.targetCandidateIds) && pp.targetCandidateIds.length){
    return pp.targetCandidateIds.map(id=>lp.hand.find(c=>c && c.id===id)).filter(Boolean);
  }
  return lp.hand.slice();
}

function pickRiskValue(room, card){
  if(!card) return -999;
  if(card.joker) return 10000;
  if(room.madPigEnabled !== false && card.suit==='♠' && card.rank==='11'){
    return normalizePenaltyMode(room.penaltyMode)==='faceValue' ? 4000 : 1300;
  }
  return Number(card.val || 0);
}

function chooseCpuPickTargetIds(room, weakestPid, count){
  const p = room.players[weakestPid];
  if(!p || !Array.isArray(p.hand)) return [];
  return p.hand.slice()
    .sort((a,b)=>pickRiskValue(room,b)-pickRiskValue(room,a) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, count))
    .map(c=>c.id);
}

function autoResolveCpuPickTargets(room, pp){
  if(!room || !pp || !pp.targetSelectionRequired || pp.targetSelectionDone) return;
  const weakest = room.players[pp.weakestPid];
  if(!weakest || !weakest.cpu) return;
  setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(room.pendingPick !== pp || pp.result || pp.targetSelectionDone) return;
    const ids = chooseCpuPickTargetIds(room, pp.weakestPid, pp.targetCount);
    submitPickTargets(room, weakest.id, ids, true);
  }, 700);
}

function roomPenaltyLabel(room){
  return normalizePenaltyMode(room.penaltyMode)==='faceValue' ? '数字分失点' : '1枚-3点';
}
function roomMadPigLabel(room){
  if(room.madPigEnabled === false) return 'なし';
  return normalizePenaltyMode(room.penaltyMode)==='faceValue' ? '-40' : '-13';
}
function roomOptionSummary(room){
  return `全${room.totalRounds || 3}R / 失点:${roomPenaltyLabel(room)} / ババ:-${room.jokerPenalty ?? 50} / マッド:${roomMadPigLabel(room)} / ピック:${pickTargetLabel(room)} / 3枚パス:${room.passThreeEnabled ? 'あり' : 'なし'} / 開始ペア:${room.initialPairDiscardEnabled ? 'あり' : 'なし'}`;
}

function createRoom(ws, name, totalRounds=3, madPigEnabled=true, jokerPenalty=-50, initialPairDiscardEnabled=false, passThreeEnabled=false, penaltyMode='flat3', pickTargetCount=0){
  const c = code();
  const id = uid();
  const room = {code:c, hostId:id, players:[], phase:'lobby', round:1, totalRounds: normalizeRoundCount(totalRounds), madPigEnabled: normalizeMadPigEnabled(madPigEnabled), jokerPenalty: normalizeJokerPenalty(jokerPenalty), initialPairDiscardEnabled: normalizeInitialPairDiscardEnabled(initialPairDiscardEnabled), passThreeEnabled: normalizePassThreeEnabled(passThreeEnabled), penaltyMode: normalizePenaltyMode(penaltyMode), pickTargetCount: normalizePickTargetCount(pickTargetCount), initialPairDone:[], passDone:[], passSelections:{}, lead:0, current:0, leadSuit:null, trick:[], stock:[], log:[], message:'4人そろったら開始できます。人が足りない場合はCPUを追加できます。', pendingPick:null, commentary:[], lastTrick:null};
  const player = {id, name: cleanName(name), ws, cpu:false, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player); rooms.set(c, room); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が部屋を作りました。${roomOptionSummary(room)}`); send(ws,'created',{code:c, playerId:id}); broadcast(room);
}
function cleanName(n){ return String(n || '').trim().slice(0,12) || '子ブタ'; }
function joinRoom(ws, c, name, playerId=null){
  c = String(c||'').toUpperCase().trim(); const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'部屋が見つかりません。'});
  if(room.phase !== 'lobby'){
    const found = findReconnectCandidate(room, playerId, name);
    if(found) return reconnectRoom(ws, c, found.player.id, found.player.name);
    return send(ws,'errorMsg',{message:'この部屋は開始済みです。切断復帰の場合は同じ名前で再接続してください。'});
  }
  if(room.players.length >= 4) {
    const found = findReconnectCandidate(room, playerId, name);
    if(found) return reconnectRoom(ws, c, found.player.id, found.player.name);
    return send(ws,'errorMsg',{message:'この部屋は満員です。'});
  }
  const id = uid(); const player = {id, name:cleanName(name), ws, cpu:false, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が参加しました。`); send(ws,'joined',{code:c, playerId:id}); broadcast(room);
}

function addCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  if(room.players.length >= 4) { room.message='この部屋は満員です。'; broadcast(room); return; }
  const cpuNames = ['CPUブタA','CPUブタB','CPUブタC','CPUブタD'];
  const used = new Set(room.players.map(p=>p.name));
  const name = cpuNames.find(n=>!used.has(n)) || `CPUブタ${room.players.length}`;
  const player = {id:`CPU-${uid()}`, name, ws:null, cpu:true, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player);
  log(room, `${player.name} を追加しました。`);
  room.message='CPUを追加しました。4人そろったら開始できます。';
  broadcast(room);
}
function removeCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  const i = room.players.map(p=>p.cpu).lastIndexOf(true);
  if(i<0) { room.message='削除できるCPUがいません。'; broadcast(room); return; }
  const [p] = room.players.splice(i,1);
  log(room, `${p.name} を外しました。`);
  room.message='CPUを外しました。';
  broadcast(room);
}


function clearPickFinishTimer(room){
  if(room.pickFinishTimer){
    clearTimeout(room.pickFinishTimer);
    room.pickFinishTimer = null;
  }
  if(room.pickFinishFailSafeTimer){
    clearTimeout(room.pickFinishFailSafeTimer);
    room.pickFinishFailSafeTimer = null;
  }
}
function clearReviewTimer(room){
  if(room.reviewTimer){
    clearTimeout(room.reviewTimer);
    room.reviewTimer = null;
  }
  if(room.reviewFailSafeTimer){
    clearTimeout(room.reviewFailSafeTimer);
    room.reviewFailSafeTimer = null;
  }
  if(room.reviewWatchTimer){
    clearInterval(room.reviewWatchTimer);
    room.reviewWatchTimer = null;
  }
}
function clearAllProgressTimers(room){
  clearReviewTimer(room);
  clearPickFinishTimer(room);
  if(room.cpuTimer){ clearTimeout(room.cpuTimer); room.cpuTimer=null; }
  if(room.cpuPickTimer){ clearTimeout(room.cpuPickTimer); room.cpuPickTimer=null; }
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  if(room.recoverTimer){ clearTimeout(room.recoverTimer); room.recoverTimer=null; }
}
function ensurePickFinish(room, pp, winnerPid, delay=2600){
  clearPickFinishTimer(room);
  const token = pp && pp.token ? pp.token : `${Date.now()}-${Math.random()}`;
  if(pp) pp.token = token;

  room.pickFinishTimer = setTimeout(()=>{
    room.pickFinishTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    finishAfterPick(room, winnerPid);
  }, delay);

  // 結果表示後に何らかのタイマー不発・状態ズレがあっても止まらないための保険。
  room.pickFinishFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    log(room, '⚠️ ピック結果後の進行が遅延したため、自動復旧しました。');
    finishAfterPick(room, winnerPid);
  }, delay + 4500);
}
function ensureReviewToPick(room, reviewToken, winnerPid, weakestPid){
  // レビュー→ピック遷移は、この関数で必ず予約する。
  // 既存タイマーが残っていても一旦消し、reviewTokenで現在のレビューだけを進める。
  clearReviewTimer(room);

  const delay = Math.max(0, reviewToken - Date.now());
  room.reviewTimer = setTimeout(()=>{
    room.reviewTimer = null;
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, delay);

  // 保険1：通常タイマーが実行されなかった場合でも進める。
  room.reviewFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.trickReview || room.trickReview.until !== reviewToken) return;
    log(room, '⚠️ トリック結果確認からピックへの遷移が遅延したため、自動復旧しました。');
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, delay + 3500);

  // 保険2：Renderなどでタイマーが遅延しても、短い監視でレビュー期限切れを拾う。
  if(room.reviewWatchTimer) clearInterval(room.reviewWatchTimer);
  room.reviewWatchTimer = setInterval(()=>{
    if(room.phase !== 'playing' || !room.trickReview || room.trickReview.until !== reviewToken){
      clearInterval(room.reviewWatchTimer); room.reviewWatchTimer=null; return;
    }
    if(Date.now() >= reviewToken){
      clearInterval(room.reviewWatchTimer); room.reviewWatchTimer=null;
      advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
    }
  }, 500);
}


function advanceReviewToPick(room, reviewToken, winnerPid, weakestPid){
  if(room.phase !== 'playing') return;

  // 現在のレビューと違う古いタイマーなら無視。
  if(!room.trickReview || room.trickReview.until !== reviewToken) return;

  const wp = room.players[winnerPid];
  const lp = room.players[weakestPid];
  if(!wp || !lp){
    log(room, '⚠️ ピック遷移対象のプレイヤーが見つからないため、進行を復旧しました。');
    room.trickReview = null;
    room.trick = [];
    room.leadSuit = null;
    room.current = room.lead ?? 0;
    broadcast(room);
    return;
  }

  clearReviewTimer(room);
  room.trickReview = null;

  if(lp.hand.length > 0){
    const targetCount = pickCandidateLimit(room, lp);
    const targetSelectionRequired = normalizePickTargetCount(room.pickTargetCount) > 0 && targetCount < lp.hand.length;
    const readyAt = Date.now() + (targetSelectionRequired ? 999999999 : 1800);
    room.pendingPick = {
      winnerPid,
      weakestPid,
      readyAt,
      result:null,
      token:`pick-${Date.now()}-${Math.random()}`,
      targetCount,
      targetSelectionRequired,
      targetSelectionDone: !targetSelectionRequired,
      targetCandidateIds: targetSelectionRequired ? [] : null
    };

    if(targetSelectionRequired){
      room.message = `🐽 ${lp.name} がピック候補を${targetCount}枚に絞ります。`;
      log(room, `🎯 ピック候補選択：${lp.name} が ${targetCount}枚を選びます。`);
      autoResolveCpuPickTargets(room, room.pendingPick);
      broadcast(room);
    } else {
      room.message = `🐽 ババ抜きピック！ ${wp.name} が ${lp.name} の袋から1枚選びます。`;
      const line = cpuPickLine(room, winnerPid, weakestPid); if(line) say(room, winnerPid, line);
      ensureCpuPick(room);
      broadcast(room);
      // readyAtを過ぎた状態を全員に再送する。Edge/PCのローカル時計差対策。
      setTimeout(()=>broadcast(room), 1850);
      setTimeout(()=>broadcast(room), 2300);
    }
  } else {
    finishAfterPick(room, winnerPid);
  }
}


function ensureRoomProgress(room){
  if(!room) return;
  // 開始時ペア捨てフェイズの進行確認。CPU処理と全員完了判定だけ行う。
  if(room.phase === 'passing'){
    // 3枚パスフェイズの進行確認。CPU処理と全員完了判定だけ行う。
    maybeFinishPassPhase(room);
    return;
  }
  if(room.phase === 'initialPair'){
    maybeFinishInitialPairPhase(room);
    return;
  }
  if(room.phase !== 'playing') return;
  if(!room.players || room.players.length !== 4) return;

  // 0枚/ジョーカー1枚の終了条件をいつでも拾う。
  // pendingPickの結果表示中やtrickReview中は画面演出を優先するが、通常手番中なら即処理。
  if(!room.pendingPick && !room.trickReview){
    const endPid = room.players.findIndex(isRoundEndHand);
    if(endPid >= 0){
      log(room, '⚠️ 終了条件の手札を検知したため、自動でラウンド終了処理へ進みます。');
      checkRoundEnd(room);
      broadcast(room);
      return;
    }
  }

  // 4枚出揃っているのにレビューにもピックにも進んでいない場合は、トリック解決をやり直す。
  if(!room.pendingPick && !room.trickReview && room.trick && room.trick.length===4){
    log(room, '⚠️ トリック解決待ちで停止を検知したため、自動復旧しました。');
    resolveTrick(room);
    broadcast(room);
    return;
  }

  // トリックが5枚以上など不正状態になった場合は、先頭4枚で解決する。
  if(!room.pendingPick && !room.trickReview && room.trick && room.trick.length>4){
    log(room, '⚠️ 場のカード枚数が不正だったため、先頭4枚で復旧しました。');
    room.trick = room.trick.slice(0,4);
    resolveTrick(room);
    broadcast(room);
    return;
  }

  // 通常進行中なのにcurrentがnullで、レビュー・ピック待ちでもない場合は復旧。
  if(room.current == null && !room.pendingPick && !room.trickReview){
    if(room.trick && room.trick.length>0 && room.trick.length<4){
      const lastPid = room.trick[room.trick.length-1].pid;
      room.current = (lastPid + 1) % room.players.length;
      log(room, '⚠️ 手番表示が停止したため、次プレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
    if(!room.trick || room.trick.length===0){
      room.current = Number.isInteger(room.lead) ? room.lead : 0;
      log(room, '⚠️ 手番が未設定だったため、リードプレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
  }

  // currentが範囲外の場合は補正。
  if(room.current != null && (!Number.isInteger(room.current) || room.current < 0 || room.current >= room.players.length)){
    room.current = ((Number(room.current)||0) % room.players.length + room.players.length) % room.players.length;
    log(room, '⚠️ 手番番号が不正だったため、自動補正しました。');
    broadcast(room);
    return;
  }

  // 現在プレイヤーに出せるカードがない場合、終了条件なら終了。そうでなければ状態再送。
  if(!room.pendingPick && !room.trickReview && room.current != null){
    const ids = playableIds(room, room.current);
    if(ids.size === 0){
      if(safeFinishBecauseNoPlayable(room, room.current)) return;
      const now = Date.now();
      if(!room.lastNoPlayableRebroadcastAt || now - room.lastNoPlayableRebroadcastAt > 2500){
        room.lastNoPlayableRebroadcastAt = now;
        log(room, '⚠️ 出せるカードがない状態を検知したため、状態を再送しました。');
        broadcast(room);
        return;
      }
    }
  }

  // ピック候補選択中は最弱プレイヤーの選択待ち。CPUなら自動解決し、人間なら状態を再送する。
  if(room.pendingPick && room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone && !room.pendingPick.result){
    autoResolveCpuPickTargets(room, room.pendingPick);
    const now = Date.now();
    if(!room.lastPickTargetRebroadcastAt || now - room.lastPickTargetRebroadcastAt > 4000){
      room.lastPickTargetRebroadcastAt = now;
      log(room, 'ピック候補選択待ちです。最弱プレイヤーは候補カードを選んでください。');
      broadcast(room);
      return;
    }
  }

  // ペア選択中は結果確定前なので自動で進めない。人間の選択待ちとして状態だけ再送する。
  if(room.pendingPick && room.pendingPick.pairChoice && !room.pendingPick.result){
    const now = Date.now();
    if(!room.lastPairChoiceRebroadcastAt || now - room.lastPairChoiceRebroadcastAt > 4000){
      room.lastPairChoiceRebroadcastAt = now;
      log(room, 'ペア選択待ちです。ペアにするカードを選ぶか、スキップしてください。');
      broadcast(room);
      return;
    }
  }

  // ピック結果が出ているのにpendingPickが残り続けている場合は進める.
  if(room.pendingPick && room.pendingPick.result){
    const age = Date.now() - (room.pendingPick.resultAt || Date.now());
    if(age > 3800){
      log(room, '⚠️ ピック結果表示後に停止を検知したため、自動復旧しました。');
      finishAfterPick(room, room.pendingPick.winnerPid);
      return;
    }
  }

  // 人間の通常手番でUI側が取りこぼした場合に備えて、出せるカードがある状態を定期再送する。
  if(!room.pendingPick && !room.trickReview && room.current != null && !room.players[room.current]?.cpu){
    const ids = playableIds(room, room.current);
    if(ids.size > 0){
      const now = Date.now();
      if(!room.lastHumanTurnRebroadcastAt || now - room.lastHumanTurnRebroadcastAt > 2500){
        room.lastHumanTurnRebroadcastAt = now;
        broadcast(room);
        return;
      }
    }
  }

  // CPU通常手番でタイマーが外れた場合は再予約。
  if(!room.pendingPick && !room.trickReview && isCpuTurn(room) && !room.cpuTimer){
    scheduleCpu(room);
    return;
  }

  // CPUピック待ちで止まっている場合は再予約。
  if(room.pendingPick && !room.pendingPick.result && room.players[room.pendingPick.winnerPid]?.cpu){
    ensureCpuPick(room);
    return;
  }

  // 人間のピック待ちでreadyAtを過ぎても画面が確認中のままにならないよう、状態を再送する。
  if(room.pendingPick && !room.pendingPick.result && !room.players[room.pendingPick.winnerPid]?.cpu){
    if(Date.now() >= room.pendingPick.readyAt && !room.pendingPick.readyBroadcasted){
      room.pendingPick.readyBroadcasted = true;
      broadcast(room);
      return;
    }
    // クリック待ちが長すぎる場合はゲーム停止ではなく、再送だけする。
    if(Date.now() >= room.pendingPick.readyAt + 12000){
      room.pendingPick.readyBroadcasted = false;
      broadcast(room);
      return;
    }
  }

  // レビュー画面で止まっている/タイマーが外れている場合は復旧。
  if(room.trickReview){
    if(room.trickReview.until <= Date.now()){
      advanceReviewToPick(room, room.trickReview.until, room.trickReview.winnerPid, room.trickReview.weakestPid);
      return;
    }
    if(!room.reviewTimer && !room.reviewWatchTimer){
      log(room, '⚠️ トリック確認タイマーが外れていたため、再予約しました。');
      ensureReviewToPick(room, room.trickReview.until, room.trickReview.winnerPid, room.trickReview.weakestPid);
      return;
    }
  }
}

function clearCpuPickTimer(room){
  if(room.cpuPickTimer){
    clearTimeout(room.cpuPickTimer);
    room.cpuPickTimer = null;
  }
}

function ensureCpuPick(room){
  const pp = room.pendingPick;
  if(!pp || pp.result) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  const winner = room.players[pp.winnerPid];
  const weakest = room.players[pp.weakestPid];
  const candidates = pickCandidateCards(room, pp);
  if(!winner || !winner.cpu || !weakest || !candidates.length) return;
  if(room.cpuPickTimer) return;

  // CPUがピック担当になったら、broadcast依存ではなく専用タイマーで必ず進行させる。
  const delay = Math.max(500, pp.readyAt - Date.now() + 450);
  const token = pp.readyAt;
  room.cpuPickTimer = setTimeout(()=>{
    room.cpuPickTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    if(room.pendingPick.readyAt !== token) return;
    if(room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) return;
    const currentWinner = room.players[room.pendingPick.winnerPid];
    const currentCandidates = pickCandidateCards(room, room.pendingPick);
    if(!currentWinner || !currentWinner.cpu || !currentCandidates.length) return;
    doPick(room, currentWinner.id, Math.floor(Math.random() * currentCandidates.length));
  }, delay);

  // 念のためのフェイルセーフ。何らかの理由で上のタイマーが外れても、数秒後に自動復旧。
  if(room.cpuPickFailSafeTimer) clearTimeout(room.cpuPickFailSafeTimer);
  room.cpuPickFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    if(room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) return;
    const currentWinner = room.players[room.pendingPick.winnerPid];
    const currentCandidates = pickCandidateCards(room, room.pendingPick);
    if(!currentWinner || !currentWinner.cpu || !currentCandidates.length) return;
    log(room, '⚠️ CPUピックが遅延したため、自動復旧しました。');
    doPick(room, currentWinner.id, Math.floor(Math.random() * currentCandidates.length));
  }, Math.max(3500, delay + 3500));
}


function isCpuTurn(room){ return room.phase==='playing' && room.current!=null && room.players[room.current]?.cpu && !room.pendingPick; }
function chooseCpuCard(room, pid){
  const allowed = [...playableIds(room, pid)];
  const hand = room.players[pid].hand;
  const cards = allowed.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
  if(!cards.length) return null;
  cards.sort((a,b)=>a.val-b.val || suits.indexOf(a.suit)-suits.indexOf(b.suit));
  if(!room.leadSuit){
    if(hand.filter(c=>!c.joker).length <= 3) return cards[cards.length-1];
    return cards[0];
  }
  const leadPlays = room.trick.filter(x=>x.card.suit===room.leadSuit);
  const high = leadPlays.reduce((m,x)=>Math.max(m,x.card.val),0);
  const follow = cards.filter(c=>c.suit===room.leadSuit);
  if(follow.length){
    const winners = follow.filter(c=>c.val > high).sort((a,b)=>a.val-b.val);
    // 手札が少ない時や安く勝てる時は取りにいく。そうでなければ低く逃げる。
    if(winners.length && (hand.length <= 5 || winners[0].val <= high+2 || Math.random()<0.35)) return winners[0];
    return follow.sort((a,b)=>a.val-b.val)[0];
  }
  // フォロー不能なら、低い通常カードを捨てる。ババブタは出せない。
  return cards[0];
}
function scheduleCpu(room){
  if(room.cpuTimer) return;
  if(room.phase !== 'playing') return;
  if(room.trickReview && room.trickReview.until > Date.now()) return;
  const pp = room.pendingPick;
  if(pp && room.players[pp.winnerPid]?.cpu && !pp.result){
    ensureCpuPick(room);
    return;
  }
  if(isCpuTurn(room)){
    room.cpuTimer = setTimeout(()=>{ room.cpuTimer=null; doCpuPlay(room); }, 900);
  }
}
function doCpuPlay(room){
  if(!isCpuTurn(room)) return;
  const pid = room.current;
  const card = chooseCpuCard(room, pid);
  if(card){
    say(room, pid, cpuPlayLine(room, pid, card));
    playCard(room, room.players[pid].id, card.id);
  } else {
    if(!safeFinishBecauseNoPlayable(room, pid)){
      log(room, `⚠️ ${room.players[pid].name} が出せるカードを持っていないため、状態を再送しました。`);
      broadcast(room);
    }
  }
}
function doCpuPick(room){
  const pp = room.pendingPick;
  if(!pp || pp.result || pp.pairChoice || !room.players[pp.winnerPid]?.cpu) return;
  const weakest = room.players[pp.weakestPid];
  if(!weakest || weakest.hand.length<=0) return;
  doPick(room, room.players[pp.winnerPid].id, Math.floor(Math.random() * weakest.hand.length));
}



function startGame(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.players.length !== 4) { room.message='4人そろうと開始できます。足りない席はCPUを追加してください。'; broadcast(room); return; }
  clearAllProgressTimers(room);
  room.phase='playing'; room.round=1; room.lead=Math.floor(Math.random()*4); room.current=room.lead; room.trick=[]; room.leadSuit=null; room.pendingPick=null; room.trickReview=null; room.stock=[];
  room.roundEndSummary=null; room.finalRoundSummary=null; room.roundEndOutPid=null; room.initialPairDone=[]; room.passDone=[]; room.passSelections={};
  room.roundStart = null;
  room.lastHumanTurnRebroadcastAt = 0; room.lastNoPlayableRebroadcastAt = 0;
  for(const p of room.players){ p.hand=[]; p.scorePile=[]; p.pairs=[]; p.out=false; p.final=null; }
  dealInitial(room);
  log(room, `ぶひぶひ収穫祭スタート！${roomOptionSummary(room)}。通常カードを1枚抜き、全員13枚で開始します。`);

  if(room.passThreeEnabled){
    room.phase='passing';
    room.current=null;
    room.message='3枚パス：ババブタ以外から3枚選んでください。';
    log(room, '3枚パスあり。各プレイヤーは次の手番の人へ通常カードを3枚渡します。ババブタは渡せません。');
    autoResolveCpuPasses(room);
    maybeFinishPassPhase(room);
    return;
  }

  if(room.initialPairDiscardEnabled){
    room.phase='initialPair';
    room.current=null;
    room.message='開始時ペア捨て：ペアを捨てるかスキップしてください。';
    log(room, '開始時ペア捨てあり。各プレイヤーは任意で手札の同じ数字ペアを捨てられます。');
    autoResolveCpuInitialPairs(room);
    maybeFinishInitialPairPhase(room);
    return;
  }

  beginPlayingAfterSetup(room);
}


function dealInitial(room){
  let deck = makeDeck();
  const normals = deck.map((c,i)=>c.joker?-1:i).filter(i=>i>=0);
  const idx = normals[Math.floor(Math.random()*normals.length)];
  room.removedCard = deck.splice(idx,1)[0];
  shuffle(deck);
  for(let i=0;i<13;i++) for(let p=0;p<4;p++) room.players[p].hand.push(deck.pop());
  room.stock = deck;
  room.players.forEach(p=>sortHand(p.hand));
  log(room, `均一配札のため ${cardText(room.removedCard)} を箱に戻しました。`);
}


function passTargetPid(pid){
  return (Number(pid) + 1) % 4;
}

function passSourcePid(pid){
  return (Number(pid) + 3) % 4;
}

function passableCardIds(player){
  return (player.hand || []).filter(c=>c && !c.joker).map(c=>c.id);
}

function autoResolveCpuPasses(room){
  if(!room || room.phase !== 'passing') return;
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    if(!p.cpu) continue;
    if((room.passDone || []).includes(i)) continue;
    const chosen = (p.hand || []).filter(c=>c && !c.joker).slice(0,3).map(c=>c.id);
    submitPassThree(room, p.id, chosen, true);
  }
}

function allPassDone(room){
  return room.players.every((p,i)=>p.cpu || (room.passDone || []).includes(i));
}

function finishPassThreePhase(room){
  if(!room || room.phase !== 'passing') return;
  const transfers = [];
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    const ids = (room.passSelections && room.passSelections[i]) || [];
    if(ids.length !== 3){
      room.message = '3枚パスの選択が足りないプレイヤーがいます。';
      broadcast(room);
      return;
    }
    const cards = [];
    for(const id of ids){
      const idx = p.hand.findIndex(c=>c && c.id === id);
      if(idx < 0){
        room.message = 'パスするカードが手札に見つからないため、状態を再送しました。';
        broadcast(room);
        return;
      }
      const card = p.hand[idx];
      if(card.joker){
        room.message = 'ババブタはパスできません。';
        broadcast(room);
        return;
      }
      cards.push(card);
    }
    transfers.push({from:i, to:passTargetPid(i), ids:[...ids]});
  }

  // 先に全員の手札から抜く。これで同時パス扱いになる。
  const moved = transfers.map(t=>{
    const fromP = room.players[t.from];
    const cards = [];
    for(const id of t.ids){
      const idx = fromP.hand.findIndex(c=>c && c.id === id);
      cards.push(fromP.hand.splice(idx,1)[0]);
    }
    return {...t, cards};
  });

  // 次の手番の人へ渡す。
  for(const t of moved){
    room.players[t.to].hand.push(...t.cards);
  }
  room.players.forEach(p=>sortHand(p.hand));
  room.passSelections = {};
  room.passDone = [];
  assertUniqueActiveCards(room, '3枚パス完了後');

  log(room, '🔁 全員が次の手番の人へ3枚パスしました！ 手札がぐるっと動いたブヒ！');

  if(room.initialPairDiscardEnabled){
    room.phase='initialPair';
    room.current=null;
    room.message='3枚パス完了。開始時ペア捨てへ進みます。';
    log(room, '開始時ペア捨てあり。各プレイヤーは任意で手札の同じ数字ペアを捨てられます。');
    autoResolveCpuInitialPairs(room);
    maybeFinishInitialPairPhase(room);
    return;
  }

  beginPlayingAfterSetup(room);
}

function maybeFinishPassPhase(room){
  if(!room || room.phase !== 'passing') return;
  autoResolveCpuPasses(room);
  if(allPassDone(room)) finishPassThreePhase(room);
  else broadcast(room);
}

function submitPassThree(room, playerId, cardIds, silent=false){
  if(!room || room.phase !== 'passing') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  if((room.passDone || []).includes(pid)) return;

  const ids = Array.isArray(cardIds) ? cardIds.map(String) : [];
  const unique = [...new Set(ids)];
  if(unique.length !== 3){
    if(!silent){ room.message='パスするカードを3枚選んでください。'; broadcast(room); }
    return;
  }

  const p = room.players[pid];
  const allowed = new Set(passableCardIds(p));
  for(const id of unique){
    if(!allowed.has(id)){
      if(!silent){ room.message='ババブタは渡せません。通常カードから3枚選んでください。'; broadcast(room); }
      return;
    }
  }

  if(!room.passSelections) room.passSelections = {};
  if(!room.passDone) room.passDone = [];
  room.passSelections[pid] = unique;
  room.passDone.push(pid);
  if(!silent){
    room.message = `${p.name} が3枚パスするカードを選びました。`;
    log(room, `🔁 ${p.name} が3枚パスを確定しました。`);
  }
  maybeFinishPassPhase(room);
}

function beginPlayingAfterSetup(room){
  if(!room) return;
  room.phase='playing';
  room.current=room.lead;
  room.roundStart = {round:1, text:`第1ラウンド開始！全${room.totalRounds || 3}ラウンド。3枚パス${room.passThreeEnabled ? 'あり' : 'なし'}。開始時ペア捨て${room.initialPairDiscardEnabled ? 'あり' : 'なし'}。`, expiresAt:Date.now()+6500};
  room.message=`第1ラウンド開始。${room.players[room.current].name} からリード。`;
  log(room, '🎬 第1ラウンドを開始します。ぶひぶひ勝負スタート！');
  if(checkRoundEnd(room)) { broadcast(room); return; }
  broadcast(room);
}


function hasInitialPairCandidate(player){
  const counts = new Map();
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    counts.set(c.rank, (counts.get(c.rank)||0)+1);
    if(counts.get(c.rank) >= 2) return true;
  }
  return false;
}

function initialPairCandidatesFor(player, cardId){
  const card = (player.hand || []).find(c=>c && c.id === cardId);
  if(!card || card.joker) return [];
  return player.hand.filter(c=>c && !c.joker && c.rank === card.rank && c.id !== card.id);
}

function initialPairCandidateIds(player){
  const ids = new Set();
  const byRank = new Map();
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    if(!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  for(const group of byRank.values()){
    if(group.length >= 2) group.forEach(c=>ids.add(c.id));
  }
  return [...ids];
}

function markInitialPairDone(room, pid){
  if(!room.initialPairDone) room.initialPairDone = [];
  if(!room.initialPairDone.includes(pid)) room.initialPairDone.push(pid);
}

function allInitialPairDone(room){
  return room.players.every((p,i)=>p.cpu || (room.initialPairDone || []).includes(i) || !hasInitialPairCandidate(p));
}

function autoResolveCpuInitialPairs(room){
  if(!room || room.phase !== 'initialPair') return;
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    if(!p.cpu) continue;
    // CPUは進行停止防止のため、開始時ペアを可能な限り自動で捨てる。
    let safety = 30;
    while(hasInitialPairCandidate(p) && safety-- > 0){
      const ids = initialPairCandidateIds(p);
      const first = p.hand.find(c=>ids.includes(c.id));
      const second = first ? initialPairCandidatesFor(p, first.id)[0] : null;
      if(!first || !second) break;
      discardInitialPair(room, p.id, first.id, second.id, true);
    }
    markInitialPairDone(room, i);
  }
}


function beginPlayingAfterInitialPairs(room){
  if(!room || room.phase !== 'initialPair') return;
  beginPlayingAfterSetup(room);
}


function maybeFinishInitialPairPhase(room){
  if(!room || room.phase !== 'initialPair') return;
  autoResolveCpuInitialPairs(room);
  if(allInitialPairDone(room)) beginPlayingAfterInitialPairs(room);
  else broadcast(room);
}

function discardInitialPair(room, playerId, cardAId, cardBId, silent=false){
  if(!room || room.phase !== 'initialPair') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  if((room.initialPairDone || []).includes(pid)) return;

  const p = room.players[pid];
  const ia = p.hand.findIndex(c=>c && c.id === cardAId);
  const ib = p.hand.findIndex(c=>c && c.id === cardBId);
  if(ia < 0 || ib < 0 || ia === ib){
    if(!silent){ room.message='ペアにするカードを選べませんでした。'; broadcast(room); }
    return;
  }
  const a = p.hand[ia], b = p.hand[ib];
  if(a.joker || b.joker || a.rank !== b.rank){
    if(!silent){ room.message='同じ数字の通常カードだけペアで捨てられます。'; broadcast(room); }
    return;
  }

  const hi = Math.max(ia, ib), lo = Math.min(ia, ib);
  const c1 = p.hand.splice(hi,1)[0];
  const c2 = p.hand.splice(lo,1)[0];
  p.pairs.push(c1, c2);
  sortHand(p.hand);
  assertUniqueActiveCards(room, '開始時ペア捨て後');

  if(!silent){
    room.message = `${p.name} が開始時ペアとして ${a.rank} を捨てました。`;
    log(room, `🧹 ${room.message}`);
  }
  if(!hasInitialPairCandidate(p)) markInitialPairDone(room, pid);
  maybeFinishInitialPairPhase(room);
}

function skipInitialPairs(room, playerId){
  if(!room || room.phase !== 'initialPair') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  markInitialPairDone(room, pid);
  room.message = `${room.players[pid].name} は開始時ペア捨てをスキップしました。`;
  log(room, `⏭️ ${room.message}`);
  maybeFinishInitialPairPhase(room);
}


function playableIds(room, pid){
  pid = Number(pid);
  const p = room.players[pid]; if(!p) return new Set();
  if(room.phase !== 'playing' || room.pendingPick || room.trickReview) return new Set();
  if(Number(room.current) !== pid) return new Set();

  // ババブタは場に出せない。通常カードがない場合は出せるカードなし。
  const nonJoker = p.hand.filter(c=>c && !c.joker);
  if(!nonJoker.length) return new Set();

  // リードスート未設定＝トリック先頭。通常カードなら何でも出せる。
  if(!room.leadSuit) return new Set(nonJoker.map(c=>c.id));

  // マストフォロー。
  const follow = p.hand.filter(c=>c && !c.joker && c.suit===room.leadSuit);
  return new Set((follow.length ? follow : nonJoker).map(c=>c.id));
}
function playCard(room, playerId, cardId){
  const pid = room.players.findIndex(p=>p.id===playerId);
  const allowed = playableIds(room, pid);
  if(!allowed.has(cardId)) { room.message='そのカードは出せません。マストフォロー、またはババブタ不可を確認！'; broadcast(room); return; }
  const p = room.players[pid];
  const idx = p.hand.findIndex(c=>c && c.id===cardId);
  if(idx < 0){
    room.message='そのカードは手札に見つかりません。画面を更新します。';
    log(room, `⚠️ ${p.name} が存在しないカードを出そうとしたため、状態を再送しました。`);
    broadcast(room);
    return;
  }
  const card = p.hand.splice(idx,1)[0];
  room.lastHumanTurnRebroadcastAt = 0;
  if(!room.leadSuit) room.leadSuit = card.suit;
  room.trick.push({pid, card, order:room.trick.length});
  assertUniqueActiveCards(room, 'カードプレイ後');
  room.message = `${p.name} が ${cardText(card)} を出しました。`;
  log(room, room.message);
  if(room.trick.length===4) resolveTrick(room); else room.current=(pid+1)%4;
  broadcast(room);
}

function judgeWeakestCard(room, leadSuit){
  if(!room.trick || !room.trick.length) return null;

  // 最弱判定では、リードスートを非リードスートより強い扱いにする。
  // 非リードスートが1枚でも出ていれば、非リードスートの中で一番低い数字が最弱。
  // 全員がフォローしている場合は、場の4枚の中で一番低い数字が最弱。
  // 同じ数字なら、後に出したカードが最弱。
  const offSuit = room.trick.filter(x=>x.card && x.card.suit !== leadSuit);
  const candidates = offSuit.length ? offSuit : room.trick;

  return candidates.slice().sort((a,b)=>{
    if(a.card.val !== b.card.val) return a.card.val - b.card.val;
    return b.order - a.order;
  })[0];
}


function resolveTrick(room){
  if(!room.trick || room.trick.length < 4){
    log(room, '⚠️ トリック解決に必要な4枚が揃っていないため、処理を中断しました。');
    return;
  }
  if(room.trick.length > 4) room.trick = room.trick.slice(0,4);
  const leadSuit = room.leadSuit || room.trick[0]?.card?.suit;
  room.leadSuit = leadSuit;
  const winner = room.trick.filter(x=>x.card.suit===leadSuit).sort((a,b)=>b.card.val-a.card.val)[0];
  if(!winner){
    log(room, '⚠️ 勝者を判定できなかったため、リードプレイヤーを勝者として復旧しました。');
    return;
  }
  let weakest = judgeWeakestCard(room, leadSuit);
  if(!weakest){
    log(room, '⚠️ 最弱を判定できなかったため、リードカードを最弱として復旧しました。');
    weakest = room.trick[0];
  }
  const wp = room.players[winner.pid], lp = room.players[weakest.pid];

  // トリックの最終盤面を見せるため、ここではまだピック画面に遷移しない。
  const reviewUntil = Date.now() + 5000;
  room.current = null;
  room.trickReview = {winnerPid:winner.pid, weakestPid:weakest.pid, until:reviewUntil};
  room.lastTrick = {
    winnerPid:winner.pid,
    weakestPid:weakest.pid,
    winnerName:wp.name,
    weakestName:lp.name,
    winnerCard:cardText(winner.card),
    weakestCard:cardText(weakest.card),
    expiresAt:reviewUntil + 5000
  };

  if(wp.cpu) say(room, winner.pid, sample(['よし、ごちそう山ゲットだブヒ！','勝ったけど、このあとが怖いブヒ…','取った！でもピックが本番ブヒ。']));
  if(lp.cpu && lp.hand.length>0) say(room, weakest.pid, sample(['えっ、最弱！？やめてブヒ〜！','うわっ、きついな〜。袋を見ないでブヒ！','最弱になったブヒ…嫌な予感しかしないブヒ。']));
  wp.scorePile.push(...room.trick.map(x=>x.card));
  log(room, `👑 ${wp.name} が勝利。場の4枚をごちそう山へ。`);
  log(room, `💀 最弱は ${lp.name}（${cardText(weakest.card)}）。`);
  room.message = `トリック終了！ 👑勝者は ${wp.name}、💀最弱は ${lp.name}。5秒後にババ抜きピックへ進みます。`;

  const reviewToken = reviewUntil;
  ensureReviewToPick(room, reviewToken, winner.pid, weakest.pid);
}


function findPairCandidates(player, drawn){
  if(!player || !drawn || drawn.joker) return [];
  return (player.hand || []).filter(c=>c && !c.joker && c.rank === drawn.rank && c.id !== drawn.id);
}

function completePickWithoutPair(room, pp, drawn){
  const wp = room.players[pp.winnerPid];
  const text = drawn.joker
    ? `${wp.name} はババブタを引いた！`
    : `${wp.name} は ${cardText(drawn)} を手札に加えた。`;
  pp.pairChoice = null;
  pp.result = {drawn, paired:false, skipped:true, text};
  pp.resultAt = Date.now();
  log(room, `🐽 ${text}`);
  if(wp.cpu) say(room, pp.winnerPid, resultLine(drawn, false));
  room.message = text;
  broadcast(room);
  ensurePickFinish(room, pp, pp.winnerPid, 2600);
}

function completePickWithPair(room, pp, drawn, pairCard){
  const wp = room.players[pp.winnerPid];
  const drawnIdx = wp.hand.findIndex(c=>c && c.id===drawn.id);
  const pairIdx = wp.hand.findIndex(c=>c && c.id===pairCard.id);
  if(drawnIdx < 0 || pairIdx < 0 || drawnIdx === pairIdx) return false;

  const first = wp.hand.splice(Math.max(drawnIdx, pairIdx),1)[0];
  const second = wp.hand.splice(Math.min(drawnIdx, pairIdx),1)[0];
  const pairedCards = [first, second];
  wp.pairs.push(...pairedCards);
  sortHand(wp.hand);

  const text = `${wp.name} は ${drawn.rank} のおそろいペアを選んで浄化！`;
  pp.pairChoice = null;
  pp.result = {drawn, paired:true, skipped:false, pairCard, text};
  pp.resultAt = Date.now();
  log(room, `🐽 ${text}`);
  if(wp.cpu) say(room, pp.winnerPid, resultLine(drawn, true));
  else {
    const cpu = room.players.find((p,i)=>p.cpu && i!==pp.winnerPid);
    if(cpu){ const ci=room.players.indexOf(cpu); say(room, ci, resultLine(drawn, true)); }
  }
  room.message = text;
  assertUniqueActiveCards(room, 'ペア選択後');
  broadcast(room);
  ensurePickFinish(room, pp, pp.winnerPid, 2600);
  return true;
}

function resolvePairChoice(room, playerId, selectedCardId, skip=false){
  const pp = room.pendingPick;
  if(!pp || pp.result || !pp.pairChoice) return;
  const chooserPid = room.players.findIndex(p=>p.id===playerId);
  if(chooserPid !== pp.winnerPid) return;

  const wp = room.players[pp.winnerPid];
  const drawn = pp.pairChoice.drawn;
  if(!wp || !drawn) return;

  if(skip){
    completePickWithoutPair(room, pp, drawn);
    return;
  }

  const pairCard = pp.pairChoice.candidates.find(c=>c && c.id === selectedCardId);
  if(!pairCard){
    room.message='ペアにするカードを選べませんでした。もう一度選んでください。';
    broadcast(room);
    return;
  }
  if(pairCard.rank !== drawn.rank || pairCard.joker){
    room.message='同じ数字の通常カードだけペアにできます。';
    broadcast(room);
    return;
  }
  completePickWithPair(room, pp, drawn, pairCard);
}



function submitPickTargets(room, playerId, cardIds, silent=false){
  const pp = room.pendingPick;
  if(!pp || pp.result || pp.pairChoice) return;
  if(!pp.targetSelectionRequired || pp.targetSelectionDone) return;

  const weakestPid = room.players.findIndex(p=>p.id===playerId);
  if(weakestPid !== pp.weakestPid) return;

  const lp = room.players[pp.weakestPid];
  const wp = room.players[pp.winnerPid];
  if(!lp || !wp) return;

  const ids = Array.isArray(cardIds) ? [...new Set(cardIds.map(String))] : [];
  const needed = Math.min(pp.targetCount || 0, lp.hand.length);

  if(ids.length !== needed){
    room.message = `ピック候補を${needed}枚選んでください。`;
    broadcast(room);
    return;
  }

  const handIds = new Set(lp.hand.map(c=>c.id));
  if(!ids.every(id=>handIds.has(id))){
    room.message = 'ピック候補にできないカードが含まれています。';
    broadcast(room);
    return;
  }

  pp.targetCandidateIds = ids;
  pp.targetSelectionDone = true;
  pp.readyAt = Date.now() + 900;
  room.message = `${lp.name} がピック候補を${ids.length}枚に絞りました。${wp.name} が選びます。`;
  log(room, `🎯 ${lp.name} がピック候補を${ids.length}枚に絞りました。`);
  if(!silent && lp.cpu) say(room, pp.weakestPid, 'この中から選ぶブヒ…！');
  const line = cpuPickLine(room, pp.winnerPid, pp.weakestPid); if(line) say(room, pp.winnerPid, line);
  ensureCpuPick(room);
  broadcast(room);
  setTimeout(()=>broadcast(room), 950);
  setTimeout(()=>broadcast(room), 1300);
}


function doPick(room, playerId, targetIndex){
  const pp = room.pendingPick; if(!pp || pp.result || pp.pairChoice) return;
  const chooserPid = room.players.findIndex(p=>p.id===playerId);
  if(chooserPid !== pp.winnerPid) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  if(Date.now() < pp.readyAt) return;
  const wp = room.players[pp.winnerPid], lp = room.players[pp.weakestPid];
  if(!wp || !lp){
    log(room, '⚠️ ピック対象のプレイヤー情報が不正だったため、ピックを終了します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  if(lp.hand.length<=0){
    log(room, '⚠️ 最弱プレイヤーの手札が空だったため、ピックなしで進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }

  const candidates = pickCandidateCards(room, pp);
  if(!candidates.length){
    log(room, '⚠️ ピック候補が空だったため、全手札から復旧してピックします。');
    pp.targetCandidateIds = null;
  }
  const actualCandidates = pickCandidateCards(room, pp);
  if(!actualCandidates.length){
    finishAfterPick(room, pp.winnerPid);
    return;
  }

  if(targetIndex < 0 || targetIndex >= actualCandidates.length || Number.isNaN(targetIndex)) targetIndex = Math.floor(Math.random()*actualCandidates.length);
  const chosen = actualCandidates[targetIndex];
  const handIndex = lp.hand.findIndex(c=>c && c.id === chosen.id);
  if(handIndex < 0){
    log(room, '⚠️ ピック候補カードが手札に見つからないため、ピックなしで進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  const drawn = lp.hand.splice(handIndex,1)[0];
  if(!drawn){
    log(room, '⚠️ ピックカード取得に失敗したため、ピックなしで進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }

  // まず引いたカードを手札に加える。その後、同じ数字のカードがあればペアにするかスキップするかを選ぶ。
  wp.hand.push(drawn);
  sortHand(wp.hand); sortHand(lp.hand);
  assertUniqueActiveCards(room, 'ピック直後');

  const candidatesForPair = findPairCandidates(wp, drawn);

  if(!drawn.joker && candidatesForPair.length){
    pp.pairChoice = {drawn, candidates:candidatesForPair};
    pp.resultAt = null;
    const text = `${wp.name} は ${cardText(drawn)} を引いた。ペアにするカードを選べます。`;
    log(room, `🐽 ${text}`);
    room.message = text;

    // CPUは停止しないよう、同じ数字があれば先頭候補で自動ペア浄化する。
    if(wp.cpu){
      setTimeout(()=>{
        if(room.phase === 'playing' && room.pendingPick === pp && pp.pairChoice && !pp.result){
          completePickWithPair(room, pp, drawn, candidatesForPair[0]);
        }
      }, 900);
    }

    broadcast(room);
    return;
  }

  completePickWithoutPair(room, pp, drawn);
}


function finishAfterPick(room, winnerPid){
  clearReviewTimer(room);
  clearPickFinishTimer(room);
  clearCpuPickTimer(room);
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  if(!room.pendingPick && !room.trick.length) return;
  room.pendingPick=null;
  if(checkRoundEnd(room)) { broadcast(room); return; }
  room.trick=[]; room.leadSuit=null;
  if(!Number.isInteger(winnerPid) || winnerPid < 0 || winnerPid >= room.players.length) winnerPid = room.lead ?? 0;
  room.lead=winnerPid; room.current=winnerPid;
  room.message = `${room.players[winnerPid].name} が次のリードです。`;
  broadcast(room);
}





function makeRoundSnapshot(room, reasonPid, reasonText){
  const useMadPig = room.madPigEnabled !== false;
  const jokerPenaltyValue = room.jokerPenalty ?? 50;
  const penaltyMode = normalizePenaltyMode(room.penaltyMode);
  const rows = room.players.map((p,i)=>{
    const pile = p.scorePile.length;
    const normalHand = p.hand.filter(c=>c && !c.joker).length;
    const hasJoker = p.hand.some(c=>c && c.joker);
    const madPigHand = useMadPig ? p.hand.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPigPile = useMadPig ? p.scorePile.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPig = madPigHand + madPigPile;
    const jokerPenalty = hasJoker ? jokerPenaltyValue : 0;
    const madPigPenalty = madPigPenaltyForRoom(room, p);
    const handPenalty = handPenaltyForRoom(room, p);
    const total = pile - handPenalty - madPigPenalty - jokerPenalty;
    return {
      pid:i,
      name:p.name,
      handCount:p.hand.length,
      normalHand,
      hasJoker,
      pile,
      pairs:Math.floor(p.pairs.length/2),
      madPig,
      madPigHand,
      madPigPile,
      pileScore:pile,
      handPenalty,
      madPigPenalty,
      jokerPenalty,
      total
    };
  });
  return {
    round: room.round,
    reasonPid,
    reasonName: room.players[reasonPid]?.name || '',
    reasonText,
    madPigEnabled: useMadPig,
    jokerPenaltyValue,
    penaltyMode,
    rows,
    createdAt: Date.now()
  };
}



function beginNextRound(room){
  if(!room || room.phase !== 'roundEnd') return;
  clearAllProgressTimers(room);

  const outPid = Number.isInteger(room.roundEndOutPid) ? room.roundEndOutPid : 0;
  const nextRound = Math.min((room.round || 1) + 1, room.totalRounds || 3);
  room.round = nextRound;
  room.phase = 'playing';
  room.trick = [];
  room.leadSuit = null;
  room.pendingPick = null;
  room.trickReview = null;
  room.roundEndSummary = null;
  room.roundEndOutPid = null;
  room.lead = outPid;
  room.current = outPid;
  room.lastHumanTurnRebroadcastAt = 0;
  room.lastNoPlayableRebroadcastAt = 0;
  room.roundStart = {round:nextRound, text:`第${nextRound}ラウンド開始！残り手札を持ち越して、13枚まで補充しました。`, expiresAt:Date.now()+6500};

  let refill = buildUniqueNormalRefillDeck(room);
  const drawRefill = () => {
    while(room.stock.length){
      const c = room.stock.pop();
      if(c && !collectActiveFaceKeys(room).has(cardFaceKey(c))) return c;
    }
    if(!refill.length) refill = buildUniqueNormalRefillDeck(room);
    return refill.pop();
  };
  for(const p of room.players){
    while(p.hand.length<13){
      const card = drawRefill();
      if(card && !collectActiveFaceKeys(room).has(cardFaceKey(card))){
        p.hand.push(card);
      } else {
        break;
      }
    }
    sortHand(p.hand);
  }
  assertUniqueActiveCards(room, `第${nextRound}ラウンド補充後`);
  room.message=`第${nextRound}ラウンド開始。${room.players[room.current].name} からリード。`;
  log(room, room.message);
  broadcast(room);
}

function beginRound2(room){
  beginNextRound(room);
}


function checkRoundEnd(room){
  const outPid = room.players.findIndex(isRoundEndHand);
  if(outPid<0) return false;

  const out = room.players[outPid];
  const onlyJoker = out.hand.length===1 && out.hand[0].joker;
  clearAllProgressTimers(room);
  room.pendingPick = null;
  room.trickReview = null;
  room.trick = [];
  room.leadSuit = null;

  const reasonText = onlyJoker
    ? `${out.name} の袋にババブタ1枚だけが残りました。`
    : `${out.name} の手札がなくなりました。`;

  const snapshot = makeRoundSnapshot(room, outPid, reasonText);
  room.roundEndOutPid = outPid;

  if((room.round || 1) < (room.totalRounds || 3)){
    room.roundEndSummary = snapshot;
    room.phase='roundEnd';
    room.current=null;
    room.message=`第${room.round}ラウンド終了！結果を確認してOKを押すと第${room.round+1}ラウンドへ進みます。`;
    log(room, room.message);
  } else {
    room.finalRoundSummary = snapshot;
    room.roundEndSummary = null;
    room.phase='finished';
    room.current=null;
    room.message = onlyJoker
      ? `${out.name} の袋にババブタ1枚だけが残りました！ゲーム終了。`
      : `${out.name} が上がり！ゲーム終了。`;
    if(out.cpu) say(room, outPid, onlyJoker ? sample(['ババブタだけ残ったブヒ…終わったブヒ…','袋の中がババブタだけブヒ！？']) : sample(['上がり！ごちそう山を数えるブヒ！','決着ブヒ！点数計算だブヒ！']));
    log(room, room.message);
    score(room);
  }
  return true;
}





function score(room){
  const useMadPig = room.madPigEnabled !== false;
  const jokerPenaltyValue = room.jokerPenalty ?? 50;
  const penaltyMode = normalizePenaltyMode(room.penaltyMode);
  for(const p of room.players){
    const pile = p.scorePile.length;
    const normalHand = p.hand.filter(c=>c && !c.joker).length;
    const madPigHand = useMadPig ? p.hand.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPigPile = useMadPig ? p.scorePile.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPig = madPigHand + madPigPile;
    const joker = p.hand.some(c=>c && c.joker) ? 1 : 0;
    const handPenalty = handPenaltyForRoom(room, p);
    const madPigPenalty = madPigPenaltyForRoom(room, p);
    const total = pile - handPenalty - madPigPenalty - joker*jokerPenaltyValue;
    p.final = {pile, normalHand, handPenalty, madPig, madPigHand, madPigPile, madPigPenalty, joker, jokerPenaltyValue, penaltyMode, total};
  }
}




wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch(e){ return; }
    if(msg.type==='create') return createRoom(ws, msg.name, msg.rounds, msg.madPigEnabled, msg.jokerPenalty, msg.initialPairDiscardEnabled, msg.passThreeEnabled, msg.penaltyMode, msg.pickTargetCount);
    if(msg.type==='join') return joinRoom(ws, msg.code, msg.name, msg.playerId);
    if(msg.type==='reconnect') return reconnectRoom(ws, msg.code, msg.playerId, msg.name);
    const room = roomByWs(ws); if(!room) return;
    if(msg.type==='start') startGame(room, ws.playerId);
    if(msg.type==='addCpu') addCpu(room, ws.playerId);
    if(msg.type==='removeCpu') removeCpu(room, ws.playerId);
    if(msg.type==='play') playCard(room, ws.playerId, msg.cardId);
    if(msg.type==='pick') doPick(room, ws.playerId, Number(msg.index));
    if(msg.type==='pickTargets') submitPickTargets(room, ws.playerId, msg.cardIds);
    if(msg.type==='pairChoice') resolvePairChoice(room, ws.playerId, msg.cardId, !!msg.skip);
    if(msg.type==='passThree') submitPassThree(room, ws.playerId, msg.cardIds);
    if(msg.type==='initialPairDiscard') discardInitialPair(room, ws.playerId, String(msg.cardAId||''), String(msg.cardBId||''));
    if(msg.type==='skipInitialPairs') skipInitialPairs(room, ws.playerId);
    if(msg.type==='continueRound') {
      if(room.phase === 'roundEnd'){
        log(room, `ラウンド結果確認OK。第${room.round+1}ラウンドへ進みます。`);
        beginNextRound(room);
      }
    }
  });
  ws.on('close', () => {
    const room = roomByWs(ws); if(!room) return;
    const p = room.players.find(x=>x.id===ws.playerId); if(p && p.ws === ws) {
      p.ws = null;
      log(room, `${p.name} が切断しました。再接続待ちです。`);
      broadcast(room);
    }
    if(room.players.every(p=>!p.ws || p.ws.readyState!==WebSocket.OPEN)) setTimeout(()=>{
      const r = rooms.get(room.code); if(r && r.players.every(p=>!p.ws || p.ws.readyState!==WebSocket.OPEN)) rooms.delete(room.code);
    }, 10*60*1000);
  });
});

server.listen(PORT, () => console.log(`ピピとりオンライン server listening on http://localhost:${PORT}`));

