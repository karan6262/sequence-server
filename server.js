const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for the live web
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

// Helper to send current room counts
function broadcastRoomInfo(roomId) {
  const game = games[roomId];
  if (!game) return;
  
  const counts = { red: 0, blue: 0, green: 0, total: game.players.length };
  for (let socketId of game.players) {
    const team = game.teamMap[socketId];
    if (team) counts[team]++;
  }
  io.to(roomId).emit('room_info', counts);
}

io.on('connection', (socket) => {
  
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    
    if (!games[roomId]) {
      games[roomId] = {
        board: Array(100).fill(null),
        turn: 'red',
        players: [],
        teamMap: {},
        deck: generateShuffledDeck(),
        hands: {},
        winner: null
      };
    }
    
    socket.emit('room_joined', roomId);
    broadcastRoomInfo(roomId); // Broadcast live counts to everyone in the room
  });

  socket.on('join_team', (data) => {
    const { roomId, teamColor } = data;
    const game = games[roomId];
    if (!game) return;

    // Check if the selected team already has 4 players
    let teamCount = 0;
    for (let p of game.players) {
      if (game.teamMap[p] === teamColor) teamCount++;
    }
    if (teamCount >= 4) return socket.emit('error_message', 'That team is already full!');

    if (!game.players.includes(socket.id)) {
      if (game.players.length >= 12) return socket.emit('error_message', 'Room is full (12 players max).');
      
      game.players.push(socket.id);
      game.hands[socket.id] = game.deck.splice(0, 5);
    }
    
    game.teamMap[socket.id] = teamColor;
    
    socket.emit('assigned_team', teamColor);
    socket.emit('your_hand', game.hands[socket.id]);
    io.to(roomId).emit('game_state', { board: game.board, turn: game.turn, winner: game.winner });
    
    broadcastRoomInfo(roomId); // Update counts globally after joining
  });

  socket.on('place_chip', (data) => {
    const { roomId, index, teamColor, playedCard } = data;
    const game = games[roomId];

    if (game.teamMap[socket.id] !== teamColor) return; 
    if (!game || game.winner) return;

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
        game.turn = NEXT_TURN[game.turn];
      }
      
      const playerHand = game.hands[socket.id];
      const cardIndex = playerHand.indexOf(playedCard);
      if (cardIndex > -1) playerHand.splice(cardIndex, 1); 

      if (game.deck.length > 0) playerHand.push(game.deck.shift()); 

      io.to(roomId).emit('game_state', { board: game.board, turn: game.turn, winner: game.winner });
      socket.emit('your_hand', playerHand);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});