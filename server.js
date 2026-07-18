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
        let count = 0;
        let line = [];
        for (let i = 0; i < 5; i++) {
          if (getCell(r + dr * i, c + dc * i) === team) {
            count++;
            line.push((r + dr * i) * 10 + (c + dc * i));
          } else break;
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
}

function broadcastGameState(roomId) {
  const game = games[roomId];
  if (!game) return;
  const activeId = game.teamRosters[game.turn]?.[game.teamTurnIndex[game.turn]] || null;
  const activeName = activeId ? game.playerNames[activeId] : 'Waiting...';

  io.to(roomId).emit('game_state', { 
    board: game.board, turn: game.turn, activePlayerId: activeId, activePlayerName: activeName,
    winner: game.winner, winningLine: game.winningLine, logs: game.logs, 
    turnDeadline: game.turnDeadline, isGameStarted: game.isGameStarted // NEW: Send started state
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

io.on('connection', (socket) => {
  
  socket.on('join_room', (data) => {
    const { roomId, playerName, playerId } = data;
    socket.join(roomId);
    socket.playerId = playerId; 

    if (!games[roomId]) {
      games[roomId] = {
        board: Array(100).fill(null), turn: 'red', players: [], teamMap: {}, playerNames: {},
        teamRosters: { red: [], blue: [], green: [] }, teamTurnIndex: { red: 0, blue: 0, green: 0 },  
        deck: generateShuffledDeck(), hands: {}, winner: null, winningLine: [], logs: [], 
        turnDeadline: null, isGameStarted: false // NEW: Game does not start automatically
      };
      logAction(roomId, "Room created.");
    }
    
    const game = games[roomId];
    if (game.players.includes(playerId)) {
      game.playerNames[playerId] = playerName || game.playerNames[playerId];
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
    game.playerNames[playerId] = playerName || 'Guest';
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

  // NEW: Start Game Event
  socket.on('start_game', (roomId) => {
    const game = games[roomId];
    if (!game || game.isGameStarted) return;
    
    // Assign turn to first team that has players
    if (game.teamRosters.red.length > 0) game.turn = 'red';
    else if (game.teamRosters.blue.length > 0) game.turn = 'blue';
    else if (game.teamRosters.green.length > 0) game.turn = 'green';
    else return;

    game.isGameStarted = true;
    game.turnDeadline = Date.now() + 60000;
    logAction(roomId, "MATCH STARTED!");
    broadcastGameState(roomId);
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
        // REMOVED: game.isGameStarted = false; (Keep this true so turn layouts don't crash)
        logAction(roomId, `${teamColor.toUpperCase()} TEAM WINS!`);
      } else {
        advanceTurn(roomId);
      }
      
      const hand = game.hands[playerId];
      if (hand && hand.indexOf(playedCard) > -1) {
        hand.splice(hand.indexOf(playedCard), 1); 
        if (game.deck.length > 0) hand.push(game.deck.shift()); 
      }

      socket.emit('your_hand', hand || []);
      broadcastGameState(roomId);
    }
  });
  socket.on('restart_game', (roomId) => {
    const game = games[roomId];
    if (!game) return;
    
    // Reset everything, but keep isGameStarted false so they have to manually start round 2
    game.board = Array(100).fill(null); game.winner = null; game.winningLine = [];
    game.deck = generateShuffledDeck(); game.teamTurnIndex = { red: 0, blue: 0, green: 0 };
    game.turnDeadline = null;
    game.isGameStarted = false; 

    logAction(roomId, "Game Restarted. Waiting to begin...");
    game.players.forEach(pid => {
      game.hands[pid] = game.deck.splice(0, 5);
    });
    io.to(roomId).emit('game_restarted', game.hands);
    broadcastGameState(roomId);
  });
});

server.listen(process.env.PORT || 3001, () => console.log('Server running'));
