import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const browserDistFolder = join(import.meta.dirname, '../browser');

// Use a fixed path in the project root for the data file
const dataDir = process.env['DATA_DIR'] || join(process.cwd(), 'data');
const dataFilePath = join(dataDir, 'pool-club-data.json');

// Ensure data directory exists
try {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
} catch (error) {
  console.error('Failed to create data directory:', error);
}

// --- Data Types ---
interface Player {
  name: string;
  isPaying: boolean;
  joinedAt?: string; // ISO timestamp when player joined
}

interface Round {
  id: string;
  startTime: string;
  endTime?: string;
  payers: string[]; // Player names who are paying for this round (can be multiple)
  isActive: boolean;
}

interface Game {
  id: string;
  tableId: number;
  startTime: string;
  endTime?: string;
  players: Player[];
  rounds: Round[]; // Track rounds - each round has payers decided at the end
  isActive: boolean;
}

interface PoolTable {
  id: number;
  name: string;
  status: 'available' | 'occupied' | 'maintenance';
}

interface TablePosition {
  tableId: number;
  x: number;
  y: number;
  rotation: number;
}

interface User {
  username: string;
  password: string;
  role: 'manager' | 'player';
}

interface Settings {
  hourlyRate: number; // Cost per hour in local currency
}

interface DataStore {
  tables: PoolTable[];
  games: Game[];
  users: User[];
  settings: Settings;
  tablePositions?: TablePosition[];
}

// --- Data Storage Functions ---
function getDefaultData(): DataStore {
  return {
    tables: Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      name: `Table ${i + 1}`,
      status: 'available' as const
    })),
    games: [],
    users: [
      { username: 'manager', password: 'pool2024', role: 'manager' }
    ],
    settings: {
      hourlyRate: 50 // Default 50 per hour
    }
  };
}

function loadData(): DataStore {
  try {
    if (existsSync(dataFilePath)) {
      const content = readFileSync(dataFilePath, 'utf-8');
      const data = JSON.parse(content);
      // Ensure settings exist (for backward compatibility)
      if (!data.settings) {
        data.settings = { hourlyRate: 50 };
      }
      return data;
    }
  } catch (error) {
    console.error('Error loading data:', error);
  }
  const defaultData = getDefaultData();
  saveData(defaultData);
  return defaultData;
}

// Calculate cost for a game based on duration and hourly rate
function calculateGameCost(startTime: string, endTime: string | undefined, hourlyRate: number): number {
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const durationHours = (end - start) / (1000 * 60 * 60);
  return Math.round(durationHours * hourlyRate * 100) / 100; // Round to 2 decimal places
}

// Calculate duration and cost for a single round
function calculateRoundDetails(round: Round, endTime: number, hourlyRate: number): {
  duration: string;
  durationMinutes: number;
  cost: number;
} {
  const roundStart = new Date(round.startTime).getTime();
  const roundEnd = round.endTime ? new Date(round.endTime).getTime() : endTime;

  const roundMinutes = (roundEnd - roundStart) / (1000 * 60);
  const hours = Math.floor(roundMinutes / 60);
  const mins = Math.floor(roundMinutes % 60);
  const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  const roundHours = roundMinutes / 60;
  const roundCost = Math.round(roundHours * hourlyRate * 100) / 100;

  return {
    duration: durationStr,
    durationMinutes: Math.round(roundMinutes),
    cost: roundCost
  };
}

// Enrich rounds with duration and cost details
function enrichRoundsWithDetails(rounds: Round[], endTime: number, hourlyRate: number): (Round & {
  duration: string;
  durationMinutes: number;
  cost: number;
})[] {
  return rounds.map(round => {
    const details = calculateRoundDetails(round, endTime, hourlyRate);
    return {
      ...round,
      ...details
    };
  });
}

