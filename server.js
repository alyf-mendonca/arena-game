/* =====================================================================
   ARENA DE AÇO & MAGIA — servidor autoritativo (v2)
   ---------------------------------------------------------------------
   Mudanças da v2:
   - Sem bots: só jogadores reais (monstros mantêm a arena viva)
   - Mapa maior: 3600×3600
   - Boss: nível = (maior nível da arena) + 2, persegue o jogador de
     maior nível no mapa inteiro, tem habilidades: Pancada (AoE com
     telegraph), Bola de Fogo (à distância) e Fúria (<30% de vida)
   - Balanceamento:
     · Knight ganha HP por nível (×1.35) e tem Investida (Espaço)
     · Wizard mais ágil (vel. 205) e projétil mais rápido
     · Velocidade cai 3% por nível a partir do nv6 (máx -15%)
     · Quem está 2+ níveis acima da mediana toma dano extra (até +40%)
   - Cadência de ataque por classe (clique importa até o teto):
     · Knight 1 golpe / 300ms · Wizard 1 disparo / 480ms
   - XP: matar alguém ATÉ 3 níveis abaixo dá XP; acima SEMPRE dá.
     Todo jogador vale no mínimo 5 XP (nível 1 incluso).
   - Kills só valem em vida: morreu, zera no ranking de abates.
   - Monstros: 2× o número de jogadores online (mínimo 8)
   - Painel admin escondido em ADMIN_PATH para bufar/nerfar classes
===================================================================== */
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const ADMIN_PATH = process.env.ADMIN_PATH || '/123921839128398213912389213';

/* ---------------- constantes / config viva ---------------- */
const W = 3600, H = 3600;
const TICK_MS = 1000 / 30;
const BROADCAST_EVERY = 2;
const DASH_CD = 2500, DASH_DIST = 140;

// Editável pelo painel admin em tempo real:
const CLASSES = {
  knight: { hp: 300, dmg: 8, regen: 0.010, speed: 185, range: 56,  atkMs: 300, hpGrow: 1.35, projSpeed: 0 },
  wizard: { hp: 100, dmg: 2, regen: 0.020, speed: 205, range: 640, atkMs: 480, hpGrow: 1.00, projSpeed: 560 }
};
const BALANCE = {
  speedNerfStart: 6,      // a partir deste nível a velocidade cai...
  speedNerfPerLvl: 0.03,  // ...3% por nível...
  speedNerfMax: 0.15,     // ...até -15%
  leaderDmgPerLvl: 0.10,  // +10% de dano tomado por nível acima de mediana+1
  leaderDmgMax: 0.40,
  minBounty: 5            // XP mínimo que qualquer jogador vale
};

const XP_LVL = l => 10 * (Math.pow(2, l - 1) - 1);
const levelFromXp = xp => { let l = 1; while (xp >= XP_LVL(l + 1)) l++; return l; };
const dmgAt = (b, l) => b * Math.pow(2, l - 1);
const monsterWorth = l => Math.max(5, 0.5 * XP_LVL(l + 1));
const hpMaxFor = (cls, l) => Math.round(CLASSES[cls].hp * Math.pow(CLASSES[cls].hpGrow, l - 1));
function speedAt(p) {
  const base = CLASSES[p.cls].speed;
  if (p.level < BALANCE.speedNerfStart) return base;
  const nerf = Math.min(BALANCE.speedNerfMax, BALANCE.speedNerfPerLvl * (p.level - BALANCE.speedNerfStart + 1));
  return base * (1 - nerf);
}

const TIER = {
  normal: { hits: 10, r: 14, speed: 95, aggro: 260, names: ['Goblin', 'Lobo', 'Esqueleto'] },
  elite:  { hits: 26, r: 20, speed: 85, aggro: 330, names: ['Ogro', 'Troll', 'Espectro'] },
  boss:   { hits: 60, r: 28, speed: 72, aggro: 1e9, names: ['Dragão', 'Lich', 'Behemoth'] }
};

/* ---------------- estado ---------------- */
const decor = [];
for (let i = 0; i < 100; i++) decor.push({ t: 'tree', x: 80 + Math.random() * (W - 160), y: 80 + Math.random() * (H - 160), r: 20 });
for (let i = 0; i < 60; i++)  decor.push({ t: 'rock', x: 80 + Math.random() * (W - 160), y: 80 + Math.random() * (H - 160), r: 16 });

