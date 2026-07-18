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
