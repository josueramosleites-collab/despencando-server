const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());

// =====================
// CONSTANTES
// =====================
const RECONNECT_TIMEOUT_DUEL     = 30000;  // 30s
const RECONNECT_TIMEOUT_CAMPAIGN = 120000; // 2min
const DUEL_LIVES = 3;

function getCampaignLives(phase) {
  return phase >= 8 ? 10 : 7;
}

// =====================
// ESTADO
// =====================
let queue = { duel: [], campaign: [] };
const rooms = {};
const socketRoom = {};

function makeRoomId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function makePlayer(p, phase) {
  return {
    socketId: p.socketId,
    nickname: p.nickname,
    character: p.character,
    x: 210, dist: 0,
    alive: true, ready: false, connected: true,
    duelLives: DUEL_LIVES,
    roundsWon: 0,
    campaignLives: getCampaignLives(phase)
  };
}

function createRoom(p1, p2, mode) {
  const roomId = makeRoomId();
  const phase = 1;
  rooms[roomId] = {
    id: roomId, mode,
    players: {
      [p1.socketId]: makePlayer(p1, phase),
      [p2.socketId]: makePlayer(p2, phase)
    },
    status: 'waiting',
    currentRound: 1,
    currentPhase: phase,
    reconnectTimers: {},
    pausedBy: null,
    rematch: {}
  };
  socketRoom[p1.socketId] = roomId;
  socketRoom[p2.socketId] = roomId;
  return rooms[roomId];
}

function getPlayers(room) { return Object.values(room.players); }
function getOpponent(room, sid) { return getPlayers(room).find(p => p.socketId !== sid); }

function buildList(room, forSid) {
  return getPlayers(room).map(p => ({
    socketId: p.socketId, nickname: p.nickname, character: p.character,
    isMe: p.socketId === forSid,
    duelLives: p.duelLives, roundsWon: p.roundsWon, campaignLives: p.campaignLives
  }));
}

// =====================
// MATCHMAKING
// =====================
function tryMatch(mode, newP) {
  const q = queue[mode];
  const existing = q.findIndex(p => p.socketId !== newP.socketId);
  if (existing >= 0) {
    const opp = q.splice(existing, 1)[0];
    if (opp.character === newP.character) newP.character = newP.character === 0 ? 1 : 0;
    const room = createRoom(opp, newP, mode);
    [opp.socketId, newP.socketId].forEach(sid => {
      io.to(sid).emit('match_found', { roomId: room.id, mode, players: buildList(room, sid) });
    });
    console.log(`[SALA ${mode.toUpperCase()}] ${room.id}: ${opp.nickname} vs ${newP.nickname}`);
  } else {
    q.push(newP);
    io.to(newP.socketId).emit('waiting_match', { mode });
  }
}

// =====================
// CONTAGEM REGRESSIVA
// =====================
function startCountdown(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.status = 'countdown';
  let count = 3;
  io.to(roomId).emit('countdown', { count });
  const iv = setInterval(() => {
    if (!rooms[roomId]) { clearInterval(iv); return; }
    count--;
    if (count > 0) {
      io.to(roomId).emit('countdown', { count });
    } else {
      clearInterval(iv);
      room.status = 'playing';
      room.startTime = Date.now();
      getPlayers(room).forEach(p => { p.alive = true; p.dist = 0; p.x = 210; });
      io.to(roomId).emit('game_start', {
        mode: room.mode, round: room.currentRound,
        phase: room.currentPhase, players: buildList(room, null)
      });
    }
  }, 1000);
}

// =====================
// DUELO — FIM DE ROUND
// =====================
function checkDuelRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.mode !== 'duel' || room.status !== 'playing') return;
  const players = getPlayers(room);

  // Round termina quando todos ficam sem vidas OU um sobreviveu
  const allOut = players.every(p => !p.alive || p.duelLives <= 0);
  if (!allOut) return;

  const alive = players.filter(p => p.alive);
  const winnerId = alive.length === 1 ? alive[0].socketId : null;

  room.status = 'round_over';
  if (winnerId) room.players[winnerId].roundsWon++;

  io.to(roomId).emit('round_over', {
    round: room.currentRound, winnerId,
    scores: players.map(p => ({
      socketId: p.socketId, nickname: p.nickname,
      roundsWon: p.roundsWon, duelLives: p.duelLives, dist: p.dist
    }))
  });

  // Melhor de 3 — quem chegou a 2 ganhou
  const champion = players.find(p => p.roundsWon >= 2);
  if (champion) { setTimeout(() => endMatch(roomId, champion.socketId), 3500); return; }

  if (room.currentRound >= 3) {
    const sorted = [...players].sort((a, b) => b.roundsWon - a.roundsWon);
    const win = sorted[0].roundsWon > sorted[1].roundsWon ? sorted[0].socketId : null;
    setTimeout(() => endMatch(roomId, win), 3500);
    return;
  }

  // Próximo round
  room.currentRound++;
  players.forEach(p => { p.duelLives = DUEL_LIVES; p.alive = true; p.ready = false; p.dist = 0; });
  setTimeout(() => {
    if (!rooms[roomId]) return;
    room.status = 'waiting';
    io.to(roomId).emit('next_round', { round: room.currentRound, players: buildList(room, null) });
    startCountdown(roomId);
  }, 4000);
}

