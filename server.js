const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const BOARD_LAYOUT = [
  'FREE', '2♠', '3♠', '4♠', '5♠', '6♠', '7♠', '8♠', '9♠', 'FREE',
  '6♣', '5♣', '4♣', '3♣', '2♣', 'A♥', 'K♥', 'Q♥', '10♥', '10♠',
  '7♣', 'A♠', '2♦', '3♦', '4♦', '5♦', '6♦', '7♦', '9♥', 'Q♠',
  '8♣', 'K♠', '6♣', '5♣', '4♣', '3♣', '2♣', '8♦', '8♥', 'K♠',
  '9♣', 'Q♠', '7♣', '6♥', '5♥', '4♥', 'A♥', '9♦', '7♥', 'A♠',
  '10♣', '10♠', '8♣', '7♥', '2♥', '3♥', 'K♥', '10♦', '6♥', '2♦',
  'Q♣', '9♠', '9♣', '8♥', '9♥', '10♥', 'Q♥', 'Q♦', '5♥', '3♦',
  'K♣', '8♠', '10♣', 'Q♣', 'K♣', 'A♣', 'A♦', 'K♦', '4♥', '4♦',
  'A♣', '7♠', '6♠', '5♠', '4♠', '3♠', '2♠', '2♥', '3♥', '5♦',
  'FREE', 'A♦', 'K♦', 'Q♦', '10♦', '9♦', '8♦', '7♦', '6♦', 'FREE'
];

