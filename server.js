/* =====================================================================
   ARENA DE AÇO & MAGIA — servidor autoritativo
   ---------------------------------------------------------------------
   TODA a lógica do jogo roda aqui: movimento, dano, XP, monstros,
   respawn. O cliente só envia intenções (mover / atacar) e desenha
   o estado que o servidor manda. Isso impede trapaça via console.

   Regras:
   - Knight: 300 HP | dano 8 | alcance 56 | regen 1%/3s | vel 185
   - Wizard: 100 HP | dano 2 | projétil 640px | regen 2%/3s | vel 165
   - Ataque limitado pela velocidade de clique (mínimo 150ms, validado aqui)
   - Dano = base × 2^(nível-1). XP acumulado p/ nível N = 10×(2^(N-1)-1)
   - Last hit absorve TODO o XP da vítima se |Δnível| ≤ 3
   - Monstros escalam com a mediana de nível da arena (normal/elite/chefe)
     dano = metade de jogador do mesmo nível, XP = metade idem
   - Morte: respawn 3s, nível 1, 2.5s de escudo
===================================================================== */
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const NUM_BOTS = Math.max(0, parseInt(process.env.BOTS ?? '4', 10) || 0);

/* ---------------- constantes de jogo ---------------- */
const W = 2400, H = 2400;
const TICK_MS = 1000 / 30;          // física 30x/s
const BROADCAST_EVERY = 2;          // snapshot 15x/s
const MIN_ATTACK_MS = 150;
const CLASSES = {
  knight: { hp: 300, dmg: 8, regen: 0.01, speed: 185, range: 56 },
  wizard: { hp: 100, dmg: 2, regen: 0.02, speed: 165, range: 640 }
};
const XP_LVL = l => 10 * (Math.pow(2, l - 1) - 1);
const levelFromXp = xp => { let l = 1; while (xp >= XP_LVL(l + 1)) l++; return l; };
const dmgAt = (b, l) => b * Math.pow(2, l - 1);
const monsterWorth = l => Math.max(5, 0.5 * XP_LVL(l + 1));
const TIER = {
  normal: { hits: 10, r: 14, speed: 95, aggro: 260, names: ['Goblin', 'Lobo', 'Esqueleto'] },
  elite:  { hits: 26, r: 20, speed: 85, aggro: 330, names: ['Ogro', 'Troll', 'Espectro'] },
  boss:   { hits: 60, r: 28, speed: 70, aggro: 420, names: ['Dragão', 'Lich', 'Behemoth'] }
};
const MONSTER_COUNT = 14;
const BOT_NAMES = ['Sir Baldur', 'Morgana', 'Thorne', 'Lyra do Vale', 'Grom', 'Elandra', 'Cedric'];

/* ---------------- estado do mundo ---------------- */
const decor = [];
for (let i = 0; i < 46; i++) decor.push({ t: 'tree', x: 80 + Math.random() * (W - 160), y: 80 + Math.random() * (H - 160), r: 20 });
for (let i = 0; i < 26; i++) decor.push({ t: 'rock', x: 80 + Math.random() * (W - 160), y: 80 + Math.random() * (H - 160), r: 16 });

const players = new Map();   // id -> player
const monsters = new Map();  // id -> monster
const projectiles = [];
let fx = [];                 // efeitos acumulados até o próximo broadcast
let nextId = 1;
const now = () => Date.now();

function freeSpot() {
  for (let t = 0; t < 60; t++) {
    const x = 120 + Math.random() * (W - 240), y = 120 + Math.random() * (H - 240);
    if (!decor.some(d => Math.hypot(d.x - x, d.y - y) < d.r + 40)) return { x, y };
  }
  return { x: W / 2, y: H / 2 };
}
function sanitizeName(n) {
  n = String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 14);
  return n || 'Sem Nome';
}
function addFx(x, y, txt, color, big) { fx.push({ x, y, txt, color, big: !!big }); }

/* ---------------- jogadores ---------------- */
function makePlayer(name, cls, isBot, socketId) {
  const c = CLASSES[cls], s = freeSpot();
  const p = {
    id: 'p' + (nextId++), socketId, name, cls, isBot,
    x: s.x, y: s.y, dirX: 0, dirY: 0, ang: 0,
    hpMax: c.hp, hp: c.hp, xp: 0, level: 1, kills: 0, deaths: 0,
    alive: true, invulnUntil: now() + 2500, lastAtk: 0, lastRegen: now(),
    respawnAt: 0, swing: 0,
    botNext: 0, botTarget: null, wanderX: s.x, wanderY: s.y
  };
  players.set(p.id, p);
  return p;
}
function respawn(p) {
  const s = freeSpot();
  p.x = s.x; p.y = s.y; p.xp = 0; p.level = 1;
  p.hpMax = CLASSES[p.cls].hp; p.hp = p.hpMax;
  p.alive = true; p.invulnUntil = now() + 2500; p.botTarget = null;
}