const players = new Map();
const monsters = new Map();
const projectiles = [];
let fx = [];
let nextId = 1;
const now = () => Date.now();

function freeSpot() {
  for (let t = 0; t < 60; t++) {
    const x = 120 + Math.random() * (W - 240), y = 120 + Math.random() * (H - 240);
    if (!decor.some(d => Math.hypot(d.x - x, d.y - y) < d.r + 40)) return { x, y };
  }
  return { x: W / 2, y: H / 2 };
}
const sanitizeName = n => (String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 14)) || 'Sem Nome';
function addFx(x, y, txt, color, big, snd) { fx.push({ x: Math.round(x), y: Math.round(y), txt, color, big: !!big, snd }); }

/* ---------------- jogadores ---------------- */
function makePlayer(name, cls, socketId) {
  const s = freeSpot();
  const p = {
    id: 'p' + (nextId++), socketId, name, cls,
    x: s.x, y: s.y, dirX: 0, dirY: 0, ang: 0,
    hpMax: hpMaxFor(cls, 1), hp: hpMaxFor(cls, 1),
    xp: 0, level: 1, kills: 0, deaths: 0,
    alive: true, invulnUntil: now() + 2500,
    lastAtk: 0, lastDash: 0, lastRegen: now(), respawnAt: 0, swing: 0
  };
  players.set(p.id, p);
  return p;
}
function respawn(p) {
  const s = freeSpot();
  p.x = s.x; p.y = s.y; p.xp = 0; p.level = 1;
  p.hpMax = hpMaxFor(p.cls, 1); p.hp = p.hpMax;
  p.alive = true; p.invulnUntil = now() + 2500;
}
function arenaMedian() {
  const lv = [...players.values()].map(p => p.level).sort((a, b) => a - b);
  return lv.length ? lv[Math.floor(lv.length / 2)] : 1;
}
function arenaMaxLevel() {
  let m = 1;
  for (const p of players.values()) if (p.level > m) m = p.level;
  return m;
}

/* ---------------- monstros ---------------- */
function spawnMonster() {
  const med = arenaMedian(), roll = Math.random();
  let tier = roll < 0.6 ? 'normal' : roll < 0.9 ? 'elite' : 'boss';
  if (tier === 'boss' && [...monsters.values()].some(m => m.tier === 'boss')) tier = 'elite';
  const l = tier === 'normal' ? Math.max(1, med - (Math.random() < 0.5 ? 1 : 0))
          : tier === 'elite' ? med + 1
          : arenaMaxLevel() + 2;                       // boss escala pelo MAIOR nível
  const T = TIER[tier], hp = T.hits * dmgAt(8, l), s = freeSpot();
  const m = {
    id: 'm' + (nextId++), name: T.names[Math.floor(Math.random() * 3)], tier, level: l,
    x: s.x, y: s.y, r: T.r, hpMax: hp, hp,
    dmg: 0.5 * dmgAt(8, l), worth: monsterWorth(l),
    lastAtk: 0, botNext: 0, targetId: null, wanderX: s.x, wanderY: s.y,
    // boss:
    nextSlam: now() + 4000, nextBolt: 0, cast: null, enraged: false
  };
  monsters.set(m.id, m);
  if (tier === 'boss') {
    io.emit('log', `👑 Um ${m.name} nível ${l} despertou! Ele caça o mais forte da arena.`);
    addFx(m.x, m.y - 50, 'RUGIDO', '#ff6a5e', true, 'roar');
  }
}
function ensureMonsters() {
  const target = Math.max(8, 2 * players.size);
  while (monsters.size < target) spawnMonster();
}

