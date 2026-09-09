const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// تنظیمات کلی نقشه و بازی
// ------------------------------------------------------------
const MAP_SIZE = 150; 
const PLAYER_RADIUS = 0.6;
const CONE_HALF_ANGLE = 32;
const MOVE_SPEED = 9;

const WEAPONS = [
  { name: 'شاتگان', damageMin: 200, damageMax: 300, range: 15, magSize: 2, totalAmmo: 10, reloadMs: 2000, fireCooldownMs: 800 },
  { name: 'برنو', damageMin: 50, damageMax: 100, range: 10, magSize: 5, totalAmmo: 20, reloadMs: 2400, fireCooldownMs: 1000 },
  { name: 'اسنایپر', damageMin: 300, damageMax: 400, range: 45, magSize: 1, totalAmmo: 5, reloadMs: 3000, fireCooldownMs: 1500 },
  { name: 'ak48', damageMin: 150, damageMax: 200, range: 35, magSize: 10, totalAmmo: 30, reloadMs: 2000, fireCooldownMs: 150 },
  { name: 'تیر و کمان', damageMin: 100, damageMax: 150, range: 25, magSize: 1, totalAmmo: 30, reloadMs: 1000, fireCooldownMs: 500 }
];

const COMPASS_FA = ['شمال', 'شمال‌شرق', 'شرق', 'جنوب‌شرق', 'جنوب', 'جنوب‌غرب', 'غرب', 'شمال‌غرب'];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateObstacles() {
  const rng = mulberry32(1985);
  const obstacles = [];
  const count = 80;
  for (let i = 0; i < count; i++) {
    const x = rng() * MAP_SIZE;
    const y = rng() * MAP_SIZE;
    const type = rng() > 0.25 ? 'tree' : 'rock';
    const r = type === 'tree' ? (1.1 + rng() * 0.8) : (0.8 + rng() * 0.5);
    obstacles.push({ x, y, r, type });
  }
  return obstacles;
}
const OBSTACLES = generateObstacles();

function collidesWithObstacle(x, y) {
  for (const o of OBSTACLES) {
    const dx = x - o.x, dy = y - o.y;
    if (Math.sqrt(dx * dx + dy * dy) < (o.r + PLAYER_RADIUS)) return true;
  }
  return false;
}

function lineIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const a = dx * dx + dy * dy;
  if (a === 0) return false;
  
  const fx = x1 - cx, fy = y1 - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = (fx * fx + fy * fy) - r * r;
  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return false;
  discriminant = Math.sqrt(discriminant);
  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return true;
  if (t2 >= 0 && t2 <= 1) return true;
  return false;
}

function randomSpawnPoint() {
  let x, y, tries = 0;
  do {
    x = 4 + Math.random() * (MAP_SIZE - 8);
    y = 4 + Math.random() * (MAP_SIZE - 8);
    tries++;
  } while (collidesWithObstacle(x, y) && tries < 50);
  return { x, y };
}

const USERS_FILE = path.join(__dirname, 'users.json');
function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } }
function saveUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

const tokens = new Map();
const TOKEN_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokens.entries()) {
    if (now > data.expiresAt) tokens.delete(token);
  }
}, 60 * 60 * 1000);

function makeToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { username, expiresAt: Date.now() + TOKEN_TTL });
  return token;
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 2 || password.length < 3)
    return res.status(400).json({ error: 'نام کاربری یا رمز خیلی کوتاه است.' });
  if (!/^[a-zA-Z0-9_آ-ی۰-۹\- ]{2,20}$/.test(username))
    return res.status(400).json({ error: 'نام کاربری فقط حروف، عدد و فاصله.' });
  
  const users = loadUsers();
  const key = username.trim();
  if (users[key]) return res.status(400).json({ error: 'این نام کاربری گرفته شده است.' });
  
  users[key] = { password: password };
  saveUsers(users);
  res.json({ token: makeToken(key), username: key });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const users = loadUsers();
  const key = (username || '').trim();
  const user = users[key];
  if (!user || user.password !== password) return res.status(400).json({ error: 'نام کاربری یا رمز عبور اشتباهه.' });
  res.json({ token: makeToken(key), username: key });
});

const players = new Map(); 
const activeSockets = new Map();     
const activeUsernames = new Map();   

function getPlayerBySocket(socketId) {
  const un = activeSockets.get(socketId);
  return un ? players.get(un) : null;
}

