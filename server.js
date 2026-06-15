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

/* RODADA: jogo em turnos de 10 min, vence quem tiver mais ABATES de PVP. */
const ROUND_MS = 10 * 60 * 1000;
const INTERMISSION_MS = 15 * 1000;       // tela de vencedor entre rodadas

/* NOVA FILOSOFIA (v4): habilidade > level.
   - Combate letal: ~5 acertos matam, entre QUAISQUER níveis.
   - HP de uma classe = hitsToKill × dano da classe oposta (quase fixo).
   - Level quase não muda o dano; dá um pouco de HP e adianta o especial.
   - Especial no botão direito, cooldown 10s: define o jogo. */
const HITS_TO_KILL = 5;                   // quantos acertos do oponente te matam

// Editável pelo painel admin em tempo real:
const CLASSES = {
  knight: { dmg: 20, regen: 0.012, speed: 190, range: 60,  atkMs: 360, projSpeed: 0,   special: 'charge' },
  wizard: { dmg: 16, regen: 0.020, speed: 210, range: 600, atkMs: 520, projSpeed: 580, special: 'nova' }
};
/* HP base de cada classe é derivado: aguentar HITS_TO_KILL golpes do oponente.
   Knight apanha do wizard (16) e o wizard apanha do knight (20). Damos ao knight
   um bônus de tankiness (1.5×) pra manter a sua métrica de knight mais resistente. */
const KNIGHT_TANK = 1.25;
function baseHp(cls){
  if (cls === 'knight') return Math.round(HITS_TO_KILL * CLASSES.wizard.dmg * KNIGHT_TANK);
  return Math.round(HITS_TO_KILL * CLASSES.knight.dmg);
}

const BALANCE = {
  hpPerLvl: 0.05,         // +5% de HP por nível (level dá só uma vantagem leve)
  dmgPerLvl: 0.015,       // +1,5% de dano por nível (quase nada — habilidade manda)
  xpGrowth: 1.45,
  specialCd: 10000,
  specialCdPerLvl: 400,
  deathPenalty: 1,
  minBounty: 5
};

const XP_LVL = l => Math.round(20 * (Math.pow(BALANCE.xpGrowth, l - 1) - 1) / (BALANCE.xpGrowth - 1));
const levelFromXp = xp => { let l = 1; while (xp >= XP_LVL(l + 1)) l++; return l; };
const dmgAt = (b, l) => b * (1 + BALANCE.dmgPerLvl * (l - 1));            // dano quase plano
const monsterWorth = l => Math.max(BALANCE.minBounty, Math.round(0.5 * (XP_LVL(l + 1) - XP_LVL(l))));
const hpMaxFor = (cls, l) => Math.round(baseHp(cls) * (1 + BALANCE.hpPerLvl * (l - 1)));
const specialCdFor = p => Math.max(5000, BALANCE.specialCd - BALANCE.specialCdPerLvl * (p.level - 1));
const speedAt = p => CLASSES[p.cls].speed;   // velocidade fixa: agilidade é skill, não level

/* Monstros: PVM dinâmico. HP calibrado em "golpes médios" pra morrerem rápido. */
const TIER = {
  normal: { hits: 4,  r: 14, speed: 95, aggro: 260, names: ['Goblin', 'Lobo', 'Esqueleto'] },
  elite:  { hits: 9,  r: 20, speed: 85, aggro: 330, names: ['Ogro', 'Troll', 'Espectro'] },
  boss:   { hits: 22, r: 28, speed: 74, aggro: 1e9, names: ['Dragão', 'Lich', 'Behemoth'] }
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

/* estado da rodada: 'playing' por 10 min, depois 'intermission' mostrando o vencedor */
const round = { phase: 'playing', endsAt: now() + ROUND_MS, winner: null };

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
    lastAtk: 0, lastSpecial: -1e9, lastRegen: now(), respawnAt: 0, swing: 0,
    stunUntil: 0, kbX: 0, kbY: 0,           // atordoamento e empurrão (knockback)
    chargeUntil: 0, chargeHit: false,       // estado da Investida do knight
    holding: false, aimX: s.x, aimY: s.y, special: 0
  };
  players.set(p.id, p);
  return p;
}
function respawn(p) {
  const s = freeSpot();
  // Rodada baseada em habilidade: mantém level/xp ganhos; a morte custa ABATES.
  p.x = s.x; p.y = s.y;
  p.hpMax = hpMaxFor(p.cls, p.level); p.hp = p.hpMax;
  p.alive = true; p.invulnUntil = now() + 2000;
  p.stunUntil = 0; p.kbX = 0; p.kbY = 0; p.holding = false;
}
function arenaMaxLevel() {
  let m = 1;
  for (const p of players.values()) if (p.level > m) m = p.level;
  return m;
}

