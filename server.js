const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serwowanie plików statycznych z katalogu, w którym jest server.js
app.use(express.static(path.join(__dirname)));

const gameRooms = {}; // Przechowuje stan wszystkich pokoi gier

const GAME_CONFIG = {
    INPUT_TIME: 60,
    RESULTS_TIME: 15,
    DEFAULT_INPUT: 50.00,
    TARGET_MULTIPLIER: 0.8
};

io.on('connection', (socket) => {
    console.log(`Nowy gracz połączony: ${socket.id}`);

    socket.on('createGame', ({ playerName, totalRounds }) => {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        socket.join(roomCode);

        gameRooms[roomCode] = {
            roomCode,
            totalRounds,
            currentRound: 0,
            lastRoundAverage: 50.0,
            players: {},
            state: 'lobby', // lobby, in-game, results, end
            timers: {}
        };

        gameRooms[roomCode].players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            isHost: true,
            lastChoice: null
        };

        console.log(`Gracz ${playerName} (${socket.id}) stworzył pokój ${roomCode}`);
        io.to(roomCode).emit('gameUpdate', gameRooms[roomCode]);
    });

    socket.on('joinGame', ({ playerName, roomCode }) => {
        const room = gameRooms[roomCode];
        if (room && room.state === 'lobby') {
            socket.join(roomCode);
            room.players[socket.id] = {
                id: socket.id,
                name: playerName,
                score: 0,
                isHost: false,
                lastChoice: null
            };
            console.log(`Gracz ${playerName} (${socket.id}) dołączył do pokoju ${roomCode}`);
            io.to(roomCode).emit('gameUpdate', room);
        } else {
            socket.emit('error', { message: 'Nie można dołączyć do pokoju. Sprawdź kod lub gra już trwa.' });
        }
    });

    socket.on('startGame', ({ roomCode }) => {
        const room = gameRooms[roomCode];
        if (room && room.players[socket.id]?.isHost) {
            console.log(`Gra w pokoju ${roomCode} rozpoczęta.`);
            startNextRound(roomCode);
        }
    });

    socket.on('submitNumber', ({ roomCode, number }) => {
        const room = gameRooms[roomCode];
        if (room && room.players[socket.id] && room.state === 'in-game') {
            room.players[socket.id].lastChoice = number;
            console.log(`Gracz ${room.players[socket.id].name} w pokoju ${roomCode} wybrał ${number}`);
            
            // Sprawdź, czy wszyscy gracze dokonali wyboru
            const allPlayersMadeChoice = Object.values(room.players).every(p => p.lastChoice !== null);
            if (allPlayersMadeChoice) {
                processRound(roomCode);
            } else {
                // Wyślij zaktualizowany stan, aby pokazać, kto już wybrał
                io.to(roomCode).emit('gameUpdate', room);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Gracz ${socket.id} rozłączony.`);
        // Znajdź pokój, w którym był gracz i usuń go
        for (const roomCode in gameRooms) {
            const room = gameRooms[roomCode];
            if (room.players[socket.id]) {
                delete room.players[socket.id];
                // Jeśli pokój jest pusty, usuń go
                if (Object.keys(room.players).length === 0) {
                    console.log(`Usuwanie pustego pokoju ${roomCode}`);
                    delete gameRooms[roomCode];
                } else {
                    // Jeśli host się rozłączył, wybierz nowego
                    const isHost = Object.values(room.players).some(p => p.isHost);
                    if (!isHost) {
                        Object.values(room.players)[0].isHost = true;
                    }
                    io.to(roomCode).emit('gameUpdate', room);
                }
                break;
            }
        }
    });
});

function startNextRound(roomCode) {
    const room = gameRooms[roomCode];
    if (!room) return;

    // Wyczyść poprzednie timery
    if (room.timers.inputTimerId) clearTimeout(room.timers.inputTimerId);
    if (room.timers.resultsTimerId) clearTimeout(room.timers.resultsTimerId);

    room.currentRound++;
    room.state = 'in-game';
    Object.values(room.players).forEach(p => p.lastChoice = null); // Resetuj wybory

    io.to(roomCode).emit('gameUpdate', room);
    io.to(roomCode).emit('startRound', { round: room.currentRound, time: GAME_CONFIG.INPUT_TIME });

    // Ustaw timer na serwerze, który zakończy rundę, jeśli gracze nie odpowiedzą
    room.timers.inputTimerId = setTimeout(() => {
        console.log(`Czas na wybór w pokoju ${roomCode} minął.`);
        processRound(roomCode);
    }, GAME_CONFIG.INPUT_TIME * 1000);
}

function processRound(roomCode) {
    const room = gameRooms[roomCode];
    if (!room || room.state !== 'in-game') return;

    // Wyczyść timer rundy
    if (room.timers.inputTimerId) clearTimeout(room.timers.inputTimerId);

    room.state = 'results';

    // Ustaw domyślne wartości dla graczy, którzy nie wybrali
    Object.values(room.players).forEach(p => {
        if (p.lastChoice === null) {
            p.lastChoice = GAME_CONFIG.DEFAULT_INPUT;
        }
    });

    const allChoices = Object.values(room.players).map(p => p.lastChoice);
    const sum = allChoices.reduce((acc, val) => acc + val, 0);
    const average = parseFloat((sum / allChoices.length).toFixed(2));
    room.lastRoundAverage = average;

    const target = parseFloat((average * GAME_CONFIG.TARGET_MULTIPLIER).toFixed(2));

    let minDiff = Infinity;
    const playerResults = Object.values(room.players).map(player => {
        const diff = parseFloat(Math.abs(player.lastChoice - target).toFixed(2));
        if (diff < minDiff) {
            minDiff = diff;
        }
        return { ...player, diff };
    });

    const winners = playerResults.filter(p => p.diff === minDiff);
    winners.forEach(winner => {
        room.players[winner.id].score++;
    });

    const resultsPayload = {
        results: playerResults,
        average,
        target,
        winners: winners.map(w => ({ id: w.id, name: w.name })),
        minDiff
    };

    io.to(roomCode).emit('roundResults', resultsPayload);
    io.to(roomCode).emit('gameUpdate', room); // Zaktualizuj stan z nowymi wynikami

    // Ustaw timer na pokazanie wyników
    room.timers.resultsTimerId = setTimeout(() => {
        if (room.currentRound >= room.totalRounds) {
            endGame(roomCode);
        } else {
            startNextRound(roomCode);
        }
    }, GAME_CONFIG.RESULTS_TIME * 1000);
}

function endGame(roomCode) {
    const room = gameRooms[roomCode];
    if (!room) return;

    room.state = 'end';
    const sortedPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
    const maxScore = sortedPlayers[0].score;
    const finalWinners = sortedPlayers.filter(p => p.score === maxScore);

    const endPayload = {
        sortedPlayers,
        finalWinners: finalWinners.map(w => ({ id: w.id, name: w.name }))
    };

    io.to(roomCode).emit('gameOver', endPayload);
    io.to(roomCode).emit('gameUpdate', room);
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serwer nasłuchuje na porcie ${PORT} pod adresem 0.0.0.0`);
    console.log(`Lokalnie dostępny pod adresem http://localhost:${PORT}`);
});