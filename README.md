# Arena de Aço & Magia — v4 (rodadas + habilidade)

Multiplayer 2D de fantasia. Knights e Wizards numa arena todos-contra-todos,
agora em **rodadas de 10 minutos** onde vence quem tiver **mais abates de PVP**.
O foco saiu do grind e foi para **habilidade**: ~5 acertos matam entre quaisquer
níveis, e cada classe tem um **especial no botão direito** (cooldown 10s).

## Rodar

```bash
npm install
npm start
```

Jogo: `http://localhost:3000` (abra 2 abas para testar).
Painel admin: `http://localhost:3000/123921839128398213912389213`
(troque com a variável de ambiente `ADMIN_PATH`).

## Controles

- **WASD** — mover
- **Segurar clique esquerdo** — atacar sem parar (auto-attack na cadência da classe)
- **Clique direito** (ou **Espaço**) — usar o especial
- O especial tem cooldown de ~10s, que diminui conforme você sobe de nível

## Especiais

- **Knight — Investida Brutal**: avança forte na direção da mira; o primeiro
  alvo atingido é atordoado, empurrado e leva dano pesado. É o "engage".
- **Wizard — Nova Arcana**: explosão em área ao redor do mago que empurra e
  fere todos por perto. É o "disengage" — pune quem colou.

## Filosofia de balanceamento (v4)

| Regra | Valor |
|---|---|
| Letalidade | ~5 acertos matam, entre QUAISQUER níveis |
| Dano por nível | +1,5% (quase nada — habilidade manda) |
| HP por nível | +5% (vantagem leve de durabilidade) |
| Velocidade | fixa (agilidade é skill, não level) |
| Especial | cooldown 10s, −0,4s por nível (mínimo 5s) |
| Vencedor da rodada | mais abates de PVP (desempate: maior nível) |
| Rodada | 10 min + 15s de intervalo, depois reset geral |
| Morte | −1 abate no placar, respawn em 2,5s, mantém nível |
| Monstros (PVM) | dão XP, NÃO contam no placar; 2× o nº de jogadores |
| Tiers de monstro | Normal ~4 golpes · Elite ◆ ~9 · Chefe 👑 ~22 |
| Chefe | nível = maior jogador +2, caça o maior nível; Pancada, Bola de Fogo, Fúria |
| Mapa | 3600×3600 |

Sem som, sem bots — só jogadores reais + monstros. Servidor autoritativo
(o cliente só desenha e envia intenções), grade espacial para performance,
e guardas anti-NaN para o mapa nunca "sumir".

## Painel dos Deuses (admin)

Ajusta ao vivo, sem reiniciar: dano, regen, velocidade, alcance, cadência e
projétil de cada classe; e os globais (HP/nível, dano/nível, custo de XP,
cooldown do especial, punição por morte). A única proteção é a URL secreta —
defina `ADMIN_PATH` no deploy e não compartilhe.