/* ---------------- monstros ---------------- */
function avgPlayerLevel() {
  let sum = 0, n = 0;
  for (const p of players.values()) { sum += p.level; n++; }
  return n ? Math.max(1, Math.round(sum / n)) : 1;
}
function spawnMonster() {
  const med = avgPlayerLevel(), roll = Math.random();
  let tier = roll < 0.6 ? 'normal' : roll < 0.9 ? 'elite' : 'boss';
  if (tier === 'boss' && [...monsters.values()].some(m => m.tier === 'boss')) tier = 'elite';
  const l = tier === 'normal' ? Math.max(1, med - (Math.random() < 0.5 ? 1 : 0))
          : tier === 'elite' ? med + 1
          : arenaMaxLevel() + 2;
  // dano médio de referência das classes no nível do mob (dano quase plano agora)
  const refDmg = (dmgAt(CLASSES.knight.dmg, l) + dmgAt(CLASSES.wizard.dmg, l)) / 2;
  const T = TIER[tier], hp = Math.round(T.hits * refDmg), s = freeSpot();
  const m = {
    id: 'm' + (nextId++), name: T.names[Math.floor(Math.random() * 3)], tier, level: l,
    x: s.x, y: s.y, r: T.r, hpMax: hp, hp,
    dmg: Math.round(0.5 * refDmg), worth: monsterWorth(l),
    lastAtk: 0, botNext: 0, targetId: null, wanderX: s.x, wanderY: s.y,
    nextSlam: now() + 4000, nextBolt: 0, cast: null, enraged: false
  };
  monsters.set(m.id, m);
  if (tier === 'boss') io.emit('log', `👑 Um ${m.name} nível ${l} despertou! Ele caça o mais forte da arena.`);
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
  victim.hp -= dmg;
  addFx(victim.x + (Math.random() * 20 - 10), victim.y - 22, '-' + Math.round(dmg), '#ffd45e', false, 'hit');
  if (victim.hp <= 0) kill(victim, attacker);
}
// aplica atordoamento + empurrão (usado pelos especiais)
function applyStun(victim, ms, fromX, fromY, force) {
  if (victim.cls === undefined) { // monstro: só empurra levemente
    const a = Math.atan2(victim.y - fromY, victim.x - fromX);
    victim.x += Math.cos(a) * force * 0.5; victim.y += Math.sin(a) * force * 0.5;
    return;
  }
  if (now() < victim.invulnUntil) return;
  victim.stunUntil = Math.max(victim.stunUntil, now() + ms);
  const a = Math.atan2(victim.y - fromY, victim.x - fromX);
  victim.kbX = Math.cos(a) * force; victim.kbY = Math.sin(a) * force;
}
function kill(victim, attacker) {
  const isPlayer = victim.cls !== undefined;
  if (attacker && attacker.cls !== undefined) {
    const gain = isPlayer ? Math.max(BALANCE.minBounty, victim.xp ? Math.round(victim.xp * 0.3) : BALANCE.minBounty) : victim.worth;
    // PVP conta como ABATE no placar da rodada; matar quem está 4+ abaixo não dá XP
    if (isPlayer) {
      attacker.kills++;
      addFx(attacker.x, attacker.y - 48, 'ABATE!', '#ff7a7a', true, 'kill');
    }
    const allowed = (attacker.level - victim.level) <= 3;
    if (allowed && gain > 0) {
      attacker.xp += gain;
      const nl = levelFromXp(attacker.xp);
      if (nl > attacker.level) {
        attacker.level = nl;
        attacker.hpMax = hpMaxFor(attacker.cls, nl);
        attacker.hp = attacker.hpMax;
        attacker.lastRegen = now();
        addFx(attacker.x, attacker.y - 64, 'NÍVEL ' + nl + '!', '#ffe27a', true, 'lvl');
        io.emit('log', `⬆ ${attacker.name} chegou ao nível ${nl} (especial mais rápido!)`);
      }
    }
  }
  if (isPlayer) {
    victim.alive = false; victim.hp = 0; victim.deaths++;
    victim.kills = Math.max(0, victim.kills - BALANCE.deathPenalty);   // morrer custa abates
    victim.holding = false;
    victim.respawnAt = now() + 2500;
    const killerName = attacker ? attacker.name : 'a arena';
    io.emit('log', `💀 ${victim.name} caiu para ${killerName} (−${BALANCE.deathPenalty} abate)`);
    if (victim.socketId) io.to(victim.socketId).emit('killed', { by: killerName, respawnAt: victim.respawnAt });
  } else {
    if (victim.tier === 'boss') io.emit('log', `👑 ${attacker ? attacker.name : '???'} derrubou o ${victim.name}!`);
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
    // alcance curto (56px): varre direto jogadores+monstros próximos, sem depender
    // da grade (que pode estar defasada quando o clique chega entre ticks)
    const scan = o => {
      if (o === p || o.alive === false) return;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d > c.range) return;
      let da = Math.atan2(o.y - p.y, o.x - p.x) - ang;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) < 1.1) applyDamage(o, dmg, p);
    };
    for (const o of players.values()) scan(o);
    for (const m of monsters.values()) scan(m);
  } else {
    projectiles.push({
      x: p.x, y: p.y, vx: Math.cos(ang) * c.projSpeed, vy: Math.sin(ang) * c.projSpeed,
      dmg: dmgAt(c.dmg, p.level), ownerId: p.id, traveled: 0, max: c.range, boss: false
    });
  }
}
// ESPECIAL (botão direito, cooldown ~10s, reduz com level)
function useSpecial(p, tx, ty) {
  const t = now();
  if (!p.alive || t < p.stunUntil) return;
  if (t - p.lastSpecial < specialCdFor(p)) return;
  p.lastSpecial = t;
  if (Number.isFinite(tx) && Number.isFinite(ty)) p.ang = Math.atan2(ty - p.y, tx - p.x);

  if (p.cls === 'knight') {
    // INVESTIDA BRUTAL: avança forte na direção da mira; primeiro acerto atordoa + dano pesado
    const ang = p.ang, DIST = 230;
    for (let i = 0; i < 9; i++) moveEntity(p, Math.cos(ang) * DIST / 9, Math.sin(ang) * DIST / 9);
    addFx(p.x, p.y, 'INVESTIDA', '#cfe2ff', true, 'charge');
    const dmg = dmgAt(CLASSES.knight.dmg, p.level) * 1.8;
    let best = null, bd = 90;
    const scan = o => {
      if (o === p || o.alive === false) return;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < bd) { bd = d; best = o; }
    };
    for (const o of players.values()) scan(o);
    for (const m of monsters.values()) scan(m);
    if (best) {
      applyStun(best, 1100, p.x, p.y, 70);
      applyDamage(best, dmg, p);
      addFx(best.x, best.y - 30, 'ATORDOADO!', '#ffd14e', true);
    }
  } else {
    // NOVA ARCANA: explosão em volta do mago, empurra e fere todos por perto (disengage)
    const R = 220, dmg = dmgAt(CLASSES.wizard.dmg, p.level) * 1.4;
    addFx(p.x, p.y, 'NOVA ARCANA', '#bda1ff', true, 'nova');
    const scan = o => {
      if (o === p || o.alive === false) return;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d > R) return;
      applyStun(o, 500, p.x, p.y, 150);
      applyDamage(o, dmg, p);
    };
    for (const o of players.values()) scan(o);
    for (const m of monsters.values()) scan(m);
    p.novaFx = t;   // marca p/ desenhar o anel no cliente
  }
}