function freshPlayer(username) {
  const spawn = randomSpawnPoint();
  return {
    username, x: spawn.x, y: spawn.y, facing: 0,
    health: 1000, maxHealth: 1000, weaponIndex: 0,
    mags: WEAPONS.map(w => w.magSize),
    reserves: WEAPONS.map(w => w.totalAmmo),
    reloading: false, lastShotAt: 0,
    kills: 0, deaths: 0, alive: true, lastMoveAt: Date.now()
  };
}

function publicState(p) {
  if (!p) return null;
  let sockId = activeUsernames.get(p.username) || null;
  return {
    id: sockId, username: p.username, x: p.x, y: p.y, facing: p.facing,
    health: p.health, maxHealth: p.maxHealth, alive: p.alive,
    weaponIndex: p.weaponIndex, kills: p.kills, deaths: p.deaths
  };
}

function bearingDegrees(fromX, fromY, toX, toY) {
  const dx = toX - fromX, dy = toY - fromY;
  let deg = Math.atan2(dx, -dy) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}
function compassWordFromDegrees(deg) { return COMPASS_FA[Math.round(deg / 45) % 8]; }
function distanceBetween(ax, ay, bx, by) { return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2); }

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const tokenData = tokens.get(token);
  if (!tokenData || Date.now() > tokenData.expiresAt) {
    if (tokenData) tokens.delete(token); 
    return next(new Error('AUTH_FAILED'));
  }
  socket.username = tokenData.username;
  next();
});

