const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function generateShuffledDeck() {
  let deck = [];
  for (let i = 0; i < 2; i++) {
    for (let suit of SUITS) {
      for (let value of VALUES) {
        deck.push(`${value}${suit}`);
      }
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
        for (let i = 0; i < 5; i++) {
          if (getCell(r + dr * i, c + dc * i) === team) count++;
          else break;
        }
        if (count === 5) return true;
      }
    }
  }
  return false;
}

const games = {};
const NEXT_TURN = { 'red': 'blue', 'blue': 'green', 'green': 'red' };

function getNextTeam(currentTeam, teamRosters) {
  let next = NEXT_TURN[currentTeam];
  if (teamRosters[next].length === 0) next = NEXT_TURN[next];
  if (teamRosters[next].length === 0) next = NEXT_TURN[next];
  return next;
}

function broadcastRoomInfo(roomId) {
  const game = games[roomId];
  if (!game) return;
  const roster = { red: [], blue: [], green: [], unassigned: [], total: game.players.length };
  
  // Now iterating over playerIds instead of socketIds
  for (let playerId of game.players) {
    const team = game.teamMap[playerId];
    const name = game.playerNames[playerId];
    if (team) roster[team].push(name);
    else roster.unassigned.push(name);
  }
  io.to(roomId).emit('room_info', roster);
}

function broadcastGameState(roomId) {
  const game = games[roomId];
  if (!game) return;
  
  const activeId = game.teamRosters[game.turn]?.[game.teamTurnIndex[game.turn]] || null;
  const activeName = activeId ? game.playerNames[activeId] : 'Waiting for players...';

  io.to(roomId).emit('game_state', { 
    board: game.board, 
    turn: game.turn, 
    activePlayerId: activeId, // This is now a playerId, not a socketId
    activePlayerName: activeName,
    winner: game.winner 
  });
}

io.on('connection', (socket) => {
  
  socket.on('join_room', (data) => {
    const { roomId, playerName, playerId } = data;
    socket.join(roomId);
    
    // Bind the unique ID to this socket instance
    socket.playerId = playerId; 
    socket.roomId = roomId;

    if (!games[roomId]) {
      games[roomId] = {
        board: Array(100).fill(null),
        turn: 'red',
        players: [], // Array of playerIds
        teamMap: {}, // Maps playerId to team
        playerNames: {}, // Maps playerId to name
        teamRosters: { red: [], blue: [], green: [] }, 
        teamTurnIndex: { red: 0, blue: 0, green: 0 },  
        deck: generateShuffledDeck(),
        hands: {}, // Maps playerId to hand
        winner: null
      };
    }
    
    const game = games[roomId];
    
    // RECONNECTION LOGIC
    if (game.players.includes(playerId)) {
      // User is already in the game (refreshed browser)
      game.playerNames[playerId] = playerName || game.playerNames[playerId]; // Update name
      socket.emit('room_joined', roomId);
      
      // If they already picked a team, bypass lobby and send them straight back to the game
      if (game.teamMap[playerId]) {
        socket.emit('assigned_team', game.teamMap[playerId]);
        socket.emit('your_hand', game.hands[playerId]);
      }
      broadcastRoomInfo(roomId); 
      broadcastGameState(roomId);
      return;
    }

    // NEW PLAYER LOGIC
    if (game.players.length >= 12) return socket.emit('error_message', 'Room is full.');
    
    game.players.push(playerId);
    game.playerNames[playerId] = playerName || 'Guest';
    
    socket.emit('room_joined', roomId);
    broadcastRoomInfo(roomId); 
    broadcastGameState(roomId);
  });

  socket.on('join_team', (data) => {
    const { roomId, teamColor, playerId } = data;
    const game = games[roomId];
    if (!game) return;

    if (game.teamRosters[teamColor].length >= 4) return socket.emit('error_message', 'That team is full!');
    if (game.teamMap[playerId]) return; // Prevent joining multiple teams

    game.teamMap[playerId] = teamColor;
    game.teamRosters[teamColor].push(playerId); 
    
    if (game.teamRosters[game.turn].length === 0) {
      game.turn = teamColor;
    }

    if (!game.hands[playerId]) {
        game.hands[playerId] = game.deck.splice(0, 5);
    }
    
    socket.emit('assigned_team', teamColor);
    socket.emit('your_hand', game.hands[playerId]);
    
    broadcastRoomInfo(roomId); 
    broadcastGameState(roomId);
  });

  socket.on('place_chip', (data) => {
    const { roomId, index, teamColor, playedCard, playerId } = data;
    const game = games[roomId];

    if (!game || game.winner) return;

    if (game.turn !== teamColor) return;
    const expectedPlayerId = game.teamRosters[game.turn][game.teamTurnIndex[game.turn]];
    if (playerId !== expectedPlayerId) return; 

    const isTwoEyedJack = playedCard === 'J♦' || playedCard === 'J♣';
    const isOneEyedJack = playedCard === 'J♠' || playedCard === 'J♥';
    let validMove = false;

    if (isTwoEyedJack && game.board[index] === null) {
      game.board[index] = teamColor;
      validMove = true;
    } else if (isOneEyedJack && game.board[index] !== null && game.board[index] !== teamColor) {
      game.board[index] = null;
      validMove = true;
    } else if (!isTwoEyedJack && !isOneEyedJack && game.board[index] === null) {
      game.board[index] = teamColor;
      validMove = true;
    }

    if (validMove) {
      if (checkWin(game.board, teamColor)) {
        game.winner = teamColor;
      } else {
        game.teamTurnIndex[game.turn] = (game.teamTurnIndex[game.turn] + 1) % game.teamRosters[game.turn].length;
        game.turn = getNextTeam(game.turn, game.teamRosters);
      }
      
      const playerHand = game.hands[playerId];
      const cardIndex = playerHand.indexOf(playedCard);
      if (cardIndex > -1) playerHand.splice(cardIndex, 1); 

      if (game.deck.length > 0) playerHand.push(game.deck.shift()); 

      socket.emit('your_hand', playerHand);
      broadcastGameState(roomId);
    }
  });

  socket.on('restart_game', (roomId) => {
    const game = games[roomId];
    if (!game) return;

    game.board = Array(100).fill(null);
    game.winner = null;
    game.deck = generateShuffledDeck();
    game.teamTurnIndex = { red: 0, blue: 0, green: 0 };
    
    if (game.teamRosters.red.length > 0) game.turn = 'red';
    else if (game.teamRosters.blue.length > 0) game.turn = 'blue';
    else if (game.teamRosters.green.length > 0) game.turn = 'green';

    // Broadcast new hands to the specific sockets in the room
    game.players.forEach(pid => {
      game.hands[pid] = game.deck.splice(0, 5);
    });
    
    // We send to everyone in the room; the frontend will grab their specific hand
    io.to(roomId).emit('game_restarted', game.hands);
    broadcastGameState(roomId);
  });

  socket.on('disconnect', () => {
    // We intentionally DO NOT delete the player from the game arrays here.
    // This allows them to refresh the page and instantly rejoin using their playerId.
    // If the game completes or sits empty for hours, memory will eventually wipe when the server restarts.
    console.log(`Socket disconnected, but keeping playerId: ${socket.playerId} active in memory.`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