/* ---------------- grade espacial (performance) ----------------
   Em vez de cada movimento/ataque varrer TODAS as entidades (O(n²)),
   dividimos o mundo em células de CELL px e só olhamos as células vizinhas.
   - decorGrid: estático, montado uma vez (árvores/pedras)
   - entityGrid: remontado a cada tick com jogadores vivos + monstros */
const CELL = 200;
const GW = Math.ceil(W / CELL);
const cellIndex = (x, y) => Math.max(0, Math.min(GW - 1, x / CELL | 0)) + Math.max(0, Math.min(GW - 1, y / CELL | 0)) * GW;

const decorGrid = new Map();
for (const d of decor) {
  const k = cellIndex(d.x, d.y);
  if (!decorGrid.has(k)) decorGrid.set(k, []);
  decorGrid.get(k).push(d);
}
let entityGrid = new Map();
function rebuildEntityGrid() {
  entityGrid = new Map();
  const add = e => {
    const k = cellIndex(e.x, e.y);
    if (!entityGrid.has(k)) entityGrid.set(k, []);
    entityGrid.get(k).push(e);
  };
  for (const p of players.values()) if (p.alive) add(p);
  for (const m of monsters.values()) add(m);
}
// chama fn para cada entidade nas 9 células ao redor de (x,y)
function forEachNear(grid, x, y, fn) {
  const cx = Math.max(0, Math.min(GW - 1, x / CELL | 0));
  const cy = Math.max(0, Math.min(GW - 1, y / CELL | 0));
  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= GW) continue;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= GW) continue;
      const arr = grid.get(gx + gy * GW);
      if (arr) for (const e of arr) fn(e);
    }
  }
}