/* ---------------- monstros ---------------- */
function arenaLevel() {
  const lv = [...players.values()].map(p => p.level).sort((a, b) => a - b);
  return lv.length ? lv[Math.floor(lv.length / 2)] : 1;
}
function spawnMonster() {
  const base = arenaLevel(), roll = Math.random();
  let tier = roll < 0.6 ? 'normal' : roll < 0.9 ? 'elite' : 'boss';
  if (tier === 'boss' && [...monsters.values()].some(m => m.tier === 'boss')) tier = 'elite';
  const l = tier === 'normal' ? Math.max(1, base - (Math.random() < 0.5 ? 1 : 0))
          : tier === 'elite' ? base + 1 : base + 2;
  const T = TIER[tier], hp = T.hits * dmgAt(8, l), s = freeSpot();
  const m = {
    id: 'm' + (nextId++), name: T.names[Math.floor(Math.random() * 3)], tier, level: l,
    x: s.x, y: s.y, r: T.r, hpMax: hp, hp,
    dmg: 0.5 * dmgAt(8, l), worth: monsterWorth(l),
    lastAtk: 0, botNext: 0, targetId: null, wanderX: s.x, wanderY: s.y
  };
  monsters.set(m.id, m);
}
function ensureMonsters() { while (monsters.size < MONSTER_COUNT) spawnMonster(); }

/* ---------------- combate ---------------- */
function applyDamage(victim, dmg, attacker) {
  const t = now();
  const isPlayer = victim.cls !== undefined;
  if (isPlayer && !victim.alive) return;
  if (isPlayer && t < victim.invulnUntil) { addFx(victim.x, victim.y - 26, 'escudo', '#9fd6ff'); return; }
  victim.hp -= dmg;
  addFx(victim.x + (Math.random() * 20 - 10), victim.y - 22, '-' + Math.round(dmg), '#ffd45e');
  if (victim.hp <= 0) kill(victim, attacker);
}
function kill(victim, attacker) {
  const isPlayer = victim.cls !== undefined;
  if (attacker && attacker.cls !== undefined) {
    if (isPlayer) attacker.kills++;
    const gain = isPlayer ? victim.xp : victim.worth;
    if (Math.abs(attacker.level - victim.level) <= 3 && gain > 0) {
      attacker.xp += gain;
      addFx(attacker.x, attacker.y - 40, '+' + Math.round(gain) + ' XP', '#9cff7a', true);
      const nl = levelFromXp(attacker.xp);
      if (nl > attacker.level) {
        attacker.level = nl;
        addFx(attacker.x, attacker.y - 64, 'NÍVEL ' + nl + '!', '#ffe27a', true);
        io.emit('log', `⬆ ${attacker.name} alcançou o nível ${nl}!`);
      }
    } else if (gain > 0) {
      addFx(attacker.x, attacker.y - 40, 'sem XP (>3 níveis)', '#c8c8c8');
    }
  }
  if (isPlayer) {
    victim.alive = false; victim.hp = 0; victim.deaths++;
    victim.respawnAt = now() + 3000;
    const killerName = attacker ? attacker.name : 'a arena';
    io.emit('log', `💀 ${victim.name} (nv${victim.level}) caiu para ${killerName}`);
    if (victim.socketId) io.to(victim.socketId).emit('killed', { by: killerName, respawnAt: victim.respawnAt });
  } else {
    if (victim.tier === 'boss') io.emit('log', `👑 ${attacker ? attacker.name : '???'} deu o golpe final no ${victim.name}!`);
    monsters.delete(victim.id);
    setTimeout(ensureMonsters, 2500);
  }
}
function attack(p, tx, ty) {
  const t = now();
  if (!p.alive || t - p.lastAtk < MIN_ATTACK_MS) return;
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
  p.lastAtk = t;
  const c = CLASSES[p.cls];
  const ang = Math.atan2(ty - p.y, tx - p.x);
  p.ang = ang;
  if (p.cls === 'knight') {
    p.swing = t;
    const dmg = dmgAt(c.dmg, p.level);
    for (const o of targetsExcept(p)) {
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d > c.range) continue;
      let da = Math.atan2(o.y - p.y, o.x - p.x) - ang;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) < 1.1) applyDamage(o, dmg, p);
    }
  } else {
    const sp = 520;
    projectiles.push({
      x: p.x, y: p.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      dmg: dmgAt(c.dmg, p.level), ownerId: p.id, traveled: 0, max: c.range
    });
  }
}
function targetsExcept(p) {
  const out = [];
  for (const o of players.values()) if (o !== p && o.alive) out.push(o);
  for (const m of monsters.values()) out.push(m);
  return out;
}

