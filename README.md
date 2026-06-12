# Arena de Aço & Magia — versão online

Jogo multiplayer 2D de fantasia: Knights e Wizards numa arena todos-contra-todos.
O **last hit** rouba todo o XP da vítima (até ±3 níveis de diferença), o dano dobra
a cada nível, e monstros escalam com o nível da arena — elites e chefes exigem
grupo, mas só um leva o prêmio.

## Estrutura

```
arena-online/
├── server.js          → servidor autoritativo (Node + Socket.io, 30 ticks/s)
├── public/index.html  → cliente (só desenha e envia comandos)
├── package.json
└── README.md
```

O servidor é **autoritativo**: calcula movimento, dano, XP e respawn.
O cliente envia apenas intenções (direção de movimento, clique de ataque) —
quem mexer no console do navegador não consegue alterar vida, dano ou posição.

---

## 1. Rodar no seu computador (teste local)

Pré-requisito: [Node.js 18+](https://nodejs.org).

```bash
cd arena-online
npm install
npm start
```

Abra `http://localhost:3000`. Para testar o multiplayer sozinho, abra duas
abas do navegador — cada uma é um jogador diferente.

Para jogar com amigos na **mesma rede Wi-Fi**: descubra seu IP local
(`ipconfig` no Windows, `ifconfig`/`ip a` no Linux/Mac) e eles acessam
`http://SEU_IP:3000`.

Variável opcional: `BOTS=0 npm start` remove os bots (padrão: 4).

---

## 2. Colocar online de verdade (grátis)

Qualquer host com Node.js + WebSockets funciona. Os mais fáceis:

### Opção A — Render.com (recomendado para começar)

1. Crie uma conta em https://render.com
2. Suba esta pasta para um repositório no GitHub
3. No Render: **New → Web Service → conecte o repositório**
4. Configure:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Plano: **Free**
5. Pronto — o Render te dá uma URL tipo `https://sua-arena.onrender.com`.
   Mande para os amigos e joguem.

⚠️ No plano grátis o servidor "dorme" após ~15 min sem ninguém, e demora
~30s para acordar no primeiro acesso. Para um servidor sempre ligado,
o plano pago mais barato resolve.

### Opção B — Railway.app

1. Conta em https://railway.app → **New Project → Deploy from GitHub repo**
2. Ele detecta Node automaticamente; nada para configurar.
3. Em **Settings → Networking → Generate Domain** para ter a URL pública.

### Opção C — VPS (mais controle, ~US$4-5/mês)

Hetzner, DigitalOcean, Contabo etc. Num Ubuntu novo:

```bash
sudo apt update && sudo apt install -y nodejs npm
git clone SEU_REPOSITORIO && cd arena-online
npm install
sudo npm install -g pm2
pm2 start server.js --name arena
pm2 save && pm2 startup     # religa sozinho se o servidor reiniciar
```

O jogo fica em `http://IP_DO_VPS:3000`. Para usar um domínio próprio com
HTTPS, coloque um proxy reverso (Caddy é o mais simples: 3 linhas de config
e o certificado é automático).

---

## 3. O que dá para evoluir depois

- **Ranking persistente**: hoje o ranking vive na memória (zera se o servidor
  reiniciar). Próximo passo: salvar recordes em SQLite ou Redis.
- **Salas**: uma arena única aguenta ~20-30 jogadores confortavelmente;
  acima disso, criar múltiplas salas/instâncias.
- **Penalidade de desconexão**: hoje o corpo some na hora ao fechar a aba —
  dá para deixar o boneco vulnerável por alguns segundos para punir fuga.
- **Mobile**: adicionar joystick virtual de toque.
- **Reconexão**: guardar o progresso por alguns segundos se a conexão cair.

## Regras do jogo (resumo)

| Regra | Valor |
|---|---|
| Knight | 300 HP, dano 8, alcance 56px, regen 1%/3s, vel. 185 |
| Wizard | 100 HP, dano 2, projétil 640px, regen 2%/3s, vel. 165 |
| Ataque | velocidade do clique (mínimo 150ms, validado no servidor) |
| Dano por nível | dobra: 8 → 16 → 32 → 64... |
| XP por nível | dobra: 10 → 20 → 40... (acumulado: 10, 30, 70, 150) |
| Last hit | rouba TODO o XP da vítima se a diferença for ≤ 3 níveis |
| Monstros | nível segue a mediana da arena; dano e XP = metade de um jogador |
| Tiers | Normal ~10 golpes · Elite ◆ ~26 · Chefe 👑 ~60 (máx. 1 vivo) |
| Morte | respawn em 3s, nível 1, 2,5s de escudo |