/* ---------------- combate ---------------- */
function applyDamage(victim, dmg, attacker) {
  const t = now();
  const isPlayer = victim.cls !== undefined;
  if (isPlayer && !victim.alive) return;
  if (isPlayer && t < victim.invulnUntil) { addFx(victim.x, victim.y - 26, 'escudo', '#9fd6ff'); return; }
  // líder muito acima da mediana toma dano extra (mecânica de comeback)
  if (isPlayer) {
    const over = victim.level - arenaMedian();
    if (over >= 2) dmg *= 1 + Math.min(BALANCE.leaderDmgMax, BALANCE.leaderDmgPerLvl * (over - 1));
  }
  victim.hp -= dmg;
  addFx(victim.x + (Math.random() * 20 - 10), victim.y - 22, '-' + Math.round(dmg), '#ffd45e', false, 'hit');
  if (victim.hp <= 0) kill(victim, attacker);
}
function kill(victim, attacker) {
  const isPlayer = victim.cls !== undefined;
  if (attacker && attacker.cls !== undefined) {
    if (isPlayer) attacker.kills++;
    const gain = isPlayer ? Math.max(BALANCE.minBounty, victim.xp) : victim.worth;
    // só bloqueia farmar quem está MUITO abaixo; matar acima sempre vale
    const allowed = (attacker.level - victim.level) <= 3;
    if (allowed && gain > 0) {
      attacker.xp += gain;
      addFx(attacker.x, attacker.y - 40, '+' + Math.round(gain) + ' XP', '#9cff7a', true, 'xp');
      const nl = levelFromXp(attacker.xp);
      if (nl > attacker.level) {
        const oldMax = attacker.hpMax;
        attacker.level = nl;
        attacker.hpMax = hpMaxFor(attacker.cls, nl);
        attacker.hp = Math.min(attacker.hpMax, attacker.hp + (attacker.hpMax - oldMax)); // knight ganha o HP novo cheio
        addFx(attacker.x, attacker.y - 64, 'NÍVEL ' + nl + '!', '#ffe27a', true, 'lvl');
        io.emit('log', `⬆ ${attacker.name} alcançou o nível ${nl}!`);
      }
    } else if (gain > 0) {
      addFx(attacker.x, attacker.y - 40, 'sem XP (vítima 4+ abaixo)', '#c8c8c8');
    }
  }
  if (isPlayer) {
    victim.alive = false; victim.hp = 0; victim.deaths++;
    victim.kills = 0;                      // ranking de abates só vale em vida
    victim.respawnAt = now() + 3000;
    addFx(victim.x, victim.y, '', '', false, 'death');
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
  const c = CLASSES[p.cls];
  if (!p.alive || t - p.lastAtk < c.atkMs) return;   // cadência por classe
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
  p.lastAtk = t;
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
    projectiles.push({
      x: p.x, y: p.y, vx: Math.cos(ang) * c.projSpeed, vy: Math.sin(ang) * c.projSpeed,
      dmg: dmgAt(c.dmg, p.level), ownerId: p.id, traveled: 0, max: c.range, boss: false
    });
  }
}
function dash(p) {
  const t = now();
  if (!p.alive || p.cls !== 'knight' || t - p.lastDash < DASH_CD) return;
  p.lastDash = t;
  let dx = p.dirX, dy = p.dirY;
  if (!dx && !dy) { dx = Math.cos(p.ang); dy = Math.sin(p.ang); }
  const n = Math.hypot(dx, dy) || 1;
  // avança em passos para respeitar colisão
  for (let i = 0; i < 7; i++) moveEntity(p, dx / n * DASH_DIST / 7, dy / n * DASH_DIST / 7);
  addFx(p.x, p.y - 10, '»', '#cfe2ff', false, 'dash');
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

/* ---------------- IA dos monstros ---------------- */
function monsterTick(m, dt, t) {
  if (m.tier === 'boss') return bossTick(m, dt, t);
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

/* O boss caça o MAIOR nível do mapa inteiro e tem 3 habilidades:
   - PANCADA: telegraph de 0.9s, depois dano em área (raio 150, 1.6× dano)
   - BOLA DE FOGO: projétil à distância (430 px/s, alcance 1000)
   - FÚRIA: abaixo de 30% de vida fica 45% mais rápido e reduz cooldowns */
function bossTick(m, dt, t) {
  if (t >= m.botNext) {
    m.botNext = t + 600;
    let best = null, bd = 1e9;
    for (const p of players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (!best || p.level > best.level || (p.level === best.level && d < bd)) { best = p; bd = d; }
    }
    m.targetId = best ? best.id : null;
  }
  if (!m.enraged && m.hp < m.hpMax * 0.3) {
    m.enraged = true;
    addFx(m.x, m.y - 50, 'FÚRIA!', '#ff6a5e', true, 'roar');
    io.emit('log', `🔥 O ${m.name} entrou em FÚRIA!`);
  }
  // resolve conjuração em andamento
  if (m.cast) {
    if (t >= m.cast.until) {
      for (const p of players.values()) {
        if (p.alive && Math.hypot(p.x - m.cast.x, p.y - m.cast.y) < m.cast.r) applyDamage(p, m.dmg * 1.6, m);
      }
      addFx(m.cast.x, m.cast.y, 'IMPACTO!', '#ff9a5e', true, 'slam');
      m.cast = null;
    }
    return; // parado enquanto conjura
  }
  const tgt = m.targetId ? players.get(m.targetId) : null;
  if (!tgt || !tgt.alive) return;
  const d = Math.hypot(tgt.x - m.x, tgt.y - m.y), a = Math.atan2(tgt.y - m.y, tgt.x - m.x);
  const sp = TIER.boss.speed * (m.enraged ? 1.45 : 1);
  if (d > m.r + 16) moveEntity(m, Math.cos(a) * sp * dt, Math.sin(a) * sp * dt);
  if (d < m.r + 34 && t - m.lastAtk > (m.enraged ? 600 : 900)) { m.lastAtk = t; applyDamage(tgt, m.dmg, m); }
  if (d < 175 && t >= m.nextSlam) {
    m.nextSlam = t + (m.enraged ? 4000 : 6500);
    m.cast = { type: 'slam', x: m.x, y: m.y, r: 150, until: t + 900, start: t };
  } else if (d >= 175 && t >= m.nextBolt) {
    m.nextBolt = t + (m.enraged ? 1700 : 2800);
    projectiles.push({
      x: m.x, y: m.y, vx: Math.cos(a) * 430, vy: Math.sin(a) * 430,
      dmg: m.dmg, ownerId: m.id, traveled: 0, max: 1000, boss: true
    });
    addFx(m.x, m.y - 50, '🔥', '#ff9a5e', false, 'cast');
  }
}

/* ---------------- loop principal ---------------- */
let tickCount = 0, lastTick = now();
setInterval(() => {
  const t = now();
  const dt = Math.min(0.05, (t - lastTick) / 1000);
  lastTick = t;

  for (const p of players.values()) {
    if (!p.alive) { if (t >= p.respawnAt) respawn(p); continue; }
    if (t - p.lastRegen >= 3000) {
      p.lastRegen = t;
      p.hp = Math.min(p.hpMax, p.hp + p.hpMax * CLASSES[p.cls].regen);
    }
    if (p.dirX || p.dirY) moveEntity(p, p.dirX * speedAt(p) * dt, p.dirY * speedAt(p) * dt);
  }

  for (const m of monsters.values()) monsterTick(m, dt, t);

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    pr.traveled += Math.hypot(pr.vx * dt, pr.vy * dt);
    let hit = pr.traveled > pr.max || pr.x < 0 || pr.x > W || pr.y < 0 || pr.y > H;
    if (!hit) for (const d of decor) { if (Math.hypot(pr.x - d.x, pr.y - d.y) < d.r) { hit = true; break; } }
    if (!hit) {
      const owner = players.get(pr.ownerId) || monsters.get(pr.ownerId);
      let pool;
      if (pr.boss) { pool = []; for (const p of players.values()) if (p.alive) pool.push(p); }
      else pool = targetsExcept(owner || { id: null }).filter(o => o.id !== pr.ownerId);
      const rad = pr.boss ? 22 : 18;
      for (const o of pool) {
        if (Math.hypot(o.x - pr.x, o.y - pr.y) < rad) { applyDamage(o, pr.dmg, owner); hit = true; break; }
      }
    }
    if (hit) projectiles.splice(i, 1);
  }

  if (tickCount % 150 === 0) ensureMonsters();   // ajusta população a cada 5s

  if (++tickCount % BROADCAST_EVERY === 0) {
    io.emit('state', {
      t,
      online: players.size,
      players: [...players.values()].map(p => ({
        id: p.id, name: p.name, cls: p.cls, x: Math.round(p.x), y: Math.round(p.y),
        hp: Math.ceil(p.hp), hpMax: p.hpMax, level: p.level, xp: Math.round(p.xp),
        kills: p.kills, deaths: p.deaths, alive: p.alive,
        inv: t < p.invulnUntil, ang: +p.ang.toFixed(2), swing: p.swing,
        dash: p.cls === 'knight' ? Math.max(0, p.lastDash + DASH_CD - t) : 0
      })),
      monsters: [...monsters.values()].map(m => ({
        id: m.id, name: m.name, tier: m.tier, level: m.level,
        x: Math.round(m.x), y: Math.round(m.y), r: m.r,
        hp: Math.ceil(m.hp), hpMax: m.hpMax, enraged: m.enraged,
        cast: m.cast ? { x: Math.round(m.cast.x), y: Math.round(m.cast.y), r: m.cast.r, until: m.cast.until, start: m.cast.start } : null
      })),
      projectiles: projectiles.map(pr => ({ x: Math.round(pr.x), y: Math.round(pr.y), boss: pr.boss })),
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
    me = makePlayer(sanitizeName(data && data.name), cls, socket.id);
    socket.emit('init', { id: me.id, world: { W, H, decor } });
    io.emit('log', `⚑ ${me.name} entrou na arena como ${cls === 'knight' ? 'Knight' : 'Wizard'}`);
    ensureMonsters();
  });
  socket.on('move', d => {
    if (!me || !d) return;
    let x = +d.x || 0, y = +d.y || 0;
    const n = Math.hypot(x, y);
    if (n > 1) { x /= n; y /= n; }
    me.dirX = x; me.dirY = y;
    if (x || y) me.ang = Math.atan2(y, x);
  });
  socket.on('attack', d => { if (me && d) attack(me, +d.x, +d.y); });
  socket.on('dash', () => { if (me) dash(me); });
  socket.on('disconnect', () => {
    if (!me) return;
    io.emit('log', `✕ ${me.name} deixou a arena`);
    players.delete(me.id);
  });
});

/* ---------------- painel admin escondido ---------------- */
const EDITABLE = ['hp', 'dmg', 'regen', 'speed', 'range', 'atkMs', 'hpGrow', 'projSpeed'];
const EDITABLE_BAL = ['speedNerfStart', 'speedNerfPerLvl', 'speedNerfMax', 'leaderDmgPerLvl', 'leaderDmgMax', 'minBounty'];

app.get(ADMIN_PATH + '/config', (req, res) => {
  res.json({ classes: CLASSES, balance: BALANCE, online: players.size,
    arena: { median: arenaMedian(), max: arenaMaxLevel(), monsters: monsters.size },
    players: [...players.values()].map(p => ({ name: p.name, cls: p.cls, level: p.level, kills: p.kills, alive: p.alive })) });
});
app.post(ADMIN_PATH + '/config', (req, res) => {
  const b = req.body || {};
  if (b.classes) for (const cls of ['knight', 'wizard']) {
    if (!b.classes[cls]) continue;
    for (const k of EDITABLE) {
      const v = +b.classes[cls][k];
      if (Number.isFinite(v) && v >= 0) CLASSES[cls][k] = v;
    }
  }
  if (b.balance) for (const k of EDITABLE_BAL) {
    const v = +b.balance[k];
    if (Number.isFinite(v) && v >= 0) BALANCE[k] = v;
  }
  // reaplica HP máximo aos vivos sem matar ninguém
  for (const p of players.values()) {
    p.hpMax = hpMaxFor(p.cls, p.level);
    p.hp = Math.min(p.hp, p.hpMax);
  }
  io.emit('log', '⚙ Os deuses da arena ajustaram o equilíbrio...');
  res.json({ ok: true });
});
app.get(ADMIN_PATH, (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Painel dos Deuses</title>
<style>
body{font-family:Georgia,serif;background:#1d160a;color:#ead9b0;padding:30px;max-width:880px;margin:auto}
h1{color:#caa84e;border-bottom:2px solid #caa84e;padding-bottom:8px}
h2{margin:22px 0 8px;color:#d8c193;font-size:17px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
label{display:block;font-size:12px;font-family:monospace;color:#b9a87f}
input{width:100%;padding:6px;background:#2c2210;border:2px solid #6b5a33;color:#ead9b0;font-family:monospace}
button{margin-top:18px;background:#8c2b1e;color:#ead9b0;border:2px solid #caa84e;padding:10px 28px;
font-family:inherit;font-size:16px;letter-spacing:1px;cursor:pointer}
button:hover{background:#a93a29}
#status{margin-left:14px;font-family:monospace;font-size:13px}
table{width:100%;border-collapse:collapse;font-family:monospace;font-size:12px;margin-top:8px}
td,th{border:1px solid #6b5a33;padding:4px 8px;text-align:left}
.stat{font-family:monospace;font-size:13px;color:#caa84e}
</style></head><body>
<h1>⚙ Painel dos Deuses da Arena</h1>
<p class="stat" id="stats">carregando...</p>
<div id="form"></div>
<button id="apply">Aplicar ao vivo</button><span id="status"></span>
<h2>Jogadores online</h2>
<table id="ptable"><thead><tr><th>Nome</th><th>Classe</th><th>Nível</th><th>Abates</th><th>Vivo</th></tr></thead><tbody></tbody></table>
<script>
const BASE = location.pathname.replace(/\\/$/, '');
const LBL = {hp:'HP base',dmg:'Dano base',regen:'Regen (fração/3s)',speed:'Velocidade',range:'Alcance (px)',
atkMs:'Cooldown ataque (ms)',hpGrow:'HP × por nível',projSpeed:'Vel. projétil',
speedNerfStart:'Nerf vel. a partir do nv',speedNerfPerLvl:'Nerf vel. por nível',speedNerfMax:'Nerf vel. máx',
leaderDmgPerLvl:'Dano extra líder/nv',leaderDmgMax:'Dano extra líder máx',minBounty:'XP mínimo por kill'};
let cfg=null;
function field(group,key,val){return '<label>'+(LBL[key]||key)+'<input data-g="'+group+'" data-k="'+key+'" value="'+val+'"></label>';}
function render(){
  let h='';
  for (const cls of ['knight','wizard']){
    h+='<h2>'+(cls==='knight'?'⚔️ Knight':'🔮 Wizard')+'</h2><div class="grid">';
    for (const k in cfg.classes[cls]) h+=field('classes.'+cls,k,cfg.classes[cls][k]);
    h+='</div>';
  }
  h+='<h2>⚖ Balanceamento global</h2><div class="grid">';
  for (const k in cfg.balance) h+=field('balance',k,cfg.balance[k]);
  h+='</div>';
  document.getElementById('form').innerHTML=h;
  document.getElementById('stats').textContent=
    'Online: '+cfg.online+' · Nível mediano: '+cfg.arena.median+' · Maior nível: '+cfg.arena.max+' · Monstros: '+cfg.arena.monsters;
  const tb=document.querySelector('#ptable tbody');
  tb.innerHTML=cfg.players.map(function(p){return '<tr><td>'+p.name+'</td><td>'+p.cls+'</td><td>'+p.level+'</td><td>'+p.kills+'</td><td>'+(p.alive?'sim':'não')+'</td></tr>';}).join('')||'<tr><td colspan="5">ninguém online</td></tr>';
}
function load(){fetch(BASE+'/config').then(function(r){return r.json()}).then(function(c){cfg=c;render();});}
document.getElementById('apply').addEventListener('click',function(){
  const body={classes:{knight:{},wizard:{}},balance:{}};
  document.querySelectorAll('input[data-g]').forEach(function(i){
    const g=i.dataset.g,k=i.dataset.k,v=parseFloat(i.value);
    if(!isFinite(v))return;
    if(g==='balance')body.balance[k]=v;else body.classes[g.split('.')[1]][k]=v;
  });
  fetch(BASE+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){return r.json()}).then(function(){document.getElementById('status').textContent='✓ aplicado '+new Date().toLocaleTimeString();load();});
});
load(); setInterval(load, 5000);
</script></body></html>`);
});

ensureMonsters();
server.listen(PORT, () => console.log(
  `Arena de Aço & Magia v2 em http://localhost:${PORT}\nPainel admin: http://localhost:${PORT}${ADMIN_PATH}`));