function saveData(data: DataStore): void {
  try {
    writeFileSync(dataFilePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

const app = express();
const angularApp = new AngularNodeAppEngine();

// Parse JSON bodies
app.use(express.json());

// --- API Endpoints ---

// Get settings
app.get('/api/settings', (req, res) => {
  const data = loadData();
  res.json(data.settings);
});

// Update settings
app.patch('/api/settings', (req, res) => {
  const data = loadData();
  data.settings = { ...data.settings, ...req.body };
  saveData(data);
  res.json(data.settings);
});

// Get table positions for canvas layout
app.get('/api/table-positions', (req, res) => {
  const data = loadData();
  res.json(data.tablePositions || []);
});

// Save table positions for canvas layout
app.put('/api/table-positions', (req, res) => {
  const data = loadData();
  const positions: TablePosition[] = req.body;
  data.tablePositions = positions;
  saveData(data);
  res.json(data.tablePositions);
});

// Update a single table position
app.patch('/api/table-positions/:tableId', (req, res) => {
  const data = loadData();
  const tableId = parseInt(req.params['tableId']);
  const { x, y, rotation } = req.body;

  if (!data.tablePositions) {
    data.tablePositions = [];
  }

  const existingIndex = data.tablePositions.findIndex(p => p.tableId === tableId);
  const newPosition: TablePosition = { tableId, x, y, rotation };

  if (existingIndex >= 0) {
    data.tablePositions[existingIndex] = newPosition;
  } else {
    data.tablePositions.push(newPosition);
  }

  saveData(data);
  res.json(newPosition);
});

// Calculate how much each player owes based on rounds
// Each round's cost is split among the payers for that round
function calculateRoundCosts(
  rounds: Round[],
  endTime: number, // timestamp (Date.now() or game end time)
  hourlyRate: number
): Map<string, number> {
  const playerCosts = new Map<string, number>();

  if (!rounds || rounds.length === 0) {
    return playerCosts;
  }

  for (const round of rounds) {
    const roundStart = new Date(round.startTime).getTime();
    const roundEnd = round.endTime ? new Date(round.endTime).getTime() : endTime;

    const roundMinutes = (roundEnd - roundStart) / (1000 * 60);
    const roundHours = roundMinutes / 60;
    const roundCost = roundHours * hourlyRate;

    // Split cost among payers (if no payers, cost is not assigned)
    if (round.payers && round.payers.length > 0) {
      const costPerPayer = roundCost / round.payers.length;
      for (const payer of round.payers) {
        const currentCost = playerCosts.get(payer) || 0;
        playerCosts.set(payer, currentCost + costPerPayer);
      }
    }
  }

  // Round all costs to 2 decimal places
  for (const [name, cost] of playerCosts) {
    playerCosts.set(name, Math.round(cost * 100) / 100);
  }

  return playerCosts;
}

// Calculate per-player cost details for active games (using current time as end)
// Each player's cost is based on rounds they paid for
function calculateActivePlayerDetails(
  players: Player[],
  gameStartTime: string,
  rounds: Round[],
  hourlyRate: number
) {
  const now = Date.now();
  const gameStart = new Date(gameStartTime).getTime();

  // Calculate costs based on rounds
  const playerCosts = calculateRoundCosts(rounds, now, hourlyRate);

  return players.map(player => {
    const playerJoinTime = player.joinedAt
      ? new Date(player.joinedAt).getTime()
      : gameStart;

    const playerMinutes = (now - playerJoinTime) / (1000 * 60);
    const hours = Math.floor(playerMinutes / 60);
    const mins = Math.floor(playerMinutes % 60);
    const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    // Get the cost this player owes based on rounds they paid for
    const playerCost = playerCosts.get(player.name) || 0;

    return {
      name: player.name,
      isPaying: player.isPaying,
      joinedAt: player.joinedAt || gameStartTime,
      duration: durationStr,
      durationMinutes: Math.round(playerMinutes),
      cost: playerCost
    };
  });
}

// Add a new table
app.post('/api/tables', (req, res) => {
  const data = loadData();

  // Find next available ID
  const maxId = data.tables.reduce((max, t) => Math.max(max, t.id), 0);
  const newId = maxId + 1;

  const newTable: PoolTable = {
    id: newId,
    name: `Table ${newId}`,
    status: 'available'
  };

  data.tables.push(newTable);
  saveData(data);
  res.status(201).json(newTable);
});

// Delete a table
app.delete('/api/tables/:id', (req, res) => {
  const data = loadData();
  const tableId = parseInt(req.params['id']);

  // Check if table exists
  const tableIndex = data.tables.findIndex(t => t.id === tableId);
  if (tableIndex === -1) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }

  // Check if table has active game
  const hasActiveGame = data.games.some(g => g.tableId === tableId && g.isActive);
  if (hasActiveGame) {
    res.status(400).json({ error: 'Cannot delete table with active game' });
    return;
  }

  // Remove the table
  data.tables.splice(tableIndex, 1);

  // Also remove any position data for this table
  if (data.tablePositions) {
    data.tablePositions = data.tablePositions.filter(p => p.tableId !== tableId);
  }

  saveData(data);
  res.json({ success: true });
});

// Get all tables with current games
app.get('/api/tables', (req, res) => {
  const data = loadData();
  const tablesWithGames = data.tables.map(table => {
    const currentGame = data.games.find(g => g.tableId === table.id && g.isActive);
    const pastGames = data.games.filter(g => g.tableId === table.id && !g.isActive);

    // Calculate current cost and player details if there's an active game
    let currentCost: number | undefined;
    let playerDetails: ReturnType<typeof calculateActivePlayerDetails> | undefined;
    let currentRound: (Round & { duration: string; durationMinutes: number; cost: number }) | undefined;
    let enrichedRounds: (Round & { duration: string; durationMinutes: number; cost: number })[] | undefined;
    if (currentGame) {
      const now = Date.now();
      playerDetails = calculateActivePlayerDetails(
        currentGame.players,
        currentGame.startTime,
        currentGame.rounds || [],
        data.settings.hourlyRate
      );
      // Total cost is sum of all player costs
      currentCost = playerDetails.reduce((sum, p) => sum + p.cost, 0);
      currentCost = Math.round(currentCost * 100) / 100;
      // Enrich all rounds with duration and cost
      enrichedRounds = enrichRoundsWithDetails(currentGame.rounds || [], now, data.settings.hourlyRate);
      // Find active round (enriched)
      currentRound = enrichedRounds.find(r => r.isActive);
    }

    return {
      ...table,
      currentGame: currentGame ? {
        ...currentGame,
        rounds: enrichedRounds || currentGame.rounds,
        currentCost,
        playerDetails,
        currentRound
      } : undefined,
      games: pastGames,
      hourlyRate: data.settings.hourlyRate
    };
  });
  res.json(tablesWithGames);
});

// Get single table
app.get('/api/tables/:id', (req, res) => {
  const data = loadData();
  const tableId = parseInt(req.params['id']);
  const table = data.tables.find(t => t.id === tableId);
  if (!table) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }
  const currentGame = data.games.find(g => g.tableId === tableId && g.isActive);
  const pastGames = data.games.filter(g => g.tableId === tableId && !g.isActive);
  res.json({ ...table, currentGame, games: pastGames });
});

// Update table status
app.patch('/api/tables/:id', (req, res) => {
  const data = loadData();
  const tableId = parseInt(req.params['id']);
  const tableIndex = data.tables.findIndex(t => t.id === tableId);
  if (tableIndex === -1) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }
  data.tables[tableIndex] = { ...data.tables[tableIndex], ...req.body };
  saveData(data);
  res.json(data.tables[tableIndex]);
});

