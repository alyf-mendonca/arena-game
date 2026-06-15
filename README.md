# Arena de Aço & Magia — v2 (online)

Multiplayer 2D de fantasia: Knights e Wizards numa arena todos-contra-todos.
O **last hit** rouba todo o XP da vítima, o dano dobra a cada nível e o Chefe 👑
caça o jogador mais forte do servidor.

## Estrutura

```
arena-online/
├── server.js          → servidor autoritativo (Node + Socket.io, 30 ticks/s)
├── public/index.html  → cliente (desenha, envia comandos, toca sons)
├── package.json
└── README.md
```

## Rodar localmente

```bash
npm install
npm start
```

Jogo: `http://localhost:3000` (abra 2 abas para testar o multiplayer).
**Painel admin**: `http://localhost:3000/123921839128398213912389213`

## Painel dos Deuses (admin escondido)

Acessível só por quem conhece a URL. Permite ajustar **ao vivo**, sem reiniciar:

- Por classe: HP base, dano base, regeneração, velocidade, alcance,
  cooldown de ataque, multiplicador de HP por nível, velocidade de projétil
- Global: início/intensidade/teto do nerf de velocidade, dano extra do líder,
  XP mínimo por kill
- Mostra jogadores online, nível mediano/máximo da arena e nº de monstros

⚠️ A segurança é só a URL secreta. Para trocar o caminho sem mexer no código:
`ADMIN_PATH=/meu-segredo-novo npm start`. Não compartilhe a URL e, se vazar,
troque o ADMIN_PATH e reinicie.

## Colocar online

Qualquer host Node com WebSockets:

- **Render.com (grátis)**: suba para o GitHub → New Web Service → build
  `npm install`, start `npm start`. Defina a variável `ADMIN_PATH` em
  Environment para ter sua própria URL secreta. No plano grátis o servidor
  dorme após ~15 min vazio.
- **Railway.app**: Deploy from GitHub repo → Generate Domain.
- **VPS (~US$5/mês)**: `npm install -g pm2 && pm2 start server.js` para ficar
  sempre no ar (instruções completas na v1 valem igual).

## Regras (v2)

| Regra | Valor |
|---|---|
| Knight | 300 HP **×1.35 por nível**, dano 8, alcance 56px, regen 1%/3s, vel. 185, **Investida (Espaço, 2,5s cd)** |
| Wizard | 100 HP, dano 2, projétil 640px a 560px/s, regen 2%/3s, **vel. 205 (mais ágil)** |
| Cadência | Knight 1 golpe/300ms · Wizard 1 disparo/480ms (clique importa até o teto) |
| Dano e HP | crescem **+22% por nível** (`growth`, ajustável no admin) — não dobram mais |
| XP por nível | custo cresce ~55% por nível (`xpGrowth`) |
| Golpes p/ matar | ~constante entre níveis próximos (conserta o "monstro intocável") |
| Last hit | rouba TODO o XP da vítima (mínimo 5, nível 1 incluso) |
| Regra dos 3 níveis | só bloqueia farmar quem está **4+ níveis abaixo**; matar acima sempre vale |
| Anti-snowball | nv6+: velocidade −3%/nível (máx −15%) · 2+ níveis acima da mediana: dano recebido +10%/nível (máx +40%) |
| Abates | zeram ao morrer — ranking vale só na vida atual |
| Monstros | 2× o nº de jogadores online (mín. 8); dano e XP = metade de um jogador do nível |
| Tiers | Normal ~10 golpes · Elite ◆ ~26 · Chefe 👑 ~60 (máx. 1) |
| Chefe | nível = maior jogador +2, persegue o maior nível no mapa todo; Pancada em área (telegraph 0,9s, 1.6× dano), Bola de Fogo à distância, Fúria <30% HP (+45% vel., cooldowns menores) |
| Morte | respawn 3s, nível 1, 2,5s de escudo |
| Mapa | 3600×3600 |
| Sem bots | arena 100% de jogadores reais + monstros |

Sons sintetizados no navegador (sem arquivos) — tecla **M** silencia.