/* ---------------- física ---------------- */
function moveEntity(e, dx, dy) {
  e.x = Math.max(30, Math.min(W - 30, e.x + dx));
  e.y = Math.max(30, Math.min(H - 30, e.y + dy));
  for (const d of decor) {
    const dist = Math.hypot(e.x - d.x, e.y - d.y), min = d.r + 14;
    if (dist < min && dist > 0.01) {
      e.x = d.x + (e.x - d.x) / dist * min;
      e.y = d.y + (e.y - d.y) / dist * min;
    }
  }
}

/* ---------------- IA: bots ---------------- */
function botThink(p, t) {
  if (t < p.botNext) return;
  p.botNext = t + 280 + Math.random() * 200;
  const enemies = targetsExcept(p);
  if (p.hp < p.hpMax * 0.22) {
    let near = null, nd = 1e9;
    for (const e of enemies) { const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < nd) { nd = d; near = e; } }
    if (near && nd < 420) { p.botTarget = { flee: near.id, monster: near.cls === undefined }; return; }
  }
  let best = null, bs = -1e9;
  for (const e of enemies) {
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d > 560) continue;
    const givesXp = Math.abs(p.level - e.level) <= 3;
    let score = 400 - d + (givesXp ? 250 : -300) + (p.level - e.level) * 60;
    if (e.cls === undefined) {
      score -= e.tier === 'boss' ? 260 : e.tier === 'elite' ? 130 : 40;
      score += (1 - e.hp / e.hpMax) * 320;   // monstro machucado = chance de last hit
    }
    if (score > bs) { bs = score; best = e; }
  }
  p.botTarget = best ? { hunt: best.id, monster: best.cls === undefined } : null;
  if (!best && Math.hypot(p.wanderX - p.x, p.wanderY - p.y) < 60) {
    const s = freeSpot(); p.wanderX = s.x; p.wanderY = s.y;
  }
}
function getEnt(ref) {
  if (!ref) return null;
  return ref.monster ? monsters.get(ref.hunt || ref.flee) : players.get(ref.hunt || ref.flee);
}
function botMove(p, dt, t) {
  const c = CLASSES[p.cls];
  let mx = 0, my = 0;
  const tgt = p.botTarget;
  const fleeEnt = tgt && tgt.flee ? getEnt(tgt) : null;
  const huntEnt = tgt && tgt.hunt ? getEnt(tgt) : null;
  if (fleeEnt) {
    const a = Math.atan2(p.y - fleeEnt.y, p.x - fleeEnt.x); mx = Math.cos(a); my = Math.sin(a);
  } else if (huntEnt && (huntEnt.alive !== false)) {
    const d = Math.hypot(huntEnt.x - p.x, huntEnt.y - p.y), a = Math.atan2(huntEnt.y - p.y, huntEnt.x - p.x);
    p.ang = a;
    if (p.cls === 'knight') {
      if (d > c.range * 0.7) { mx = Math.cos(a); my = Math.sin(a); }
      if (d <= c.range) attack(p, huntEnt.x, huntEnt.y);
    } else {
      if (d < 180) { mx = -Math.cos(a); my = -Math.sin(a); }
      else if (d > 420) { mx = Math.cos(a); my = Math.sin(a); }
      if (d < 560 && t - p.lastAtk > 420 + Math.random() * 260) attack(p, huntEnt.x, huntEnt.y);
    }
  } else {
    const a = Math.atan2(p.wanderY - p.y, p.wanderX - p.x); mx = Math.cos(a) * 0.6; my = Math.sin(a) * 0.6;
  }
  moveEntity(p, mx * c.speed * dt, my * c.speed * dt);
}

/* ---------------- IA: monstros ---------------- */
function monsterTick(m, dt, t) {
  const T = TIER[m.tier];
  if (t >= m.botNext) {
    m.botNext = t + 400;
    let near = null, nd = 1e9;
    for (const p of players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < nd && d < T.aggro) { nd = d; near = p; }
    }
    m.targetId = near ? near.id : null;
    if (!near && Math.hypot(m.wanderX - m.x, m.wanderY - m.y) < 40) {
      m.wanderX = Math.max(80, Math.min(W - 80, m.x + (Math.random() * 400 - 200)));
      m.wanderY = Math.max(80, Math.min(H - 80, m.y + (Math.random() * 400 - 200)));
    }
  }
  let mx = 0, my = 0;
  const tgt = m.targetId ? players.get(m.targetId) : null;
  if (tgt && tgt.alive) {
    const d = Math.hypot(tgt.x - m.x, tgt.y - m.y), a = Math.atan2(tgt.y - m.y, tgt.x - m.x);
    if (d > m.r + 14) { mx = Math.cos(a); my = Math.sin(a); }
    if (d < m.r + 30 && t - m.lastAtk > 900) { m.lastAtk = t; applyDamage(tgt, m.dmg, m); }
  } else {
    const a = Math.atan2(m.wanderY - m.y, m.wanderX - m.x); mx = Math.cos(a) * 0.5; my = Math.sin(a) * 0.5;
  }
  moveEntity(m, mx * T.speed * dt, my * T.speed * dt);
}