// Start a game
app.post('/api/games', (req, res) => {
  const data = loadData();
  const { tableId, players } = req.body;

  const table = data.tables.find(t => t.id === tableId);
  if (!table) {
    res.status(404).json({ error: 'Table not found' });
    return;
  }

  const now = new Date().toISOString();

  // Create first round automatically when game starts
  const firstRound: Round = {
    id: crypto.randomUUID(),
    startTime: now,
    payers: [],
    isActive: true
  };

  const newGame: Game = {
    id: crypto.randomUUID(),
    tableId,
    startTime: now,
    players,
    rounds: [firstRound],
    isActive: true
  };

  data.games.push(newGame);

  // Update table status
  const tableIndex = data.tables.findIndex(t => t.id === tableId);
  data.tables[tableIndex].status = 'occupied';

  saveData(data);
  res.status(201).json(newGame);
});

// End a game
app.patch('/api/games/:id/end', (req, res) => {
  const data = loadData();
  const gameIndex = data.games.findIndex(g => g.id === req.params['id']);

  if (gameIndex === -1) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  data.games[gameIndex].endTime = new Date().toISOString();
  data.games[gameIndex].isActive = false;

  // Update table status
  const tableId = data.games[gameIndex].tableId;
  const tableIndex = data.tables.findIndex(t => t.id === tableId);
  if (tableIndex !== -1) {
    data.tables[tableIndex].status = 'available';
  }

  saveData(data);
  res.json(data.games[gameIndex]);
});

// Update game (e.g., update players list)
app.patch('/api/games/:id', (req, res) => {
  const data = loadData();
  const gameIndex = data.games.findIndex(g => g.id === req.params['id']);

  if (gameIndex === -1) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  data.games[gameIndex] = { ...data.games[gameIndex], ...req.body };
  saveData(data);
  res.json(data.games[gameIndex]);
});