// =====================
// CAMPANHA — CHECAR FASE
// =====================
function checkCampaignPhase(roomId) {
  const room = rooms[roomId];
  if (!room || room.mode !== 'campaign') return;
  const players = getPlayers(room);
  if (players.some(p => p.alive)) return; // ainda tem alguém vivo

  const canContinue = players.some(p => p.campaignLives > 0);
  if (!canContinue) { endMatch(roomId, null); return; }

  getPlayers(room).forEach(p => { p.alive = true; p.ready = false; p.dist = 0; });
  room.status = 'waiting';
  io.to(roomId).emit('phase_failed', { phase: room.currentPhase, players: buildList(room, null) });
}

function advanceCampaign(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.currentPhase >= 10) { endMatch(roomId, 'all'); return; }
  room.currentPhase++;
  getPlayers(room).forEach(p => {
    p.alive = true; p.dist = 0; p.ready = false;
    p.campaignLives = getCampaignLives(room.currentPhase);
  });
  room.status = 'waiting';
  io.to(roomId).emit('phase_complete', { phase: room.currentPhase, players: buildList(room, null) });
}

// =====================
// FIM DE PARTIDA
// =====================
function endMatch(roomId, winnerId) {
  const room = rooms[roomId];
  if (!room) return;
  room.status = 'finished';
  io.to(roomId).emit('match_over', {
    mode: room.mode, winnerId,
    isAllWin: winnerId === 'all',
    scores: getPlayers(room).map(p => ({
      socketId: p.socketId, nickname: p.nickname, character: p.character,
      roundsWon: p.roundsWon, dist: p.dist, campaignLives: p.campaignLives
    }))
  });
  setTimeout(() => { delete rooms[roomId]; }, 5 * 60 * 1000);
}