/* ---------------- loop principal ---------------- */
let tickCount = 0, lastTick = now();
setInterval(() => {
  const t = now();
  const dt = Math.min(0.05, (t - lastTick) / 1000);
  lastTick = t;

  for (const p of players.values()) {
    if (!p.alive) { if (t >= p.respawnAt) respawn(p); continue; }
    // regen individual a cada 3s
    if (t - p.lastRegen >= 3000) {
      p.lastRegen = t;
      p.hp = Math.min(p.hpMax, p.hp + p.hpMax * CLASSES[p.cls].regen);
    }
    if (p.isBot) { botThink(p, t); botMove(p, dt, t); }
    else if (p.dirX || p.dirY) {
      moveEntity(p, p.dirX * CLASSES[p.cls].speed * dt, p.dirY * CLASSES[p.cls].speed * dt);
    }
  }

  for (const m of monsters.values()) monsterTick(m, dt, t);

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    pr.traveled += Math.hypot(pr.vx * dt, pr.vy * dt);
    let hit = pr.traveled > pr.max || pr.x < 0 || pr.x > W || pr.y < 0 || pr.y > H;
    if (!hit) for (const d of decor) { if (Math.hypot(pr.x - d.x, pr.y - d.y) < d.r) { hit = true; break; } }
    if (!hit) {
      const owner = players.get(pr.ownerId);
      for (const o of targetsExcept(owner || { id: null })) {
        if (o.id === pr.ownerId) continue;
        if (Math.hypot(o.x - pr.x, o.y - pr.y) < 18) { applyDamage(o, pr.dmg, owner); hit = true; break; }
      }
    }
    if (hit) projectiles.splice(i, 1);
  }

  // broadcast 15x/s
  if (++tickCount % BROADCAST_EVERY === 0) {
    io.emit('state', {
      t,
      players: [...players.values()].map(p => ({
        id: p.id, name: p.name, cls: p.cls, x: Math.round(p.x), y: Math.round(p.y),
        hp: Math.ceil(p.hp), hpMax: p.hpMax, level: p.level, xp: Math.round(p.xp),
        kills: p.kills, deaths: p.deaths, alive: p.alive,
        inv: t < p.invulnUntil, ang: +p.ang.toFixed(2), swing: p.swing, bot: p.isBot
      })),
      monsters: [...monsters.values()].map(m => ({
        id: m.id, name: m.name, tier: m.tier, level: m.level,
        x: Math.round(m.x), y: Math.round(m.y), r: m.r,
        hp: Math.ceil(m.hp), hpMax: m.hpMax
      })),
      projectiles: projectiles.map(pr => ({ x: Math.round(pr.x), y: Math.round(pr.y) })),
      fx
    });
    fx = [];
  }
}, TICK_MS);

/* ---------------- rede ---------------- */
io.on('connection', socket => {
  let me = null;

  socket.on('join', data => {
    if (me) return;
    const cls = data && data.cls === 'wizard' ? 'wizard' : 'knight';
    me = makePlayer(sanitizeName(data && data.name), cls, false, socket.id);
    socket.emit('init', { id: me.id, world: { W, H, decor } });
    io.emit('log', `⚑ ${me.name} entrou na arena como ${cls === 'knight' ? 'Knight' : 'Wizard'}`);
  });

  socket.on('move', d => {
    if (!me || !d) return;
    let x = +d.x || 0, y = +d.y || 0;
    const n = Math.hypot(x, y);
    if (n > 1) { x /= n; y /= n; }            // clamp anti-speedhack
    me.dirX = x; me.dirY = y;
    if (x || y) me.ang = Math.atan2(y, x);
  });

  socket.on('attack', d => {
    if (!me || !d) return;
    attack(me, +d.x, +d.y);
  });

  socket.on('disconnect', () => {
    if (!me) return;
    io.emit('log', `✕ ${me.name} deixou a arena`);
    players.delete(me.id);
  });
});

/* ---------------- bots iniciais ---------------- */
for (let i = 0; i < NUM_BOTS; i++) {
  makePlayer(BOT_NAMES[i % BOT_NAMES.length], Math.random() < 0.5 ? 'knight' : 'wizard', true, null);
}
ensureMonsters();

server.listen(PORT, () => console.log(`Arena de Aço & Magia rodando em http://localhost:${PORT} (bots: ${NUM_BOTS})`));
