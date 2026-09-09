(function () {
  'use strict';

  // ---------- DOM ----------
  const authScreen = document.getElementById('authScreen');
  const gameScreen = document.getElementById('gameScreen');
  const authForm = document.getElementById('authForm');
  const authError = document.getElementById('authError');
  const authToggle = document.getElementById('authToggle');
  const authSubmit = document.getElementById('authSubmit');
  const authTitle = document.getElementById('authTitle');
  
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  const healthBar = document.getElementById('healthBar');
  const healthText = document.getElementById('healthText');
  const weaponNameEl = document.getElementById('weaponName');
  const ammoTextEl = document.getElementById('ammoText');
  const killFeed = document.getElementById('killFeed');
  const deathOverlay = document.getElementById('deathOverlay');
  const deathMessage = document.getElementById('deathMessage');
  const respawnBtn = document.getElementById('respawnBtn');
  const topMessage = document.getElementById('topMessage');
  
  const leaderboardPanel = document.getElementById('leaderboardPanel');
  const leaderboardBody = document.querySelector('#leaderboardTable tbody');
  
  const radarPanel = document.getElementById('radarPanel');
  const radarList = document.getElementById('radarList');
  
  const weaponDrawer = document.getElementById('weaponDrawer');
  const btnAkToggle = document.getElementById('btnAkToggle');
  const btnShoot = document.getElementById('btnShoot');

  const helpToggle = document.getElementById('helpToggle');
  const helpPanel = document.getElementById('helpPanel');
  
  const ariaAssertive = document.getElementById('ariaAssertive');
  const ariaPolite = document.getElementById('ariaPolite');

  let isRegisterMode = false;

  function announce(el, text) {
    el.textContent = '';
    setTimeout(() => { el.textContent = text; }, 40);
  }
  const announceUrgent = (t) => announce(ariaAssertive, t);
  const announceInfo = (t) => announce(ariaPolite, t);

  function showTopMessage(text) {
    topMessage.textContent = text;
    topMessage.classList.add('show');
    setTimeout(() => topMessage.classList.remove('show'), 3500);
  }

  // ---------- Auth ----------
  authToggle.addEventListener('click', () => {
    isRegisterMode = !isRegisterMode;
    authTitle.textContent = isRegisterMode ? 'ساخت حساب جدید' : 'جنگ جنگل';
    authSubmit.textContent = isRegisterMode ? 'ساخت حساب' : 'ورود';
    authToggle.textContent = isRegisterMode ? 'حساب داری؟ وارد شو' : 'حساب نداری؟ اینجا بساز';
    authError.textContent = '';
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) return;
    authSubmit.disabled = true;
    try {
      const res = await fetch(isRegisterMode ? '/api/register' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { authError.textContent = data.error || 'خطایی پیش اومد.'; authSubmit.disabled = false; return; }
      localStorage.setItem('jungle_token', data.token);
      startGame(data.token);
    } catch (err) { authError.textContent = 'خطای اتصال.'; authSubmit.disabled = false; }
  });

  const savedToken = localStorage.getItem('jungle_token');
  if (savedToken) startGame(savedToken);

  // ---------- Game State ----------
  let socket = null;
  let mapSize = 150;
  let obstacles = [];
  let weapons = [];
  let myId = null;
  const players = new Map();
  let me = null;
  let trackedTargetUsername = null; 

  let myMag = 0;
  let myReserve = 0;
  let isReloading = false;
  let isAkAuto = false;
  let isShooting = false;
  let akInterval = null;

  const keys = {};
  const muzzleFlashes = [];
  let hitFlashUntil = 0;

  // ---------- Offscreen Canvas ----------
  const TILE = 16;
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d', { alpha: false });

  function buildBackgroundCache() {
    bgCanvas.width = mapSize * TILE;
    bgCanvas.height = mapSize * TILE;
    const grd = bgCtx.createRadialGradient(bgCanvas.width/2, bgCanvas.height/2, 40, bgCanvas.width/2, bgCanvas.height/2, bgCanvas.width*0.7);
    grd.addColorStop(0, '#2C4324'); grd.addColorStop(1, '#131F14');
    bgCtx.fillStyle = grd; bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
    bgCtx.strokeStyle = '#4B5E3A'; bgCtx.lineWidth = 3; bgCtx.strokeRect(0, 0, bgCanvas.width, bgCanvas.height);

    for (const o of obstacles) {
      const sx = o.x * TILE, sy = o.y * TILE;
      if (o.type === 'tree') {
        bgCtx.fillStyle = 'rgba(60,90,45,0.9)'; bgCtx.beginPath(); bgCtx.arc(sx, sy, o.r * TILE, 0, Math.PI*2); bgCtx.fill();
        bgCtx.fillStyle = '#243318'; bgCtx.beginPath(); bgCtx.arc(sx, sy, (o.r * 0.7) * TILE, 0, Math.PI*2); bgCtx.fill();
      } else {
        bgCtx.fillStyle = '#5A5A50'; bgCtx.beginPath(); bgCtx.ellipse(sx, sy, o.r * TILE, o.r * TILE * 0.8, 0, 0, Math.PI*2); bgCtx.fill();
      }
    }
  }

  // ---------- Socket Logic ----------
  function startGame(token) {
    authScreen.classList.add('hidden'); gameScreen.classList.remove('hidden');
    socket = io({ auth: { token } });

    socket.on('connect_error', (err) => {
      if (err.message === 'AUTH_FAILED') {
        localStorage.removeItem('jungle_token');
        authScreen.classList.remove('hidden'); gameScreen.classList.add('hidden');
      }
    });

    socket.on('init', (data) => {
      mapSize = data.mapSize; obstacles = data.obstacles; weapons = data.weapons; myId = data.you.id;
      players.clear(); data.players.forEach(p => players.set(p.id, p));
      me = players.get(myId); myMag = weapons[0].magSize; myReserve = weapons[0].totalAmmo;
      buildBackgroundCache(); updateHUD(); canvas.focus();
    });

    socket.on('playerJoined', p => { players.set(p.id, p); announceInfo(`${p.username} به جنگ پیوست.`); });
    socket.on('playerLeft', d => { 
      const p = players.get(d.id);
      if (p && p.username === trackedTargetUsername) trackedTargetUsername = null;
      players.delete(d.id);
    });

    socket.on('playerMoved', d => { const p = players.get(d.id); if (p) { p.x = d.x; p.y = d.y; p.facing = d.facing; } });
    socket.on('shotFired', d => { muzzleFlashes.push({ x: d.x, y: d.y, facing: d.facing, t: performance.now() }); playGunshotSound(d.x, d.y, d.id === myId); });
    socket.on('healthChanged', d => { const p = players.get(d.id); if (p) p.health = d.health; if (d.id === myId) updateHUD(); });
    socket.on('hit', d => { if(me) me.health = d.health; hitFlashUntil = performance.now() + 350; updateHUD(); announceUrgent(`${d.byUsername} از سمت ${d.dirWord} به شما شلیک کرد! سلامتی ${d.health}`); });
    
    socket.on('levelUp', d => {
       if (me) me.health = d.health;
       const msg = "ارتقای سلامتی و تعداد مهمات!";
       announceUrgent(msg + " +2000 سلامتی، +5 مهمات اضافه شد.");
       showTopMessage(msg);
       updateHUD();
    });

    socket.on('died', d => {
      if(me) me.alive = false;
      stopShoot(); 
      deathMessage.textContent = `${d.killedBy} شما را کُشت!`; deathOverlay.classList.remove('hidden');
      announceUrgent(`کشته شدی توسط ${d.killedBy}. دکمه Enter را برای زنده شدن بزن.`);
    });

    socket.on('playerDied', d => {
      const victim = players.get(d.id); const killer = players.get(d.killerId);
      if (victim) { victim.alive = false; if (trackedTargetUsername === victim.username) trackedTargetUsername = null; }
      if (killer) killer.kills = d.killerKills;
      const msg = `${d.victimUsername} جنگش را به پایان رساند, او توسط ${d.killerUsername} به دنیای اموات پیوست`;
      addKillFeed(`💀 ${msg}`); if (d.id !== myId && d.killerId !== myId) announceInfo(msg);
    });

    socket.on('playerRespawned', p => {
      const existing = players.get(p.id);
      if (existing) Object.assign(existing, p); else players.set(p.id, p);
      if (p.id === myId) {
        me.alive = true; me.health = p.health; me.x = p.x; me.y = p.y;
        deathOverlay.classList.add('hidden'); updateHUD(); announceInfo('زنده شدی.');
      }
    });

    socket.on('ammoUpdate', d => { 
      myMag = d.mag; myReserve = d.reserve;
      if(me) me.weaponIndex = d.weaponIndex; 
      updateHUD(); 
      if (d.weaponName) {
        let statusText = "آماده شلیک";
        if (myMag === 0 && myReserve > 0) statusText = "خشاب خالی، نیاز به ریلود";
        else if (myMag === 0 && myReserve === 0) statusText = "فاقد مهمات";
        
        const extraAk = (d.weaponIndex === 3) ? (isAkAuto ? " - حالت رگبار" : " - تک‌تیر") : "";
        announceInfo(`${d.weaponName}. ${statusText}${extraAk}.`);
        showTopMessage(`اسلحه شما: ${d.weaponName}`);
      }
    });
    
    socket.on('reloadStarted', () => { isReloading = true; updateHUD(); announceInfo('در حال پر کردن اسلحه...'); });
    socket.on('reloadDone', d => { 
      isReloading = false; myMag = d.mag; myReserve = d.reserve; updateHUD(); 
      announceInfo(`اسلحه پر شد. ${myMag} تیر در خشاب، ${myReserve} در ذخیره.`); 
    });

    socket.on('healthResult', d => announceInfo(`سلامتی: ${d.health} از ${d.maxHealth}`));
    socket.on('coordsResult', d => announceInfo(`${d.x}, ${d.y}`));
    socket.on('facingResult', d => announceInfo(`رو به ${d.facingWord} هستید`));

    socket.on('radarResult', d => {
      radarList.innerHTML = '';
      if (!d.targets.length) { announceInfo('کسی در نقشه زنده نیست.'); return; }
      d.targets.forEach((t) => {
        const btn = document.createElement('button'); btn.className = 'radar-btn';
        btn.innerHTML = `<span>${t.username}</span> <span>${t.distance} متر، ${t.direction} جهانی</span>`;
        btn.onclick = () => {
          trackedTargetUsername = t.username; radarPanel.classList.add('hidden');
          for (let key in keys) keys[key] = false; canvas.focus(); announceInfo(`هدف روی ${t.username} قفل شد. برای رهگیری W را بزنید.`);
        };
        btn.onkeydown = (e) => {
          if(e.key === 'ArrowDown') { e.preventDefault(); if(btn.nextSibling) btn.nextSibling.focus(); }
          if(e.key === 'ArrowUp') { e.preventDefault(); if(btn.previousSibling) btn.previousSibling.focus(); }
        };
        radarList.appendChild(btn);
      });
      radarPanel.classList.remove('hidden'); radarList.firstChild.focus();
      announceInfo('لیست رادار باز شد. با فلش بالا و پایین هدف را انتخاب کرده و اینتر بزنید.');
    });

    socket.on('lockResult', d => {
      if (!d.found) { announceInfo('هدفی پیدا نشد یا زنده نیست.'); trackedTargetUsername = null; return; }
      const colorName = getColorNameForKills(d.kills);
      announceInfo(`${d.username}: ${d.relativeText} - سلامتی: ${d.health} - رنگ: ${colorName}`);
    });

    socket.on('leaderboardResult', d => {
      leaderboardBody.innerHTML = '';
      d.list.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.username}${row.alive ? '' : ' 💀'}</td><td>${row.kills}</td><td>${row.deaths}</td>`;
        leaderboardBody.appendChild(tr);
      });
      const spoken = d.list.map(r => `${r.kills} نفر توسط ${r.username} به بهشت فرستاده شدند.`).join(' ');
      announceInfo(spoken);
    });
  }

  function addKillFeed(text) {
    const div = document.createElement('div'); div.textContent = text; killFeed.appendChild(div);
    setTimeout(() => div.remove(), 4500);
  }

  function updateHUD() {
    if (!me) return;
    const pct = Math.max(0, me.health / (me.maxHealth || 1000) * 100);
    healthBar.style.width = pct + '%'; healthBar.classList.toggle('low', pct < 30);
    healthText.textContent = Math.max(0, me.health);
    const w = weapons[me.weaponIndex] || weapons[0];
    weaponNameEl.textContent = isReloading ? `${w.name} (در حال پر شدن)` : w.name;
    
    let ammoMsg = `${myMag} / ${myReserve}`;
    if (myMag <= 0) {
      if (myReserve <= 0) ammoMsg = "فاقد مهمات - 0 / 0";
      else ammoMsg = `نیاز به ریلود - 0 / ${myReserve}`;
    }
    ammoTextEl.textContent = ammoMsg;
    
    document.querySelectorAll('.drawer-weapon-btn').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.weapon) === me.weaponIndex);
    });

    if (me.weaponIndex === 3) {
      btnAkToggle.classList.remove('hidden');
      btnAkToggle.textContent = isAkAuto ? 'رگبار' : 'تک‌تیر';
      btnAkToggle.style.color = isAkAuto ? '#C1443B' : 'inherit';
    } else {
      btnAkToggle.classList.add('hidden');
    }
  }

  function getColorForKills(kills) {
    if (kills >= 8) return '#006400'; 
    if (kills >= 6) return '#00008B'; 
    if (kills >= 4) return '#ADD8E6'; 
    if (kills >= 2) return '#FFFF00'; 
    return '#E3A857'; 
  }
  function getColorNameForKills(kills) {
    if (kills >= 8) return 'سبز تیره';
    if (kills >= 6) return 'آبی تیره';
    if (kills >= 4) return 'آبی روشن';
    if (kills >= 2) return 'زرد';
    return 'معمولی';
  }

  // ---------- Input ----------
  window.addEventListener('keydown', (e) => {
    if (!me || !authScreen.classList.contains('hidden')) return;

    if (e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault(); if (me.weaponIndex === 3) toggleAkAuto(); return;
    }
    
    if (!radarPanel.classList.contains('hidden') || !leaderboardPanel.classList.contains('hidden') || 
        !weaponDrawer.classList.contains('hidden') || !helpPanel.classList.contains('hidden')) {
      if (e.key === 'Escape' || e.key === 't' || e.key === 'T' || e.key === 'l' || e.key === 'L') { e.preventDefault(); closePanels(); }
      return;
    }

    const k = e.key;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) { e.preventDefault(); keys[k] = true; return; }
    if (e.repeat) return;

    switch (k) {
      case 'q': case 'Q': e.preventDefault(); rotate(-1); break;
      case 'e': case 'E': e.preventDefault(); rotate(1); break;
      case 'Control': e.preventDefault(); startShoot(); break;
      case 'a': case 'A': 
        e.preventDefault(); 
        const ext = me.weaponIndex === 3 ? (isAkAuto ? " (حالت رگبار)" : " (تک تیر)") : "";
        announceInfo(`مهمات: ${myMag} تیر در خشاب، ${myReserve} در ذخیره.${ext}`); 
        break;
      case 'h': case 'H': e.preventDefault(); socket.emit('queryHealth'); break;
      case 'c': case 'C': e.preventDefault(); socket.emit('queryCoords'); break;
      case 'f': case 'F': e.preventDefault(); socket.emit('queryFacing'); break;
      case 't': case 'T': e.preventDefault(); socket.emit('queryRadar'); break; 
      case 'w': case 'W': e.preventDefault(); socket.emit('queryLock', trackedTargetUsername); break; 
      case 'r': case 'R': e.preventDefault(); socket.emit('reload'); break;
      case '1': e.preventDefault(); switchWeaponLocal(0); break;
      case '2': e.preventDefault(); switchWeaponLocal(1); break;
      case '3': e.preventDefault(); switchWeaponLocal(2); break;
      case '4': e.preventDefault(); switchWeaponLocal(3); break;
      case '5': e.preventDefault(); switchWeaponLocal(4); break;
      case 'l': case 'L': e.preventDefault(); leaderboardPanel.classList.remove('hidden'); leaderboardPanel.querySelector('h2').focus(); socket.emit('queryLeaderboard'); break;
      case '?': e.preventDefault(); helpPanel.classList.remove('hidden'); helpPanel.querySelector('h2').focus(); break;
      case 'Enter': e.preventDefault(); if (!me.alive) socket.emit('respawn'); break;
    }
  });
  
  window.addEventListener('keyup', (e) => {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) keys[e.key] = false;
    if (e.key === 'Control') { stopShoot(); }
  });

  function closePanels() {
    radarPanel.classList.add('hidden'); leaderboardPanel.classList.add('hidden');
    helpPanel.classList.add('hidden'); weaponDrawer.classList.add('hidden');
    for (let key in keys) keys[key] = false; canvas.focus();
  }
  
  document.getElementById('closeRadar').addEventListener('click', closePanels);
  document.getElementById('closeLeaderboard').addEventListener('click', closePanels);
  document.getElementById('closeHelp').addEventListener('click', closePanels);
  document.getElementById('closeWeaponDrawer').addEventListener('click', closePanels);
  helpToggle.addEventListener('click', () => { helpPanel.classList.remove('hidden'); helpPanel.querySelector('h2').focus(); });
  respawnBtn.addEventListener('click', () => { if (me && !me.alive) socket.emit('respawn'); });

  function rotate(dir) { if(me && me.alive) { me.facing = ((me.facing + dir) % 8 + 8) % 8; sendMove(); } }
  
  function switchWeaponLocal(i) {
    if (!me || !me.alive) return;
    stopShoot(); 
    socket.emit('switchWeapon', i);
    closePanels();
  }

  function toggleAkAuto() {
    isAkAuto = !isAkAuto; updateHUD(); announceInfo(isAkAuto ? "حالت رگبار" : "تک تیر");
  }

  function tryShoot() {
    if (!me || !me.alive || isReloading) {
       if (isShooting) stopShoot();
       return;
    }
    if (myMag <= 0) {
      if (myReserve <= 0) { announceInfo("مهمات این اصلحه را ندارید"); showTopMessage("مهمات این اصلحه را ندارید"); }
      else { announceInfo("اسلحه خالی است"); showTopMessage("اسلحه خالی است"); }
      stopShoot(); 
      return;
    }
    socket.emit('shoot');
  }

  function startShoot(e) {
    if(e) e.preventDefault();
    if (!radarPanel.classList.contains('hidden') || !leaderboardPanel.classList.contains('hidden') || 
        !weaponDrawer.classList.contains('hidden') || !helpPanel.classList.contains('hidden')) {
        return; 
    }
    if(!isShooting) {
      isShooting = true;
      tryShoot();
      if (me && me.alive && me.weaponIndex === 3 && isAkAuto) {
        akInterval = setInterval(tryShoot, 150);
      }
    }
  }

  function stopShoot(e) {
    if(e) e.preventDefault();
    isShooting = false;
    clearInterval(akInterval);
  }
  
  const moveKeyMap = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  document.querySelectorAll('.dpad-btn').forEach(btn => {
    const dir = moveKeyMap[btn.dataset.move];
    const start = (e) => { e.preventDefault(); keys[dir] = true; }; const end = (e) => { e.preventDefault(); keys[dir] = false; };
    btn.addEventListener('touchstart', start, { passive: false }); btn.addEventListener('touchend', end);
    btn.addEventListener('touchcancel', end); btn.addEventListener('mousedown', start); 
    btn.addEventListener('mouseup', end); btn.addEventListener('mouseleave', end);
  });
  
  document.getElementById('rotateLeft').addEventListener('click', () => rotate(-1));
  document.getElementById('rotateRight').addEventListener('click', () => rotate(1));
  document.getElementById('btnHealth').addEventListener('click', () => { if(me && me.alive) socket.emit('queryHealth'); });
  document.getElementById('btnCoords').addEventListener('click', () => { if(me && me.alive) socket.emit('queryCoords'); });
  document.getElementById('btnFacing').addEventListener('click', () => { if(me && me.alive) socket.emit('queryFacing'); });
  document.getElementById('btnLeaderboard').addEventListener('click', () => {
    leaderboardPanel.classList.remove('hidden'); leaderboardPanel.querySelector('h2').focus();
    if(me && me.alive) socket.emit('queryLeaderboard');
  });

  document.getElementById('btnReload').addEventListener('click', () => { if(me && me.alive) socket.emit('reload'); });
  document.getElementById('btnOpenWeaponDrawer').addEventListener('click', () => {
    if(me && me.alive) { weaponDrawer.classList.remove('hidden'); weaponDrawer.querySelector('h2').focus(); }
  });
  
  // دسترسی‌پذیری عالی کیبورد برای منوی کشویی اسلحه
  const drawerBtns = document.querySelectorAll('.drawer-weapon-btn');
  drawerBtns.forEach((btn, index) => {
    btn.addEventListener('click', () => switchWeaponLocal(Number(btn.dataset.weapon)));
    btn.addEventListener('keydown', (e) => {
      if(e.key === 'ArrowDown') { e.preventDefault(); if(drawerBtns[index+1]) drawerBtns[index+1].focus(); }
      if(e.key === 'ArrowUp') { e.preventDefault(); if(drawerBtns[index-1]) drawerBtns[index-1].focus(); }
    });
  });
  
  btnAkToggle.addEventListener('click', () => { if (me && me.alive && me.weaponIndex === 3) toggleAkAuto(); });
  btnShoot.addEventListener('mousedown', startShoot); btnShoot.addEventListener('mouseup', stopShoot);
  btnShoot.addEventListener('mouseleave', stopShoot); btnShoot.addEventListener('touchstart', startShoot, {passive: false});
  btnShoot.addEventListener('touchend', stopShoot);
  document.getElementById('btnRadar').addEventListener('click', () => { if(me && me.alive) socket.emit('queryRadar'); });
  document.getElementById('btnLock').addEventListener('click', () => { if(me && me.alive) socket.emit('queryLock', trackedTargetUsername); });

  // ---------- Game Loop ----------
  let lastMoveStepAt = 0;

  function collides(x, y) {
    for (const o of obstacles) { const dx = x - o.x, dy = y - o.y; if (Math.sqrt(dx * dx + dy * dy) < o.r + 0.6) return true; }
    return false;
  }

  function gameLoop(now) {
    if (me && me.alive) {
      let dx = 0, dy = 0;
      if (keys.ArrowUp) dy -= 1; if (keys.ArrowDown) dy += 1;
      if (keys.ArrowLeft) dx -= 1; if (keys.ArrowRight) dx += 1;
      
      if (dx !== 0 || dy !== 0) {
        // قدم اول فورا برداشته می‌شود تا تاخیر حس نشود، قدم‌های بعدی با نگه داشتن کلید هر 150 میلی‌ثانیه رخ می‌دهند
        if (now - lastMoveStepAt >= 150) {
          const len = Math.sqrt(dx * dx + dy * dy);
          const stepSize = 1.35; 
          const nx = Math.max(0.5, Math.min(mapSize - 0.5, me.x + (dx / len) * stepSize));
          const ny = Math.max(0.5, Math.min(mapSize - 0.5, me.y + (dy / len) * stepSize));
          let actuallyMoved = false;

          if (!collides(nx, me.y)) { if (me.x !== nx) actuallyMoved = true; me.x = nx; }
          if (!collides(me.x, ny)) { if (me.y !== ny) actuallyMoved = true; me.y = ny; }

          if (actuallyMoved) { playFootstepSound(); sendMove(); } else playBumpSound();
          lastMoveStepAt = now;
        }
      } else {
        lastMoveStepAt = 0; // ریست تایمر تا اولین دکمه بعدی فوری عمل کند
      }
    }
    render(); requestAnimationFrame(gameLoop);
  }

  function sendMove() { if (socket && me) socket.emit('move', { x: me.x, y: me.y, facing: me.facing }); }

  // ---------- Rendering ----------
  let logicalWidth = window.innerWidth; let logicalHeight = window.innerHeight;
  function resizeCanvas() { 
    const dpr = window.devicePixelRatio || 1;
    logicalWidth = window.innerWidth; logicalHeight = window.innerHeight;
    canvas.width = logicalWidth * dpr; canvas.height = logicalHeight * dpr;
    canvas.style.width = logicalWidth + 'px'; canvas.style.height = logicalHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); 
  }
  window.addEventListener('resize', resizeCanvas); resizeCanvas();

  const FACING_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

  function render() {
    ctx.fillStyle = '#14140F'; ctx.fillRect(0, 0, logicalWidth, logicalHeight);
    if (!me) return;

    const camOffsetX = me.x * TILE - logicalWidth / 2; const camOffsetY = me.y * TILE - logicalHeight / 2;
    ctx.drawImage(bgCanvas, -camOffsetX, -camOffsetY);

    const camX = me.x, camY = me.y;
    function worldToScreen(wx, wy) { return { sx: logicalWidth / 2 + (wx - camX) * TILE, sy: logicalHeight / 2 + (wy - camY) * TILE }; }

    const nowT = performance.now();
    for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
      const f = muzzleFlashes[i]; const age = nowT - f.t;
      if (age > 160) { muzzleFlashes.splice(i, 1); continue; }
      const { sx, sy } = worldToScreen(f.x, f.y); const angleRad = FACING_ANGLES[f.facing] * Math.PI / 180;
      ctx.fillStyle = `rgba(227,168,87,${1 - age/160})`;
      ctx.beginPath(); ctx.arc(sx + Math.sin(angleRad)*22, sy - Math.cos(angleRad)*22, 9, 0, Math.PI*2); ctx.fill();
    }

    for (const [id, p] of players.entries()) {
      if (!p.alive) continue;
      const { sx, sy } = worldToScreen(p.x, p.y);
      const isMe = id === myId; const isTracked = (p.username === trackedTargetUsername); 
      const drawColor = getColorForKills(p.kills);

      const angleRad = FACING_ANGLES[p.facing] * Math.PI / 180;
      ctx.strokeStyle = isMe ? drawColor : (isTracked ? '#9b4dff' : drawColor); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.sin(angleRad)*20, sy - Math.cos(angleRad)*20); ctx.stroke();

      ctx.fillStyle = isMe ? drawColor : (isTracked ? '#B388EB' : drawColor);
      ctx.beginPath(); ctx.arc(sx, sy, 10, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#1B1405'; ctx.lineWidth = 2; ctx.stroke();

      ctx.fillStyle = '#F1EAD9'; ctx.font = '13px Vazirmatn, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(p.username, sx, sy - 18);

      if (!isMe) {
        const pct = Math.max(0, p.health / (p.maxHealth || 1000));
        ctx.fillStyle = '#2A2A20'; ctx.fillRect(sx - 16, sy - 32, 32, 4);
        ctx.fillStyle = pct < 0.3 ? '#C1443B' : '#6B8F4E'; ctx.fillRect(sx - 16, sy - 32, 32 * pct, 4);
        if(isTracked) { ctx.strokeStyle = '#B388EB'; ctx.beginPath(); ctx.arc(sx, sy, 18, 0, Math.PI*2); ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]); }
      }
    }
    if (nowT < hitFlashUntil) { const alpha = (hitFlashUntil - nowT) / 350 * 0.4; ctx.fillStyle = `rgba(193,68,59,${alpha})`; ctx.fillRect(0, 0, logicalWidth, logicalHeight); }
  }

  requestAnimationFrame(gameLoop);

  // ---------- Audio Synth ----------
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume(); return audioCtx;
  }
  window.addEventListener('keydown', () => getAudioCtx(), { once: true }); window.addEventListener('pointerdown', () => getAudioCtx(), { once: true });

  function playFootstepSound() {
    const ac = getAudioCtx(); const bufferSize = ac.sampleRate * 0.08; const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0); for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const noise = ac.createBufferSource(); noise.buffer = buffer; const filter = ac.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 350;
    const gain = ac.createGain(); gain.gain.value = 0.35; noise.connect(filter).connect(gain).connect(ac.destination); noise.start();
  }
  function playBumpSound() {
    const ac = getAudioCtx(); const now = ac.currentTime; const osc = ac.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now); osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);
    const gain = ac.createGain(); gain.gain.setValueAtTime(0.8, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc.connect(gain).connect(ac.destination); osc.start(now); osc.stop(now + 0.2);
  }
  function playGunshotSound(shooterX, shooterY, isSelf) {
    const ac = getAudioCtx(); const now = ac.currentTime; let pan = 0, distanceFactor = 1;
    if (!isSelf && me) { const dx = shooterX - me.x, dy = shooterY - me.y; const dist = Math.sqrt(dx*dx + dy*dy); pan = Math.max(-1, Math.min(1, dx / 20)); distanceFactor = Math.max(0.15, 1 - dist / 70); }
    const osc = ac.createOscillator(); osc.type = 'square'; osc.frequency.setValueAtTime(180, now); osc.frequency.exponentialRampToValueAtTime(60, now + 0.12);
    const gain = ac.createGain(); gain.gain.setValueAtTime(0.5 * distanceFactor, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    const panner = ac.createStereoPanner ? ac.createStereoPanner() : null;
    if (panner) { panner.pan.value = pan; osc.connect(gain).connect(panner).connect(ac.destination); } else { osc.connect(gain).connect(ac.destination); }
    osc.start(now); osc.stop(now + 0.2);
  }
})();