// =====================
// SOCKET EVENTS
// =====================
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('find_match', ({ nickname, character, mode }) => {
    if (!['duel','campaign'].includes(mode)) return;
    ['duel','campaign'].forEach(m => { queue[m] = queue[m].filter(p => p.socketId !== socket.id); });
    tryMatch(mode, { socketId: socket.id, nickname, character });
  });

  socket.on('create_invite', ({ nickname, character, mode }) => {
    const roomId = makeRoomId();
    rooms[roomId] = {
      id: roomId, mode, host: socket.id,
      players: { [socket.id]: makePlayer({ socketId: socket.id, nickname, character }, 1) },
      status: 'invite_waiting', currentRound: 1, currentPhase: 1,
      reconnectTimers: {}, pausedBy: null, rematch: {}
    };
    socketRoom[socket.id] = roomId;
    socket.emit('invite_created', { roomId, mode });
  });

  socket.on('join_invite', ({ roomId, nickname, character }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'invite_waiting') {
      socket.emit('join_error', { message: 'Sala não encontrada ou já iniciada.' }); return;
    }
    const hostChar = room.players[room.host].character;
    if (hostChar === character) character = character === 0 ? 1 : 0;
    room.players[socket.id] = makePlayer({ socketId: socket.id, nickname, character }, room.currentPhase);
    room.status = 'waiting';
    socketRoom[socket.id] = roomId;
    [socket.id, room.host].forEach(sid => {
      io.to(sid).emit('match_found', { roomId, mode: room.mode, players: buildList(room, sid) });
    });
  });

  socket.on('player_ready', () => {
    const roomId = socketRoom[socket.id];
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (!room.players[socket.id] || room.status !== 'waiting') return;
    room.players[socket.id].ready = true;
    socket.to(roomId).emit('opponent_ready', { socketId: socket.id });
    if (getPlayers(room).every(p => p.ready)) startCountdown(roomId);
  });

  socket.on('position_update', ({ x, dist }) => {
    const roomId = socketRoom[socket.id];
    if (!roomId || !rooms[roomId] || rooms[roomId].status !== 'playing') return;
    rooms[roomId].players[socket.id].x = x;
    rooms[roomId].players[socket.id].dist = dist;
    socket.to(roomId).emit('opponent_position', { x, dist, socketId: socket.id });
  });

  socket.on('player_died', ({ dist }) => {
    const roomId = socketRoom[socket.id];
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (!room.players[socket.id] || room.status !== 'playing') return;
    const player = room.players[socket.id];
    player.alive = false;
    player.dist = dist;
    if (room.mode === 'duel') {
      player.duelLives = Math.max(0, player.duelLives - 1);
      socket.to(roomId).emit('opponent_died', {
        socketId: socket.id, nickname: player.nickname,
        dist, duelLives: player.duelLives
      });
      checkDuelRound(roomId);
    } else {
      player.campaignLives = Math.max(0, player.campaignLives - 1);
      socket.to(roomId).emit('opponent_died', {
        socketId: socket.id, nickname: player.nickname,
        dist, campaignLives: player.campaignLives
      });
      checkCampaignPhase(roomId);
    }
  });

  socket.on('phase_clear', ({ dist }) => {
    const roomId = socketRoom[socket.id];
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.mode !== 'campaign') return;
    room.players[socket.id].dist = dist;
    socket.to(roomId).emit('opponent_cleared_phase', {
      socketId: socket.id, nickname: room.players[socket.id].nickname, dist
    });
    const players = getPlayers(room);
    if (players.every(p => !p.alive || p.socketId === socket.id)) advanceCampaign(roomId);
  });

  socket.on('rematch_request', () => {
    const roomId = socketRoom[socket.id];
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    room.rematch[socket.id] = true;
    socket.to(roomId).emit('opponent_rematch');
    if (getPlayers(room).every(p => room.rematch[p.socketId])) {
      getPlayers(room).forEach(p => {
        p.alive = true; p.dist = 0; p.ready = false;
        p.duelLives = DUEL_LIVES; p.roundsWon = 0;
        p.campaignLives = getCampaignLives(1);
      });
      room.status = 'waiting'; room.currentRound = 1; room.currentPhase = 1; room.rematch = {};
      io.to(roomId).emit('rematch_start', { players: buildList(room, null) });
    }
  });

  socket.on('cancel_search', () => {
    ['duel','campaign'].forEach(m => { queue[m] = queue[m].filter(p => p.socketId !== socket.id); });
    socket.emit('search_cancelled');
  });

  socket.on('reconnect_room', ({ roomId, nickname }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('reconnect_failed'); return; }
    const player = getPlayers(room).find(p => p.nickname === nickname);
    if (!player) { socket.emit('reconnect_failed'); return; }
    if (room.reconnectTimers[player.socketId]) {
      clearTimeout(room.reconnectTimers[player.socketId]);
      delete room.reconnectTimers[player.socketId];
    }
    const oldSid = player.socketId;
    delete socketRoom[oldSid];
    room.players[socket.id] = player;
    delete room.players[oldSid];
    player.socketId = socket.id;
    player.connected = true;
    socketRoom[socket.id] = roomId;
    socket.join(roomId);
    socket.emit('reconnect_success', { roomId, mode: room.mode, status: room.status, players: buildList(room, socket.id) });
    const opp = getOpponent(room, socket.id);
    if (opp) io.to(opp.socketId).emit('opponent_reconnected', { nickname });
    if (room.mode === 'campaign' && room.status === 'paused' && room.pausedBy === oldSid) {
      room.status = 'playing'; room.pausedBy = null;
      io.to(roomId).emit('game_resumed');
    }
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    ['duel','campaign'].forEach(m => { queue[m] = queue[m].filter(p => p.socketId !== socket.id); });
    const roomId = socketRoom[socket.id];
    if (!roomId || !rooms[roomId]) { delete socketRoom[socket.id]; return; }
    const room = rooms[roomId];
    const player = room.players[socket.id];
    if (!player) { delete socketRoom[socket.id]; return; }
    player.connected = false;
    if (['finished','invite_waiting'].includes(room.status)) {
      delete rooms[roomId]; delete socketRoom[socket.id]; return;
    }
    const timeout = room.mode === 'duel' ? RECONNECT_TIMEOUT_DUEL : RECONNECT_TIMEOUT_CAMPAIGN;
    socket.to(roomId).emit('opponent_disconnected', { nickname: player.nickname, mode: room.mode, timeout: timeout/1000 });
    if (room.mode === 'campaign' && room.status === 'playing') {
      room.status = 'paused'; room.pausedBy = socket.id;
      player.campaignLives = Math.max(0, player.campaignLives - 1);
      socket.to(roomId).emit('game_paused', { by: player.nickname, campaignLives: player.campaignLives });
    }
    room.reconnectTimers[socket.id] = setTimeout(() => {
      if (!rooms[roomId]) return;
      const opp = getOpponent(room, socket.id);
      if (room.mode === 'duel') {
        endMatch(roomId, opp?.socketId || null);
      } else {
        delete room.players[socket.id];
        room.status = 'playing';
        if (opp) io.to(opp.socketId).emit('opponent_left');
      }
    }, timeout);
    delete socketRoom[socket.id];
  });
});

app.get('/', (req, res) => res.json({
  status: 'ok',
  rooms: Object.keys(rooms).length,
  queue_duel: queue.duel.length,
  queue_campaign: queue.campaign.length
}));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Despencando Server — porta ${PORT}`));
