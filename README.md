# Despencando — Servidor Multiplayer

## Modos
- **Duelo:** Melhor de 3 rounds. Cada jogador tem 3 vidas por round. Ganha quem vencer 2 rounds.
- **Campanha:** Co-op, vidas separadas (7 nas fases 3-7, 10 nas fases 8-10). Passa de fase se 1 sobreviver.

## Deploy no Railway

1. Crie conta em https://railway.app
2. Novo projeto → Deploy from GitHub
3. Suba estes arquivos num repositório GitHub
4. Railway sobe automaticamente
5. Settings → Networking → ative Public Networking
6. Copie a URL e cole no jogo como `SERVER_URL`

## Rodar local
```bash
npm install
npm run dev
# http://localhost:3000
```

## Eventos — Cliente → Servidor
| Evento | Payload |
|--------|---------|
| `find_match` | `{ nickname, character, mode }` |
| `create_invite` | `{ nickname, character, mode }` |
| `join_invite` | `{ roomId, nickname, character }` |
| `player_ready` | — |
| `position_update` | `{ x, dist }` |
| `player_died` | `{ dist }` |
| `phase_clear` | `{ dist }` (campanha) |
| `rematch_request` | — |
| `reconnect_room` | `{ roomId, nickname }` |
| `cancel_search` | — |

## Eventos — Servidor → Cliente
| Evento | Payload |
|--------|---------|
| `waiting_match` | `{ mode }` |
| `match_found` | `{ roomId, mode, players }` |
| `invite_created` | `{ roomId, mode }` |
| `countdown` | `{ count }` |
| `game_start` | `{ mode, round, phase, players }` |
| `opponent_position` | `{ x, dist, socketId }` |
| `opponent_died` | `{ socketId, nickname, dist, duelLives/campaignLives }` |
| `round_over` | `{ round, winnerId, scores }` (duelo) |
| `next_round` | `{ round, players }` (duelo) |
| `phase_complete` | `{ phase, players }` (campanha) |
| `phase_failed` | `{ phase, players }` (campanha) |
| `match_over` | `{ mode, winnerId, scores }` |
| `opponent_disconnected` | `{ nickname, mode, timeout }` |
| `game_paused` | `{ by, campaignLives }` (campanha) |
| `game_resumed` | — |
| `opponent_rematch` | — |
| `rematch_start` | `{ players }` |
| `reconnect_success` | `{ roomId, mode, status, players }` |