// End current round and set payers (players decide who pays at round end)
app.patch('/api/games/:id/rounds/end', (req, res) => {
  const data = loadData();
  const gameIndex = data.games.findIndex(g => g.id === req.params['id']);

  if (gameIndex === -1) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const game = data.games[gameIndex];
  const { payers } = req.body; // Array of player names who pay for this round
  const now = new Date().toISOString();

  // Find active round and end it
  const activeRoundIndex = game.rounds?.findIndex(r => r.isActive);
  if (activeRoundIndex === undefined || activeRoundIndex === -1) {
    res.status(400).json({ error: 'No active round found' });
    return;
  }

  // End the current round with selected payers
  game.rounds[activeRoundIndex].endTime = now;
  game.rounds[activeRoundIndex].payers = payers || [];
  game.rounds[activeRoundIndex].isActive = false;

  saveData(data);
  res.json(game);
});

// Start a new round
app.post('/api/games/:id/rounds/start', (req, res) => {
  const data = loadData();
  const gameIndex = data.games.findIndex(g => g.id === req.params['id']);

  if (gameIndex === -1) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const game = data.games[gameIndex];
  const now = new Date().toISOString();

  // Check if there's already an active round
  const hasActiveRound = game.rounds?.some(r => r.isActive);
  if (hasActiveRound) {
    res.status(400).json({ error: 'There is already an active round. End it first.' });
    return;
  }

  // Create new round
  const newRound: Round = {
    id: crypto.randomUUID(),
    startTime: now,
    payers: [],
    isActive: true
  };

  if (!game.rounds) {
    game.rounds = [];
  }
  game.rounds.push(newRound);

  saveData(data);
  res.json(game);
});

// Login
app.post('/api/auth/login', (req, res) => {
  const data = loadData();
  const { username, password } = req.body;

  const user = data.users.find(u => u.username === username && u.password === password);
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  res.json({ username: user.username, role: user.role });
});

// Calculate per-player cost details for completed games
// Each player pays based on rounds they paid for
function calculatePlayerDetails(
  players: Player[],
  gameStartTime: string,
  gameEndTime: string,
  rounds: Round[],
  hourlyRate: number
) {
  const endTime = new Date(gameEndTime).getTime();
  const gameStart = new Date(gameStartTime).getTime();

  // Calculate costs based on rounds
  const playerCosts = calculateRoundCosts(rounds, endTime, hourlyRate);

  return players.map(player => {
    // If player has joinedAt, use it; otherwise assume they joined at game start
    const playerJoinTime = player.joinedAt
      ? new Date(player.joinedAt).getTime()
      : gameStart;

    const playerMinutes = (endTime - playerJoinTime) / (1000 * 60);
    const hours = Math.floor(playerMinutes / 60);
    const mins = Math.floor(playerMinutes % 60);
    const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    // Get the cost this player owes based on rounds they paid for
    const playerCost = playerCosts.get(player.name) || 0;

    return {
      name: player.name,
      isPaying: player.isPaying,
      joinedAt: player.joinedAt || gameStartTime,
      duration: durationStr,
      durationMinutes: Math.round(playerMinutes),
      cost: playerCost
    };
  });
}

// Get game history (completed games)
app.get('/api/games/history', (req, res) => {
  const data = loadData();
  const limit = parseInt(req.query['limit'] as string) || 50;

  const completedGames = data.games
    .filter(g => !g.isActive && g.endTime)
    .map(g => {
      const table = data.tables.find(t => t.id === g.tableId);
      const playerDetails = calculatePlayerDetails(
        g.players,
        g.startTime,
        g.endTime!,
        g.rounds || [],
        data.settings.hourlyRate
      );

      // Total cost is sum of all player costs
      const totalCost = playerDetails.reduce((sum, p) => sum + p.cost, 0);
      const playerCount = g.players.length || 1;
      const costPerPlayer = Math.round((totalCost / playerCount) * 100) / 100;

      return {
        ...g,
        tableName: table?.name || `Table ${g.tableId}`,
        playerDetails,
        totalCost: Math.round(totalCost * 100) / 100,
        costPerPlayer
      };
    })
    .sort((a, b) => new Date(b.endTime!).getTime() - new Date(a.endTime!).getTime())
    .slice(0, limit);

  res.json(completedGames);
});

// Reset all tables
app.post('/api/reset', (req, res) => {
  const data = loadData();

  // End all active games
  data.games.forEach(game => {
    if (game.isActive) {
      game.isActive = false;
      game.endTime = new Date().toISOString();
    }
  });

  // Reset all tables to available
  data.tables.forEach(table => {
    table.status = 'available';
  });

  saveData(data);
  res.json({ success: true });
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => {
      if (response) {
        writeResponseToNodeResponse(response, res);
      } else {
        // Fallback: serve the CSR HTML for client-side routes
        const indexHtml = join(browserDistFolder, 'index.csr.html');
        if (existsSync(indexHtml)) {
          res.sendFile(indexHtml);
        } else {
          next();
        }
      }
    })
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