/* ---------------- física ---------------- */
function moveEntity(e, dx, dy) {
  if (!Number.isFinite(dx)) dx = 0;        // delta inválido nunca corrompe a posição
  if (!Number.isFinite(dy)) dy = 0;
  if (!Number.isFinite(e.x)) e.x = W / 2;  // auto-cura caso já tenha corrompido
  if (!Number.isFinite(e.y)) e.y = H / 2;
  e.x = Math.max(30, Math.min(W - 30, e.x + dx));
  e.y = Math.max(30, Math.min(H - 30, e.y + dy));
  forEachNear(decorGrid, e.x, e.y, d => {
    const dist = Math.hypot(e.x - d.x, e.y - d.y), min = d.r + 14;
    if (dist < min && dist > 0.01) {
      e.x = d.x + (e.x - d.x) / dist * min;
      e.y = d.y + (e.y - d.y) / dist * min;
    }
  });
}

/* ---------------- IA dos monstros ---------------- */
function monsterTick(m, dt, t) {
  if (m.tier === 'boss') return bossTick(m, dt, t);
  const T = TIER[m.tier];
  if (t >= m.botNext) {
    m.botNext = t + 400;
    let near = null, nd = 1e9;
    forEachNear(entityGrid, m.x, m.y, p => {
      if (p.cls === undefined || !p.alive) return;       // só jogadores
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < nd && d < T.aggro) { nd = d; near = p; }
    });
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
  const sp = TIER.boss.speed * (m.enraged ? 1.35 : 1);
  if (d > m.r + 16) moveEntity(m, Math.cos(a) * sp * dt, Math.sin(a) * sp * dt);
  if (d < m.r + 34 && t - m.lastAtk > (m.enraged ? 900 : 1300)) { m.lastAtk = t; applyDamage(tgt, m.dmg, m); }
  if (d < 320 && t >= m.nextSlam) {
    // telegraph longo, no chão sob o ALVO, com aviso — dá tempo de sair de perto
    m.nextSlam = t + (m.enraged ? 5000 : 8000);
    m.cast = { type: 'slam', x: tgt.x, y: tgt.y, r: 160, until: t + 1300, start: t };
    addFx(tgt.x, tgt.y - 30, 'PANCADA! saia do círculo', '#ff6a5e', true, 'cast');
  } else if (d >= 320 && t >= m.nextBolt) {
    m.nextBolt = t + (m.enraged ? 2200 : 3400);
    projectiles.push({
      x: m.x, y: m.y, vx: Math.cos(a) * 400, vy: Math.sin(a) * 400,
      dmg: m.dmg, ownerId: m.id, traveled: 0, max: 1000, boss: true
    });
    addFx(m.x, m.y - 50, '🔥', '#ff9a5e', false, 'cast');
  }
}

