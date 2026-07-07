// Table definitions. All coordinates in logical units (TABLE_W x TABLE_H).
// Every device simulates/replays in this space and only scales for display,
// so replays look identical everywhere.

const TABLE_W = 1600;
const TABLE_H = 900;

function diamondPoly(cx, cy, r) {
  return { pts: [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]] };
}

function rectPoly(x0, y0, x1, y1) {
  return { pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

const TABLES = [
  {
    id: 'classic',
    name: 'Classic',
    obstacles: [],
    spawns: [
      [220, 220], [1380, 680], [220, 680], [1380, 220],
      [800, 160], [800, 740], [340, 450], [1260, 450],
    ],
  },
  {
    id: 'diamonds',
    name: 'Diamonds',
    obstacles: [
      diamondPoly(430, 280, 150),
      diamondPoly(1170, 620, 150),
    ],
    spawns: [
      [170, 730], [1430, 170], [800, 450], [170, 170],
      [1430, 730], [800, 120], [430, 660], [1170, 240],
    ],
  },
  {
    id: 'gate',
    name: 'The Gate',
    obstacles: [
      rectPoly(730, 0, 870, 310),
      rectPoly(730, 590, 870, 900),
    ],
    spawns: [
      [220, 220], [220, 680], [1380, 220], [1380, 680],
      [500, 450], [1100, 450], [280, 450], [1320, 450],
    ],
  },
  {
    id: 'octagon',
    name: 'Octagon',
    obstacles: [
      { pts: [[0, 0], [280, 0], [0, 280]] },
      { pts: [[1600, 0], [1600, 280], [1320, 0]] },
      { pts: [[1600, 900], [1320, 900], [1600, 620]] },
      { pts: [[0, 900], [0, 620], [280, 900]] },
    ],
    spawns: [
      [800, 200], [800, 700], [300, 450], [1300, 450],
      [560, 260], [1040, 640], [560, 640], [1040, 260],
    ],
  },
  {
    id: 'pillars',
    name: 'Pillars',
    obstacles: [
      diamondPoly(420, 260, 95),
      diamondPoly(1180, 260, 95),
      diamondPoly(420, 640, 95),
      diamondPoly(1180, 640, 95),
    ],
    spawns: [
      [800, 450], [170, 450], [1430, 450], [800, 150],
      [800, 750], [170, 150], [1430, 750], [1430, 150],
    ],
  },
  {
    id: 'cross',
    name: 'The Cross',
    obstacles: [
      rectPoly(600, 410, 1000, 490),
      rectPoly(760, 270, 840, 630),
    ],
    spawns: [
      [200, 200], [1400, 200], [200, 700], [1400, 700],
      [800, 120], [800, 780], [200, 450], [1400, 450],
    ],
  },
  {
    id: 'hourglass',
    name: 'Hourglass',
    obstacles: [
      { pts: [[620, 0], [980, 0], [800, 280]] },
      { pts: [[620, 900], [980, 900], [800, 620]] },
    ],
    spawns: [
      [250, 450], [1350, 450], [250, 150], [250, 750],
      [1350, 150], [1350, 750], [800, 450], [520, 250],
    ],
  },
  {
    id: 'arena',
    name: 'Arena',
    obstacles: [
      diamondPoly(800, 450, 140),
      { pts: [[0, 0], [180, 0], [0, 180]] },
      { pts: [[1600, 0], [1600, 180], [1420, 0]] },
      { pts: [[1600, 900], [1420, 900], [1600, 720]] },
      { pts: [[0, 900], [0, 720], [180, 900]] },
    ],
    spawns: [
      [300, 200], [1300, 200], [300, 700], [1300, 700],
      [800, 150], [800, 750], [220, 450], [1380, 450],
    ],
  },
  {
    id: 'slalom',
    name: 'Slalom',
    obstacles: [
      rectPoly(370, 0, 460, 500),
      rectPoly(755, 400, 845, 900),
      rectPoly(1140, 0, 1230, 500),
    ],
    spawns: [
      [180, 180], [180, 450], [180, 700], [1420, 180],
      [1420, 450], [1420, 700], [600, 650], [960, 220],
    ],
  },
];

function getTable(id) {
  return TABLES.find(t => t.id === id) || TABLES[0];
}

const PLAYER_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#eab308',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316',
];

const EMOJI_LIST = [
  '😎', '🤖', '👻', '🐱', '🐸', '🦊', '🐼', '🦁',
  '👽', '💀', '🤡', '👑', '⚡', '🔥', '💎', '🚀',
  '🍕', '🌮', '⭐', '🎩', '🧠', '🦄', '🐙', '🍄',
];