io.on('connection', (socket) => {
  for (const [sId, un] of activeSockets.entries()) {
    if (un === socket.username) {
      const oldSocket = io.sockets.sockets.get(sId);
      if (oldSocket) oldSocket.disconnect(true);
      activeSockets.delete(sId);
    }
  }

  activeSockets.set(socket.id, socket.username);
  activeUsernames.set(socket.username, socket.id); 

  let player = players.get(socket.username);
  if (!player) {
    player = freshPlayer(socket.username);
    players.set(socket.username, player);
  }

  const allPlayersState = Array.from(players.values()).map(publicState).filter(p => p && p.id);

  socket.emit('init', {
    mapSize: MAP_SIZE, obstacles: OBSTACLES, weapons: WEAPONS,
    you: publicState(player), players: allPlayersState
  });

  socket.broadcast.emit('playerJoined', publicState(player));

  socket.on('move', (data) => {
    const p = getPlayerBySocket(socket.id);
    if (!p || !p.alive) return;
    
    const now = Date.now();
    const dt = Math.min(0.5, (now - p.lastMoveAt) / 1000);
    p.lastMoveAt = now;

    let { x, y, facing } = data || {};
    if (typeof facing === 'number') p.facing = ((facing % 8) + 8) % 8;
    
    // بازگردانی سیستم ضد تقلب و اعتبارسنجی سرور
    if (typeof x === 'number' && typeof y === 'number') {
      const maxDelta = MOVE_SPEED * dt * 2.5 + 0.5; 
      if (distanceBetween(p.x, p.y, x, y) <= maxDelta && !collidesWithObstacle(x, y)) {
        p.x = Math.max(0.5, Math.min(MAP_SIZE - 0.5, x));
        p.y = Math.max(0.5, Math.min(MAP_SIZE - 0.5, y));
      }
    }
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y, facing: p.facing });
  });

  socket.on('shoot', () => {
    const p = getPlayerBySocket(socket.id);
    if (!p || !p.alive || p.reloading) return;
    const now = Date.now();
    const weapon = WEAPONS[p.weaponIndex];
    if (now - p.lastShotAt < weapon.fireCooldownMs || p.mags[p.weaponIndex] <= 0) return;
    
    p.lastShotAt = now;
    p.mags[p.weaponIndex] -= 1;
    socket.emit('ammoUpdate', { mag: p.mags[p.weaponIndex], reserve: p.reserves[p.weaponIndex], weaponIndex: p.weaponIndex });
    io.emit('shotFired', { id: socket.id, x: p.x, y: p.y, facing: p.facing, weaponIndex: p.weaponIndex });

    const facingDeg = p.facing * 45;
    let bestTargetUn = null, bestDist = Infinity;

    for (const [un, other] of players.entries()) {
      if (un === p.username || !other.alive) continue;
      let otherSockId = activeUsernames.get(un) || null; 
      if (!otherSockId) continue;

      const dist = distanceBetween(p.x, p.y, other.x, other.y);
      if (dist > weapon.range) continue;

      const bearing = bearingDegrees(p.x, p.y, other.x, other.y);
      let diff = Math.abs(bearing - facingDeg);
      if (diff > 180) diff = 360 - diff;
      
      if (diff <= CONE_HALF_ANGLE && dist < bestDist) {
        let blocked = false;
        for (const obs of OBSTACLES) {
          if (lineIntersectsCircle(p.x, p.y, other.x, other.y, obs.x, obs.y, obs.r)) { blocked = true; break; }
        }
        if (!blocked) { bestDist = dist; bestTargetUn = un; }
      }
    }

    if (bestTargetUn) {
      const victim = players.get(bestTargetUn);
      const damage = Math.floor(Math.random() * (weapon.damageMax - weapon.damageMin + 1)) + weapon.damageMin;
      victim.health = Math.max(0, victim.health - damage);
      
      let victimSocketId = activeUsernames.get(bestTargetUn) || null; 
      if (victimSocketId) {
        const bearingVictimToShooter = bearingDegrees(victim.x, victim.y, p.x, p.y);
        const dirWord = compassWordFromDegrees(bearingVictimToShooter);
        io.to(victimSocketId).emit('hit', { health: victim.health, maxHealth: victim.maxHealth, byUsername: p.username, dirWord });
        io.emit('healthChanged', { id: victimSocketId, health: victim.health });
      }

      if (victim.health <= 0 && victim.alive) {
        victim.alive = false; victim.deaths += 1; 
        p.kills += 1;
        
        p.health += 2000;
        p.maxHealth = Math.max(p.maxHealth, p.health);
        for(let i=0; i<p.reserves.length; i++) p.reserves[i] += 5;
        
        socket.emit('levelUp', { health: p.health });
        socket.emit('ammoUpdate', { mag: p.mags[p.weaponIndex], reserve: p.reserves[p.weaponIndex], weaponIndex: p.weaponIndex });

        if (victimSocketId) io.to(victimSocketId).emit('died', { killedBy: p.username });
        io.emit('playerDied', { 
          id: victimSocketId, killerId: socket.id, 
          killerUsername: p.username, victimUsername: victim.username, killerKills: p.kills 
        });
      }
    }
  });

  socket.on('switchWeapon', (index) => {
    const p = getPlayerBySocket(socket.id);
    if (!p || !p.alive || typeof index !== 'number' || index < 0 || index >= WEAPONS.length) return;
    
    // رفع باگ سوءاستفاده از کلید سلاح: اگر سلاح همانی است که در دست دارد، فقط وضعیت خوانده شود اما ریلود قطع نشود
    if (p.weaponIndex === index) {
      socket.emit('ammoUpdate', { mag: p.mags[index], reserve: p.reserves[index], weaponIndex: index, weaponName: WEAPONS[index].name });
      return;
    }
    
    p.weaponIndex = index; p.reloading = false;
    socket.emit('ammoUpdate', { mag: p.mags[index], reserve: p.reserves[index], weaponIndex: index, weaponName: WEAPONS[index].name });
  });

  socket.on('reload', () => {
    const p = getPlayerBySocket(socket.id);
    if (!p || !p.alive || p.reloading) return;
    const requestedWeaponIndex = p.weaponIndex; 
    const weapon = WEAPONS[requestedWeaponIndex];
    const needed = weapon.magSize - p.mags[requestedWeaponIndex];
    if (needed <= 0 || p.reserves[requestedWeaponIndex] <= 0) return;
    
    p.reloading = true;
    socket.emit('reloadStarted', { ms: weapon.reloadMs });
    setTimeout(() => {
      // چک می‌کنیم آیا کاربر هنوز وصله. اگه کلاً دیسکانکت شده باشه، قفل ریلود رو باز می‌کنیم تا برای اتصال بعدی گیر نکنه
      const currentSocketId = activeUsernames.get(p.username);
      if (!currentSocketId) {
        p.reloading = false;
        return;
      }
      
      // چک کردن p.alive برای جلوگیری از باگ پر شدن اسلحه بعد از مرگ
      if (!p.reloading || !p.alive || p.weaponIndex !== requestedWeaponIndex) return; 
      
      p.reloading = false;
      const transfer = Math.min(weapon.magSize - p.mags[requestedWeaponIndex], p.reserves[requestedWeaponIndex]);
      p.mags[requestedWeaponIndex] += transfer;
      p.reserves[requestedWeaponIndex] -= transfer;
      
      // پیام آپدیت تیرها رو به سوکت فعلی (جدید یا قدیم) ارسال می‌کنیم
      io.to(currentSocketId).emit('reloadDone', { mag: p.mags[requestedWeaponIndex], reserve: p.reserves[requestedWeaponIndex] });
    }, weapon.reloadMs);
  });

  socket.on('respawn', () => {
    const p = getPlayerBySocket(socket.id);
    if (!p || p.alive) return;
    const spawn = randomSpawnPoint();
    p.x = spawn.x; p.y = spawn.y;
    p.health = p.maxHealth; p.alive = true;
    p.mags = WEAPONS.map(w => w.magSize);
    p.reserves = WEAPONS.map(w => w.totalAmmo);
    p.reloading = false;
    io.emit('playerRespawned', publicState(p));
    socket.emit('ammoUpdate', { mag: p.mags[p.weaponIndex], reserve: p.reserves[p.weaponIndex], weaponIndex: p.weaponIndex });
  });

  socket.on('queryHealth', () => { const p = getPlayerBySocket(socket.id); if (p) socket.emit('healthResult', { health: p.health, maxHealth: p.maxHealth, alive: p.alive }); });
  socket.on('queryCoords', () => { const p = getPlayerBySocket(socket.id); if (p) socket.emit('coordsResult', { x: Math.round(p.x), y: Math.round(p.y) }); });
  socket.on('queryFacing', () => { const p = getPlayerBySocket(socket.id); if (p) socket.emit('facingResult', { facingWord: COMPASS_FA[p.facing] }); });
  
  socket.on('queryRadar', () => {
    const p = getPlayerBySocket(socket.id);
    if (!p || !p.alive) { socket.emit('radarResult', { targets: [] }); return; }
    const targets = [];
    for (const [un, other] of players.entries()) {
      if (un === p.username || !other || !other.alive) continue;
      const sId = activeUsernames.get(un);
      if (!sId) continue;
      
      const dist = distanceBetween(p.x, p.y, other.x, other.y);
      const bearing = bearingDegrees(p.x, p.y, other.x, other.y);
      targets.push({ id: sId, username: other.username, distance: Math.round(dist), direction: compassWordFromDegrees(bearing) });
    }
    targets.sort((a, b) => a.distance - b.distance);
    socket.emit('radarResult', { targets });
  });

  socket.on('queryLock', (targetId) => {
    const p = getPlayerBySocket(socket.id);
    if (!p || !p.alive) { socket.emit('lockResult', { found: false }); return; }
    let target = null;
    if (targetId && players.has(targetId)) {
      target = players.get(targetId);
      if (!target || !target.alive) target = null;
    }
    if (!target) {
      let targetDist = Infinity;
      for (const [un, other] of players.entries()) {
        if (un === p.username || !other || !other.alive) continue;
        const sId = activeUsernames.get(un);
        if (!sId) continue;
        const dist = distanceBetween(p.x, p.y, other.x, other.y);
        if (dist < targetDist) { targetDist = dist; target = other; }
      }
    }
    if (!target) { socket.emit('lockResult', { found: false }); return; }
    
    const rad = p.facing * 45 * Math.PI / 180;
    const dx = target.x - p.x; const dy = target.y - p.y;
    const aheadVal = dx * Math.sin(rad) + dy * (-Math.cos(rad));
    const rightVal = dx * Math.cos(rad) + dy * Math.sin(rad);

    const absAhead = Math.round(Math.abs(aheadVal)); const absRight = Math.round(Math.abs(rightVal));
    const aheadText = aheadVal >= 0 ? `${absAhead} رو به رو` : `${absAhead} پشت سر`;
    const rightText = rightVal >= 0 ? `${absRight} راست` : `${absRight} چپ`;

    socket.emit('lockResult', { found: true, username: target.username, health: target.health, kills: target.kills, relativeText: `${aheadText}، ${rightText}` });
  });

  socket.on('queryLeaderboard', () => {
    const list = Array.from(players.values()).map(p => ({ username: p.username, kills: p.kills, deaths: p.deaths, alive: p.alive })).sort((a, b) => b.kills - a.kills);
    socket.emit('leaderboardResult', { list });
  });

  socket.on('disconnect', () => {
    const username = activeSockets.get(socket.id);
    activeSockets.delete(socket.id);
    if (username) {
      if (activeUsernames.get(username) === socket.id) activeUsernames.delete(username);
      players.delete(username);
    }
    io.emit('playerLeft', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`سرور جنگ جنگل روی پورت ${PORT} روشنه`));