/* ---------------- rodada ---------------- */
function updateRound(t) {
  if (round.phase === 'playing') {
    if (t >= round.endsAt) {
      // fim da rodada: vencedor = mais abates (desempate: maior nível)
      let win = null;
      for (const p of players.values()) {
        if (!win || p.kills > win.kills || (p.kills === win.kills && p.level > win.level)) win = p;
      }
      round.winner = win ? { name: win.name, kills: win.kills, cls: win.cls } : null;
      round.phase = 'intermission';
      round.endsAt = t + INTERMISSION_MS;
      const msg = round.winner
        ? `🏆 Fim da rodada! Vencedor: ${round.winner.name} com ${round.winner.kills} abates!`
        : '🏁 Fim da rodada!';
      io.emit('log', msg);
      io.emit('roundover', round.winner);
    }
  } else { // intermission
    if (t >= round.endsAt) {
      // reset geral: zera placar e progresso, nova rodada
      for (const p of players.values()) {
        p.kills = 0; p.deaths = 0; p.xp = 0; p.level = 1;
        p.hpMax = hpMaxFor(p.cls, 1); p.hp = p.hpMax;
        p.lastSpecial = -1e9; p.stunUntil = 0; p.kbX = 0; p.kbY = 0;
        const s = freeSpot(); p.x = s.x; p.y = s.y; p.alive = true; p.invulnUntil = t + 2500;
      }
      monsters.clear(); ensureMonsters();
      round.phase = 'playing'; round.endsAt = t + ROUND_MS; round.winner = null;
      io.emit('log', '⚔ Nova rodada! 10 minutos. Mais abates vence!');
    }
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
    // knockback decai mesmo durante o atordoamento
    if (p.kbX || p.kbY) {
      moveEntity(p, p.kbX, p.kbY);
      p.kbX *= 0.8; p.kbY *= 0.8;
      if (Math.abs(p.kbX) < 0.5) p.kbX = 0;
      if (Math.abs(p.kbY) < 0.5) p.kbY = 0;
    }
    if (t < p.stunUntil) continue;            // atordoado: não move nem ataca
    if (p.dirX || p.dirY) moveEntity(p, p.dirX * speedAt(p) * dt, p.dirY * speedAt(p) * dt);
    if (p.holding) attack(p, p.aimX, p.aimY);   // auto-attack: cadência limitada dentro de attack()
  }

  for (const m of monsters.values()) monsterTick(m, dt, t);

  // monta a grade depois de todo mundo se mover, para ataques/projéteis usarem posições atuais
  rebuildEntityGrid();

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.x += pr.vx * dt; pr.y += pr.vy * dt;
    pr.traveled += Math.hypot(pr.vx * dt, pr.vy * dt);
    let hit = pr.traveled > pr.max || pr.x < 0 || pr.x > W || pr.y < 0 || pr.y > H;
    if (!hit) forEachNear(decorGrid, pr.x, pr.y, d => { if (!hit && Math.hypot(pr.x - d.x, pr.y - d.y) < d.r) hit = true; });
    if (!hit) {
      const owner = players.get(pr.ownerId) || monsters.get(pr.ownerId);
      const rad = pr.boss ? 22 : 18;
      forEachNear(entityGrid, pr.x, pr.y, o => {
        if (hit || o.id === pr.ownerId || o.alive === false) return;
        if (pr.boss && o.cls === undefined) return;      // bola de fogo do boss só atinge jogadores
        if (Math.hypot(o.x - pr.x, o.y - pr.y) < rad) { applyDamage(o, pr.dmg, owner); hit = true; }
      });
    }
    if (hit) projectiles.splice(i, 1);
  }

  if (tickCount % 150 === 0) ensureMonsters();
  updateRound(t);

  if (++tickCount % BROADCAST_EVERY === 0) {
    io.emit('state', {
      t,
      online: players.size,
      round: { phase: round.phase, endsAt: round.endsAt, winner: round.winner },
      players: [...players.values()].map(p => ({
        id: p.id, name: p.name, cls: p.cls, x: Math.round(p.x), y: Math.round(p.y),
        hp: Math.ceil(p.hp), hpMax: p.hpMax, level: p.level, xp: Math.round(p.xp),
        xpCur: XP_LVL(p.level), xpNext: XP_LVL(p.level + 1), dmg: Math.round(dmgAt(CLASSES[p.cls].dmg, p.level)),
        kills: p.kills, deaths: p.deaths, alive: p.alive,
        inv: t < p.invulnUntil, stun: t < p.stunUntil, ang: +p.ang.toFixed(2), swing: p.swing,
        nova: (p.novaFx && t - p.novaFx < 400) ? p.novaFx : 0,
        spCd: Math.max(0, p.lastSpecial + specialCdFor(p) - t), spMax: specialCdFor(p)
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
    socket.emit('init', { id: me.id, world: { W, H, decor }, cfg: { growth: BALANCE.growth } });
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
  socket.on('attack', d => {
    if (!me || !d) return;
    me.aimX = +d.x; me.aimY = +d.y;
    if (d.hold) me.holding = true;
    attack(me, +d.x, +d.y);
  });
  socket.on('aim', d => { if (me && d) { me.aimX = +d.x; me.aimY = +d.y; } });
  socket.on('release', () => { if (me) me.holding = false; });
  socket.on('special', d => { if (me) useSpecial(me, d ? +d.x : me.aimX, d ? +d.y : me.aimY); });
  socket.on('disconnect', () => {
    if (!me) return;
    io.emit('log', `✕ ${me.name} deixou a arena`);
    players.delete(me.id);
  });
});

/* ---------------- painel admin escondido ---------------- */
const EDITABLE = ['dmg', 'regen', 'speed', 'range', 'atkMs', 'projSpeed'];
const EDITABLE_BAL = ['hpPerLvl', 'dmgPerLvl', 'xpGrowth', 'specialCd', 'specialCdPerLvl', 'deathPenalty', 'minBounty'];

app.get(ADMIN_PATH + '/config', (req, res) => {
  res.json({ classes: CLASSES, balance: BALANCE, online: players.size,
    arena: { median: avgPlayerLevel(), max: arenaMaxLevel(), monsters: monsters.size },
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
    let v = +b.balance[k];
    if (!Number.isFinite(v) || v < 0) continue;
    if (k === 'xpGrowth') v = Math.max(1.01, v); // precisa ser > 1
    BALANCE[k] = v;
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
const LBL = {dmg:'Dano base',regen:'Regen (fração/3s)',speed:'Velocidade',range:'Alcance (px)',
atkMs:'Cooldown ataque (ms)',projSpeed:'Vel. projétil',
hpPerLvl:'HP extra por nível',dmgPerLvl:'Dano extra por nível',xpGrowth:'Custo XP por nível',
specialCd:'Cooldown especial (ms)',specialCdPerLvl:'Reduz especial/nível (ms)',
deathPenalty:'Abates perdidos ao morrer',minBounty:'XP mínimo por kill'};
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