function generateShuffledDeck() {
  let deck = [];
  for (let i = 0; i < 2; i++) {
    for (let suit of SUITS) {
      for (let value of VALUES) deck.push(`${value}${suit}`);
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function checkWin(board, team) {
  const getCell = (r, c) => {
    if (r < 0 || r > 9 || c < 0 || c > 9) return null;
    const idx = r * 10 + c;
    if (idx === 0 || idx === 9 || idx === 90 || idx === 99) return team;
    return board[idx];
  };

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const directions = [[0, 1], [1, 0], [1, 1], [-1, 1]];
      for (let [dr, dc] of directions) {
        let count = 0; let line = [];
        for (let i = 0; i < 5; i++) {
          if (getCell(r + dr * i, c + dc * i) === team) { count++; line.push((r + dr * i) * 10 + (c + dc * i)); } 
          else break;
        }
        if (count === 5) return line;
      }
    }
  }
  return null;
}

const games = {};
const NEXT_TURN = { 'red': 'blue', 'blue': 'green', 'green': 'red' };

function getNextTeam(currentTeam, teamRosters) {
  let next = NEXT_TURN[currentTeam];
  if (teamRosters[next].length === 0) next = NEXT_TURN[next];
  if (teamRosters[next].length === 0) next = NEXT_TURN[next];
  return next;
}

function logAction(roomId, message) {
  const game = games[roomId];
  if (!game) return;
  game.logs.unshift(message);
  if (game.logs.length > 20) game.logs.pop(); 
}

function advanceTurn(roomId) {
  const game = games[roomId];
  game.teamTurnIndex[game.turn] = (game.teamTurnIndex[game.turn] + 1) % game.teamRosters[game.turn].length;
  game.turn = getNextTeam(game.turn, game.teamRosters);
  game.turnDeadline = Date.now() + 60000; 
  triggerBotTurn(roomId);
}

function broadcastGameState(roomId) {
  const game = games[roomId];
  if (!game) return;
  const activeId = game.teamRosters[game.turn]?.[game.teamTurnIndex[game.turn]] || null;
  const activeName = activeId ? game.playerNames[activeId] : 'Waiting...';

  io.to(roomId).emit('game_state', { 
    board: game.board, turn: game.turn, activePlayerId: activeId, activePlayerName: activeName,
    winner: game.winner, winningLine: game.winningLine, logs: game.logs, 
    turnDeadline: game.turnDeadline, isGameStarted: game.isGameStarted,
    hostId: game.host
  });
}

function broadcastRoomInfo(roomId) {
  const game = games[roomId];
  if (!game) return;
  const roster = { red: [], blue: [], green: [], unassigned: [], total: game.players.length };
  for (let pid of game.players) {
    const team = game.teamMap[pid];
    if (team) roster[team].push(game.playerNames[pid]);
    else roster.unassigned.push(game.playerNames[pid]);
  }
  io.to(roomId).emit('room_info', roster);
}

function executeMove(roomId, playerId, index, playedCard, teamColor) {
  const game = games[roomId];
  if (!game || game.winner || !game.isGameStarted) return false;

  const isTwoEyed = playedCard === 'J♦' || playedCard === 'J♣';
  const isOneEyed = playedCard === 'J♠' || playedCard === 'J♥';
  let validMove = false;

  if (isTwoEyed && game.board[index] === null) {
    game.board[index] = teamColor; validMove = true;
  } else if (isOneEyed && game.board[index] !== null && game.board[index] !== teamColor) {
    game.board[index] = null; validMove = true;
  } else if (!isTwoEyed && !isOneEyed && game.board[index] === null) {
    game.board[index] = teamColor; validMove = true;
  }

  if (validMove) {
    const pName = game.playerNames[playerId];
    if (isOneEyed) logAction(roomId, `${pName} removed a chip with ${playedCard}`);
    else logAction(roomId, `${pName} played ${playedCard}`);
      
    const winLine = checkWin(game.board, teamColor);
    if (winLine) {
        game.winner = teamColor;
        game.winningLine = winLine;
        logAction(roomId, `${teamColor.toUpperCase()} TEAM WINS!`);
      } else {
        advanceTurn(roomId);
      }
    
    const hand = game.hands[playerId];
    if (hand && hand.indexOf(playedCard) > -1) {
      hand.splice(hand.indexOf(playedCard), 1); 
      if (game.deck.length > 0) hand.push(game.deck.shift()); 
    }
    return true;
  }
  return false;
}

function triggerBotTurn(roomId) {
  const game = games[roomId];
  if (!game || !game.isGameStarted || game.winner) return;

  const activeId = game.teamRosters[game.turn]?.[game.teamTurnIndex[game.turn]];
  if (!activeId || !activeId.startsWith('bot_')) return;

  setTimeout(() => {
    if (game.teamRosters[game.turn][game.teamTurnIndex[game.turn]] !== activeId) return;

    const hand = game.hands[activeId];
    const teamColor = game.turn;
    let moved = false;

    for (let card of hand) {
      if (card.includes('J')) continue;
      let validIndices = BOARD_LAYOUT.map((val, idx) => val === card ? idx : -1).filter(idx => idx !== -1 && game.board[idx] === null);
      if (validIndices.length > 0) {
        moved = executeMove(roomId, activeId, validIndices[0], card, teamColor);
        if (moved) break;
      }
    }

    if (!moved) {
      const twoEyed = hand.find(c => c === 'J♦' || c === 'J♣');
      if (twoEyed) {
        let emptyIdx = game.board.findIndex((val, idx) => val === null && BOARD_LAYOUT[idx] !== 'FREE');
        if (emptyIdx !== -1) moved = executeMove(roomId, activeId, emptyIdx, twoEyed, teamColor);
      }
    }

    if (!moved) {
      const oneEyed = hand.find(c => c === 'J♠' || c === 'J♥');
      if (oneEyed) {
        let oppIdx = game.board.findIndex((val, idx) => val !== null && val !== teamColor && BOARD_LAYOUT[idx] !== 'FREE');
        if (oppIdx !== -1) moved = executeMove(roomId, activeId, oppIdx, oneEyed, teamColor);
      }
    }

    if (!moved) {
      logAction(roomId, `${game.playerNames[activeId]} had no valid moves and skipped.`);
      advanceTurn(roomId);
    }
    
    io.to(roomId).emit('bot_played');
    broadcastGameState(roomId);
  }, 2000); 
}

io.on('connection', (socket) => {
  socket.on('join_room', (data) => {
    const { roomId, playerName, playerId, avatar } = data;
    socket.join(roomId);
    socket.playerId = playerId;
    socket.roomId = roomId; 

    if (!games[roomId]) {
      games[roomId] = {
        host: playerId, 
        board: Array(100).fill(null), turn: 'red', players: [], teamMap: {}, playerNames: {},
        teamRosters: { red: [], blue: [], green: [] }, teamTurnIndex: { red: 0, blue: 0, green: 0 },
        deck: generateShuffledDeck(), hands: {}, winner: null, winningLine: [], logs: [],
        turnDeadline: null, isGameStarted: false
      };
      logAction(roomId, "Room created.");
    }

    const game = games[roomId];
    if (game.players.includes(playerId)) {
      game.playerNames[playerId] = `${avatar} ${playerName}` || game.playerNames[playerId];
      socket.emit('room_joined', roomId);
      if (game.teamMap[playerId]) {
        socket.emit('assigned_team', game.teamMap[playerId]);
        socket.emit('your_hand', game.hands[playerId]);
      }
      broadcastRoomInfo(roomId); broadcastGameState(roomId);
      return;
    }

    if (game.players.length >= 12) return socket.emit('error_message', 'Room is full.');
    game.players.push(playerId);
    game.playerNames[playerId] = `${avatar} ${playerName}` || 'Guest';
    logAction(roomId, `${game.playerNames[playerId]} connected.`);

    socket.emit('room_joined', roomId);
    broadcastRoomInfo(roomId); broadcastGameState(roomId);
  });

  socket.on('join_team', (data) => {
    const { roomId, teamColor, playerId } = data;
    const game = games[roomId];
    if (!game || game.teamMap[playerId]) return;
    if (game.teamRosters[teamColor].length >= 4) return socket.emit('error_message', 'Team full!');

    game.teamMap[playerId] = teamColor;
    game.teamRosters[teamColor].push(playerId); 
    if (!game.hands[playerId]) game.hands[playerId] = game.deck.splice(0, 5);
    
    logAction(roomId, `${game.playerNames[playerId]} joined ${teamColor.toUpperCase()}`);
    socket.emit('assigned_team', teamColor);
    socket.emit('your_hand', game.hands[playerId]);
    broadcastRoomInfo(roomId); broadcastGameState(roomId);
  });

  socket.on('add_bot', (data) => {
    const { roomId, teamColor } = data;
    const game = games[roomId];
    if (!game || game.teamRosters[teamColor].length >= 4 || game.players.length >= 12) return;

    const botId = 'bot_' + Math.random().toString(36).substr(2, 9);
    const botNum = Math.floor(Math.random() * 99);
    
    game.players.push(botId);
    game.playerNames[botId] = `🤖 Bot ${botNum}`;
    game.teamMap[botId] = teamColor;
    game.teamRosters[teamColor].push(botId);
    game.hands[botId] = game.deck.splice(0, 5);

    logAction(roomId, `${game.playerNames[botId]} was deployed to ${teamColor.toUpperCase()}`);
    broadcastRoomInfo(roomId); broadcastGameState(roomId);
  });

  // --- THIS IS THE REMOVE BOT LOGIC ---
  socket.on('remove_bot', (data) => {
    const { roomId, teamColor } = data;
    const game = games[roomId];
    if (!game || game.isGameStarted) return; 

    const teamRoster = game.teamRosters[teamColor];
    let botIdToRemove = null;
    
    for (let i = teamRoster.length - 1; i >= 0; i--) {
      if (teamRoster[i].startsWith('bot_')) {
        botIdToRemove = teamRoster[i];
        break;
      }
    }

    if (botIdToRemove) {
      game.players = game.players.filter(p => p !== botIdToRemove);
      game.teamRosters[teamColor] = teamRoster.filter(p => p !== botIdToRemove);
      
      const botName = game.playerNames[botIdToRemove];
      delete game.playerNames[botIdToRemove];
      delete game.teamMap[botIdToRemove];
      delete game.hands[botIdToRemove];

      logAction(roomId, `${botName} was removed from ${teamColor.toUpperCase()}`);
      broadcastRoomInfo(roomId); 
      broadcastGameState(roomId);
    }
  });

  socket.on('start_game', (roomId) => {
    const game = games[roomId];
    if (!game || game.isGameStarted) return;
    
    if (game.teamRosters.red.length > 0) game.turn = 'red';
    else if (game.teamRosters.blue.length > 0) game.turn = 'blue';
    else if (game.teamRosters.green.length > 0) game.turn = 'green';
    else return;

    game.isGameStarted = true;
    game.turnDeadline = Date.now() + 60000;
    logAction(roomId, "MATCH STARTED!");
    broadcastGameState(roomId);
    triggerBotTurn(roomId); 
  });

  socket.on('ping_cell', (data) => {
    const { roomId, index, teamColor } = data;
    io.to(roomId).emit('receive_ping', { index, teamColor });
  });

  socket.on('send_chat', (data) => {
    const { roomId, playerId, msg } = data;
    const game = games[roomId];
    if (game) io.to(roomId).emit('chat_message', { name: game.playerNames[playerId], team: game.teamMap[playerId], msg });
  });

  socket.on('timeout_skip', (data) => {
    const { roomId, playerId } = data;
    const game = games[roomId];
    if (!game || game.winner || !game.isGameStarted) return;
    const expectedId = game.teamRosters[game.turn][game.teamTurnIndex[game.turn]];
    if (playerId !== expectedId || Date.now() < game.turnDeadline) return;

    logAction(roomId, `${game.playerNames[playerId]} ran out of time! Turn skipped.`);
    advanceTurn(roomId);
    broadcastGameState(roomId);
  });

  socket.on('trade_dead_card', (data) => {
    const { roomId, playerId, deadCard } = data;
    const game = games[roomId];
    if (!game || game.winner || !game.isGameStarted) return;
    
    const expectedId = game.teamRosters[game.turn][game.teamTurnIndex[game.turn]];
    if (playerId !== expectedId) return; 

    const indices = BOARD_LAYOUT.map((c, i) => c === deadCard ? i : -1).filter(i => i !== -1);
    const isDead = indices.every(i => game.board[i] !== null);

    if (isDead) {
      const hand = game.hands[playerId];
      hand.splice(hand.indexOf(deadCard), 1);
      if (game.deck.length > 0) hand.push(game.deck.shift());
      
      logAction(roomId, `${game.playerNames[playerId]} traded a dead card.`);
      socket.emit('your_hand', hand);
      advanceTurn(roomId); 
      broadcastGameState(roomId);
    }
  });

  socket.on('place_chip', (data) => {
    const { roomId, index, teamColor, playedCard, playerId } = data;
    const game = games[roomId];
    if (!game || game.winner || !game.isGameStarted) return;

    const expectedId = game.teamRosters[game.turn][game.teamTurnIndex[game.turn]];
    if (playerId !== expectedId) return; 

    if (executeMove(roomId, playerId, index, playedCard, teamColor)) {
      socket.emit('your_hand', game.hands[playerId] || []);
      broadcastGameState(roomId);
    }
  });

  socket.on('restart_game', (roomId) => {
    const game = games[roomId];
    if (!game) return;

    game.board = Array(100).fill(null); game.winner = null; game.winningLine = [];
    game.deck = generateShuffledDeck(); game.teamTurnIndex = { red: 0, blue: 0, green: 0 };
    game.turnDeadline = null; game.isGameStarted = false;

    logAction(roomId, "Game Restarted. Waiting to begin...");
    game.players.forEach(pid => {
      game.hands[pid] = game.deck.splice(0, 5);
    });
    io.to(roomId).emit('game_restarted', game.hands);
    broadcastGameState(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    const playerId = socket.playerId;
    if (!roomId || !playerId) return;

    const game = games[roomId];
    if (!game) return;

    const playerIndex = game.players.indexOf(playerId);
    if (playerIndex !== -1) {
      game.players.splice(playerIndex, 1);
      delete game.playerNames[playerId];
      const team = game.teamMap[playerId];
      if (team) {
        delete game.teamMap[playerId];
        const teamIndex = game.teamRosters[team].indexOf(playerId);
        if (teamIndex !== -1) {
          game.teamRosters[team].splice(teamIndex, 1);
        }
        delete game.hands[playerId];
      }

      const humanPlayers = game.players.filter(p => !p.startsWith('bot_'));
      if (humanPlayers.length === 0) {
        delete games[roomId];
        return;
      }

      if (game.host === playerId) {
        game.host = game.players[0] || null;
        logAction(roomId, `Host left. New host is ${game.playerNames[game.host] || 'unknown'}`);
      }

      broadcastRoomInfo(roomId);
      broadcastGameState(roomId);
    }
  });
});

server.listen(process.env.PORT || 3001, () => console.log('Server running'));
