/* =============================================================================
 * Man vs Man — battle engine  (v2)
 * -----------------------------------------------------------------------------
 * v2 changes
 *   • Bigger and faster: fighters scale with the arena (165 px desktop), all
 *     movement and projectile speeds raised ~30 %, projectiles drawn larger.
 *   • Projectiles only rotate when it makes sense (knives). The middle finger
 *     emoji stays upright.
 *   • Two new fighters:
 *       - Business Guy throws a briefcase (5 dmg). When it hits a wall it
 *         bursts into 10 sheets of paper that fly outward, 2.5 dmg each.
 *       - Chef Guy throws knives (20 dmg, 2 in flight). Knives fly until they
 *         hit a wall and stay stuck there. The chef cannot throw again until he
 *         walks to a stuck knife and picks it up.
 *
 * v1 fixes (see ISSUES.md) all still apply: no TDZ crash, frame-rate
 * independent fixed-step simulation, uid-based fighter identity, symmetric
 * start, 60 s time limit, full round lifecycle, resize/visibility handling.
 * ========================================================================== */

(() => {
  'use strict';

  /* --------------------------------------------------------------------- *
   *  Tunables
   * --------------------------------------------------------------------- */

  const CONFIG = {
    simStepMs: 1000 / 120,      // fixed simulation step
    maxFrameDeltaMs: 250,       // clamp huge deltas after tab switches
    maxSubSteps: 8,             // never spend more than ~66 ms of sim per frame
    maxProjectiles: 260,        // hard cap on live projectiles
    maxQueuedShots: 48,
    roundTimeLimitMs: 60000,    // sudden death: higher health percent wins
    aimLead: 0.85,              // 0 = aim at current position, 1 = full lead
    aimVelocityError: 2.0,      // shooter misjudges target speed by +/- this
    hitboxInset: 0.2,           // fraction of the sprite ignored at the edges
    muzzleFactor: 0.46,         // spawn shots outside the sprite, not inside it
    hitFlashMs: 110,
    damageNumberMs: 680,
    staggerMs: 400,             // delay before either fighter's first shot
    staggerJitterMs: 220,       // random extra so neither slot gets a head start
    speedJitter: 0.22,          // +/- variation on start velocity, per match
    paperCount: 10,             // sheets per briefcase impact
    paperSpawnNudge: 10,        // push burst papers this far off the wall
    paperGapMs: 26,             // stagger between papers in one burst
    homingTurnDegPerSec: 620,   // how sharply a parried projectile curves back
    pickupPadMs: 300,           // grace period before a stuck knife is grabbable
    pickupPadPx: 10,            // knife pickup reach beyond the sprite box
    arenaSpeedScale: 1.6        // global "faster" multiplier on every velocity
  };

  const CHARACTERS = {
    angry: {
      id: 'angry',
      name: 'Angry Guy',
      asset: 'assets/angryguy.png',
      blurb: 'Heavy hits',
      maxHp: 100,
      fireIntervalMs: 1460,
      burst: { shots: 1, gapMs: 0, spreadRad: 0.15 },
      damage: 9,
      speed: 4.4,               // px per 1/60 s frame at scale 1 (converted below)
      radius: 22,
      lifespanMs: 2600,
      projectile: 'middle-finger',
      startVx: -58,
      startVy: -50
    },
    sleepy: {
      id: 'sleepy',
      name: 'Sleepy Guy',
      asset: 'assets/sleepyguy.png',
      blurb: 'Fast triple shots',
      maxHp: 100,
      fireIntervalMs: 1470,
      burst: { shots: 3, gapMs: 150, spreadRad: 0.34 },
      damage: 2.6,
      speed: 5.6,
      radius: 15,
      lifespanMs: 2200,
      projectile: 'z',
      startVx: 62,
      startVy: 48
    },
    business: {
      id: 'business',
      name: 'Business Guy',
      asset: 'assets/businessguy.png',
      blurb: 'Briefcase burst',
      maxHp: 100,
      fireIntervalMs: 1680,
      burst: { shots: 1, gapMs: 0, spreadRad: 0.1 },
      damage: 5,                // briefcase impact
      speed: 4.8,
      aimErrorScale: 2.6,       // lobbed case: misses often and bursts on walls
      pierce: true,             // passes straight through fighters
      radius: 30,
      lifespanMs: 3000,         // lives until it hits a wall or a fighter
      projectile: 'briefcase',
      startVx: -54,
      startVy: -46
    },
    chef: {
      id: 'chef',
      name: 'Chef Guy',
      asset: 'assets/chefguy.png',
      blurb: '2 knives, must retrieve',
      maxHp: 100,
      fireIntervalMs: 1380,     // also gated by having a knife in hand
      burst: { shots: 1, gapMs: 0, spreadRad: 0.06 },
      damage: 20,               // per knife
      speed: 7.6,               // quicker flight = quicker retrieve cycle
      aimErrorScale: 2.4,       // thrown knives are harder to land than bullets
      radius: 20,
      lifespanMs: 0,            // 0 = never expires, flies until it hits a wall
      projectile: 'knife',
      blades: 2,                // knives owned: thrown knives block reloading
      startVx: -64,
      startVy: -56
    },
    knight: {
      id: 'knight',
      name: 'Knight Guy',
      asset: 'assets/knightguy.png',
      blurb: 'Shield + sword',
      maxHp: 72,                // relies on the shield, not on raw durability
      fireIntervalMs: 620,      // a swing every 0.62 s — he has to be in range
      melee: true,              // no projectile: he has to be in sword range
      meleeRangePx: 185,        // measured centre to centre
      burst: { shots: 0, gapMs: 0, spreadRad: 0 },
      damage: 5,                // sword, per hit
      speed: 4.8,
      radius: 0,
      lifespanMs: 0,
      projectile: 'sword',
      aimErrorScale: 1,
      startVx: -61,
      startVy: -54,
      guard: {
        rangePx: 185,           // closer than this counts as melee
        deflectRatio: 0.25,     // melee: 25% of the damage goes back to the attacker
        cooldownMs: 1900        // and he cannot parry again for this long
      }
    }
  };

  const DEBRIS_ASSETS = {
    paper: 'assets/debris/paper.png',
    sword: 'assets/debris/sword.png',
    briefcase: 'assets/debris/briefcase.png',
    knife: 'assets/debris/knife.png'
  };

  const PROJECTILE_LOOK = {
    'middle-finger': { kind: 'emoji', text: '\u{1F595}', size: 56, spin: false },
    z: { kind: 'emoji', text: 'z', size: 36, spin: false },
    briefcase: { kind: 'image', asset: DEBRIS_ASSETS.briefcase, width: 68, height: 50, spin: false },
    knife: { kind: 'image', asset: DEBRIS_ASSETS.knife, width: 84, height: 26, spin: true },
    paper: { kind: 'image', asset: DEBRIS_ASSETS.paper, width: 40, height: 51, spin: true },
    sword: { kind: 'image', asset: DEBRIS_ASSETS.sword, width: 92, height: 25, spin: true }
  };

  const PAPER = { damage: 2.5, speed: 5.4, radius: 9, lifespanMs: 2100 };

  /* --------------------------------------------------------------------- *
   *  Inline sprite fallbacks (used only when a PNG cannot load)
   * --------------------------------------------------------------------- */

  const svgUri = (markup) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);

  const SPRITE_FALLBACK = {
    angry: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
        '<rect x="44" y="92" width="15" height="26" rx="7" fill="#a61e1e"/>' +
        '<rect x="69" y="92" width="15" height="26" rx="7" fill="#a61e1e"/>' +
        '<path d="M32 76c0-15 13-25 32-25s32 10 32 25v16c0 6-4 10-10 10H42c-6 0-10-4-10-10z" fill="#e03131" stroke="#8a1c1c" stroke-width="4"/>' +
        '<path d="M30 70l-8 34M98 70l8 34" stroke="#8a1c1c" stroke-width="13" stroke-linecap="round"/>' +
        '<circle cx="22" cy="62" r="13" fill="#ffa8a8" stroke="#8a1c1c" stroke-width="4"/>' +
        '<circle cx="106" cy="62" r="13" fill="#ffa8a8" stroke="#8a1c1c" stroke-width="4"/>' +
        '<circle cx="64" cy="44" r="34" fill="#ffa8a8" stroke="#8a1c1c" stroke-width="4"/>' +
        '<path d="M31 36c5-16 20-26 33-26s28 10 32 24c-9-7-19-10-33-10s-23 4-32 12z" fill="#c92a2a"/>' +
        '<path d="M42 38l15 7M86 38l-15 7" stroke="#5c1414" stroke-width="7" stroke-linecap="round"/>' +
        '<circle cx="50" cy="55" r="6" fill="#241111"/><circle cx="78" cy="55" r="6" fill="#241111"/>' +
        '<path d="M48 68c7-5 25-5 32 0-3 9-11 13-16 13s-13-4-16-13z" fill="#7a1010"/>' +
      '</svg>'
    ),
    sleepy: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
        '<text x="88" y="40" font-family="Arial" font-size="26" font-weight="bold" fill="#1864ab">z</text>' +
        '<rect x="44" y="94" width="15" height="24" rx="7" fill="#1864ab"/>' +
        '<rect x="69" y="94" width="15" height="24" rx="7" fill="#1864ab"/>' +
        '<path d="M34 80c0-14 13-23 30-23s30 9 30 23v12c0 6-5 10-11 10H45c-6 0-11-4-11-10z" fill="#4dabf7" stroke="#1864ab" stroke-width="4"/>' +
        '<circle cx="64" cy="50" r="34" fill="#a5d8ff" stroke="#1864ab" stroke-width="4"/>' +
        '<path d="M30 42c4-20 19-30 34-30s30 10 34 28c-11-7-21-10-34-10s-23 4-34 12z" fill="#1c7ed6"/>' +
        '<path d="M40 52c5 5 11 5 16 0M72 52c5 5 11 5 16 0" stroke="#1864ab" stroke-width="5" fill="none" stroke-linecap="round"/>' +
        '<ellipse cx="64" cy="72" rx="9" ry="8" fill="#0b3d75"/>' +
      '</svg>'
    ),
    business: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
        '<rect x="44" y="94" width="15" height="24" rx="7" fill="#1e2b43"/>' +
        '<rect x="69" y="94" width="15" height="24" rx="7" fill="#1e2b43"/>' +
        '<path d="M34 78c0-14 13-23 30-23s30 9 30 23v14c0 6-5 10-11 10H45c-6 0-11-4-11-10z" fill="#2f4160" stroke="#1e2b43" stroke-width="4"/>' +
        '<path d="M64 58l-11 50h22z" fill="#f7f9fc"/><path d="M64 60l5 40h-10z" fill="#d64545"/>' +
        '<circle cx="64" cy="44" r="32" fill="#ffcf9e" stroke="#d9a271" stroke-width="4"/>' +
        '<path d="M32 40c3-19 17-28 32-28s29 9 32 27c-10-7-20-9-32-9s-22 3-32 10z" fill="#3f2d1c"/>' +
        '<circle cx="52" cy="52" r="6" fill="#241111"/><circle cx="78" cy="52" r="6" fill="#241111"/>' +
        '<path d="M50 72c8 6 20 6 28 0" stroke="#8a4a3a" stroke-width="5" fill="none" stroke-linecap="round"/>' +
        '<rect x="26" y="96" width="40" height="26" rx="6" fill="#a4682f" stroke="#6f4620" stroke-width="4"/>' +
      '</svg>'
    ),
    chef: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
        '<rect x="44" y="94" width="15" height="24" rx="7" fill="#3d4a5c"/>' +
        '<rect x="69" y="94" width="15" height="24" rx="7" fill="#3d4a5c"/>' +
        '<path d="M34 78c0-14 13-23 30-23s30 9 30 23v14c0 6-5 10-11 10H45c-6 0-11-4-11-10z" fill="#fbfdff" stroke="#dfe6ee" stroke-width="4"/>' +
        '<path d="M54 56h20v50H54z" fill="#ffffff" stroke="#c9d3de" stroke-width="3"/>' +
        '<path d="M56 56c0-6 16-6 16 0z" fill="#d64545"/>' +
        '<path d="M40 82c-5 6-8 14-8 20M88 82c5 6 8 14 8 20" stroke="#dfe6ee" stroke-width="9" fill="none" stroke-linecap="round"/>' +
        '<circle cx="64" cy="46" r="30" fill="#f6c89a" stroke="#cf9d6d" stroke-width="4"/>' +
        '<ellipse cx="64" cy="14" rx="30" ry="16" fill="#fbfdff" stroke="#dfe6ee" stroke-width="4"/>' +
        '<rect x="34" y="16" width="60" height="14" rx="7" fill="#dfe6ee"/>' +
        '<circle cx="52" cy="50" r="6" fill="#241111"/><circle cx="78" cy="50" r="6" fill="#241111"/>' +
        '<rect x="52" y="62" width="24" height="7" rx="4" fill="#4a3219"/>' +
      '</svg>'
    )
  };

  SPRITE_FALLBACK.knight = svgUri(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
      '<rect x="44" y="94" width="15" height="24" rx="7" fill="#78848f"/>' +
      '<rect x="69" y="94" width="15" height="24" rx="7" fill="#78848f"/>' +
      '<path d="M34 76c0-14 13-23 30-23s30 9 30 23v14c0 6-5 10-11 10H45c-6 0-11-4-11-10z" fill="#b9c4d1" stroke="#78848f" stroke-width="4"/>' +
      '<path d="M54 58l-16 48h20z" fill="#eef2f6"/>' +
      '<circle cx="64" cy="44" r="30" fill="#c9d3de" stroke="#8b98a8" stroke-width="4"/>' +
      '<rect x="42" y="36" width="44" height="20" rx="6" fill="#5a6674"/>' +
      '<path d="M60 22l6-14 8 14z" fill="#b0303a"/>' +
      '<path d="M20 62l14-10 14 10v16l-14 12-14-12z" fill="#2f4160" stroke="#e8b53c" stroke-width="3"/>' +
      '<path d="M104 30l6 4v34l-6 4-6-4V34z" fill="#eef2f6" stroke="#c9d3de" stroke-width="2"/>' +
      '<rect x="92" y="66" width="24" height="6" rx="3" fill="#e8b53c"/>' +
    '</svg>'
  );

  const DEBRIS_FALLBACK = {
    briefcase: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 66">' +
        '<rect x="4" y="20" width="82" height="42" rx="7" fill="#a4682f" stroke="#6f4620" stroke-width="4"/>' +
        '<rect x="4" y="20" width="82" height="12" rx="6" fill="#c98d4c"/>' +
        '<path d="M30 20a15 12 0 0 1 30 0" fill="none" stroke="#6f4620" stroke-width="6"/>' +
        '<rect x="33" y="38" width="8" height="10" rx="3" fill="#e8b53c"/>' +
        '<rect x="49" y="38" width="8" height="10" rx="3" fill="#e8b53c"/>' +
      '</svg>'
    ),
    knife: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 26">' +
        '<rect x="2" y="4" width="30" height="18" rx="8" fill="#2b2b33"/>' +
        '<circle cx="12" cy="13" r="2.6" fill="#c9ccd4"/><circle cx="21" cy="13" r="2.6" fill="#c9ccd4"/>' +
        '<path d="M32 3l50 10-50 10z" fill="#dfe4ea"/>' +
        '<path d="M34 6l44 7-44 4z" fill="#ffffff"/>' +
      '</svg>'
    ),
    sword: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 92 25">' +
        '<path d="M30 3l60 10-60 10z" fill="#dfe4ea"/>' +
        '<path d="M36 7l50 6-50 4z" fill="#ffffff"/>' +
        '<rect x="18" y="3" width="14" height="19" rx="4" fill="#e8b53c"/>' +
        '<rect x="2" y="7" width="18" height="11" rx="5" fill="#5c3a19"/>' +
      '</svg>'
    ),
    paper: svgUri(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 51">' +
        '<rect x="1" y="1" width="38" height="49" rx="2" fill="#ffffff" stroke="#d3d9e0" stroke-width="2"/>' +
        '<rect x="6" y="8" width="18" height="3.5" rx="1.75" fill="#9aa4b0"/>' +
        '<rect x="6" y="17" width="28" height="3" rx="1.5" fill="#c6ccd4"/>' +
        '<rect x="6" y="25" width="28" height="3" rx="1.5" fill="#c6ccd4"/>' +
        '<rect x="6" y="33" width="20" height="3" rx="1.5" fill="#c6ccd4"/>' +
        '<rect x="6" y="41" width="26" height="3" rx="1.5" fill="#c6ccd4"/>' +
      '</svg>'
    )
  };

  /* --------------------------------------------------------------------- *
   *  Small helpers
   * --------------------------------------------------------------------- */

  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

  const rectsOverlap = (a, b) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  const circleHitsRect = (cx, cy, radius, rect) => {
    const nx = clamp(cx, rect.left, rect.right);
    const ny = clamp(cy, rect.top, rect.bottom);
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy <= radius * radius;
  };

  /* --------------------------------------------------------------------- *
   *  DOM references
   * --------------------------------------------------------------------- */

  const dom = {
    menuScreen: $('menuScreen'),
    battleScreen: $('battleScreen'),
    startBattleBtn: $('startBattleBtn'),
    rematchBtn: $('rematchBtn'),
    menuBtn: $('menuBtn'),
    box: $('playArea'),
    singlePanel: $('singlePlayerPanel'),
    twoPanel: $('twoPlayerPanel'),
    teamSection: $('teamSection'),
    modeHint: $('modeHint'),
    status: $('status'),
    fighterEls: [$('fighterLeft'), $('fighterRight')],
    hud: [
      { name: $('leftName'), fill: $('leftHealthFill'), hp: $('leftHpText'), score: $('leftScore'), badge: $('leftBadge') },
      { name: $('rightName'), fill: $('rightHealthFill'), hp: $('rightHpText'), score: $('rightScore'), badge: $('rightBadge') }
    ],
    timer: $('roundTimer')
  };

  /* --------------------------------------------------------------------- *
   *  Persistent state
   * --------------------------------------------------------------------- */

  const state = {
    mode: 'one',                                   // 'one' | 'two'
    team: 'red',                                   // 'red' | 'blue' (1P only)
    pick: { single: 'angry', red: 'angry', blue: 'sleepy' },
    scores: { red: 0, blue: 0 },
    battle: null,
    rafId: 0,
    lastTs: 0,
    acc: 0,
    paused: false,
    enemyOrder: ['sleepy', 'business', 'chef']     // 1P rival is picked from here
  };

  /* --------------------------------------------------------------------- *
   *  Menu wiring
   * --------------------------------------------------------------------- */

  function setPressed(buttons, activeMatcher) {
    buttons.forEach((btn) => {
      const active = activeMatcher(btn);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function syncMenuUi() {
    setPressed(Array.from(document.querySelectorAll('.mode-btn')), (btn) => btn.dataset.mode === state.mode);
    setPressed(Array.from(document.querySelectorAll('.team-btn')), (btn) => btn.dataset.team === state.team);

    document.querySelectorAll('.character-card').forEach((card) => {
      const owner = card.dataset.player;
      const selected = owner === 'single' ? state.pick.single : state.pick[owner];
      const isActive = card.dataset.character === selected;
      card.classList.toggle('selected', isActive);
      card.setAttribute('aria-pressed', String(isActive));
    });

    const twoPlayer = state.mode === 'two';
    dom.singlePanel.classList.toggle('hidden', twoPlayer);
    dom.twoPanel.classList.toggle('hidden', !twoPlayer);
    // The team picker only means something in 1-player mode.
    dom.teamSection.classList.toggle('hidden', twoPlayer);
    dom.modeHint.textContent = twoPlayer
      ? 'Pick.'
      : 'PICK';
  }

  document.querySelectorAll('.mode-btn').forEach((button) => {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;
      syncMenuUi();
    });
  });

  document.querySelectorAll('.team-btn').forEach((button) => {
    button.addEventListener('click', () => {
      state.team = button.dataset.team;
      syncMenuUi();
    });
  });

  document.querySelectorAll('.character-card').forEach((button) => {
    button.addEventListener('click', () => {
      const owner = button.dataset.player;
      if (owner === 'single' || owner === 'red' || owner === 'blue') {
        state.pick[owner] = button.dataset.character;
        syncMenuUi();
      }
    });
  });

  /* --------------------------------------------------------------------- *
   *  Fighter / battle construction
   * --------------------------------------------------------------------- */

  /**
   * Measure the arena. While the battle screen is `display: none` the box
   * reports 0x0, so fall back to a sane default and let handleResize() re-place
   * everyone the moment the real size is known. Without this, fighters spawn
   * stacked in the top-left corner.
   */
  function arenaSize() {
    const width = dom.box.clientWidth;
    const height = dom.box.clientHeight;
    if (width > 0 && height > 0) return { width, height, measured: true };
    const fallback = Math.max(320, Math.round(readFighterSize() * 3.9));
    return { width: fallback, height: fallback, measured: false };
  }

  function readFighterSize() {
    const probe = dom.fighterEls[0];
    if (probe) {
      const computed = parseFloat(window.getComputedStyle(probe).width);
      if (Number.isFinite(computed) && computed > 0) return computed;
    }
    return 130;
  }

  function makeFighter(defId, side, slot) {
    const def = CHARACTERS[defId] || CHARACTERS.angry;
    const size = readFighterSize();

    return {
      def,
      id: def.id,                 // character id (sprite / stats)
      // Unique per fighter: two fighters may share a character id (mirror
      // matchups), so identity lookups must never use id alone.
      uid: def.id + '#' + slot,
      side,                       // 'red' | 'blue'
      slot,                       // 0 = left, 1 = right
      el: dom.fighterEls[slot],
      size,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      hp: def.maxHp,
      fireCooldownMs: CONFIG.staggerMs,
      parryReadyAt: 0,
      facing: 0,
      stats: { shots: 0, hits: 0, damage: 0, recovered: 0, papers: 0, parries: 0, deflected: 0, byType: {} }
    };
  }

  function applySprite(fighter) {
    const img = fighter.el.querySelector('img');
    if (!img) return;
    const fallback = SPRITE_FALLBACK[fighter.def.id];
    img.onerror = () => {
      img.onerror = null;
      if (fallback) img.src = fallback;
    };
    img.alt = fighter.def.name;
    img.src = fighter.def.asset;
  }

  function createBattle(leftId, rightId) {
    const fighters = [makeFighter(leftId, 'red', 0), makeFighter(rightId, 'blue', 1)];
    const arena = arenaSize();

    const battle = {
      fighters,
      projectiles: [],
      queue: [],                  // scheduled burst shots, drained on sim time
      floaters: [],               // floating damage / pickup text
      elapsedMs: 0,
      remainingMs: CONFIG.roundTimeLimitMs,
      width: arena.width,
      height: arena.height,
      measured: arena.measured,   // false until the real arena size is known
      running: false,
      over: false,
      winner: null
    };

    fighters.forEach((fighter) => {
      fighter.el.className = 'fighter';
      applySprite(fighter);
      placeFighterAtStart(fighter, battle);
      renderFighter(fighter);
    });

    updateHudNames(battle);
    fighters.forEach((fighter) => renderHealth(battle, fighter));
    renderScores();
    renderBadges(battle);
    clearOverlay();
    return battle;
  }

  function placeFighterAtStart(fighter, battle) {
    const size = fighter.size;
    const offset = Math.min(size * 1.1, Math.max(size * 0.6, battle.width * 0.2));
    const centerX = (battle.width - size) / 2;
    const centerY = (battle.height - size) / 2;
    const jitter = () => 1 + (Math.random() * 2 - 1) * CONFIG.speedJitter;

    fighter.x = clamp(fighter.slot === 0 ? centerX - offset : centerX + offset, 0, Math.max(0, battle.width - size));
    fighter.y = clamp(centerY, 0, Math.max(0, battle.height - size));
    fighter.vx = fighter.def.startVx * CONFIG.arenaSpeedScale * (fighter.slot === 0 ? 1 : -1) * jitter();
    fighter.vy = fighter.def.startVy * CONFIG.arenaSpeedScale * (fighter.slot === 0 ? 1 : -1) * jitter();
    fighter.hp = fighter.def.maxHp;
    fighter.parryReadyAt = 0;
    fighter.stats = { shots: 0, hits: 0, damage: 0, recovered: 0, papers: 0, parries: 0, deflected: 0, byType: {} };
    // Symmetrical first shot: jitter, never a positional advantage.
    fighter.fireCooldownMs = CONFIG.staggerMs + Math.random() * CONFIG.staggerJitterMs;
    fighter.el.classList.toggle('red-team', fighter.side === 'red');
    fighter.el.classList.toggle('blue-team', fighter.side === 'blue');
  }

  /* --------------------------------------------------------------------- *
   *  Rendering
   * --------------------------------------------------------------------- */

  function renderFighter(fighter) {
    fighter.el.style.transform = 'translate(' + fighter.x.toFixed(2) + 'px,' + fighter.y.toFixed(2) + 'px)';
  }

  function setFacing(fighter, other) {
    const facingLeft = other.x + other.size / 2 < fighter.x + fighter.size / 2;
    const value = facingLeft ? -1 : 1;
    if (fighter.facing !== value) {
      fighter.facing = value;
      fighter.el.style.setProperty('--facing', String(value));
      fighter.el.dataset.facing = facingLeft ? 'left' : 'right';
    }
  }

  function renderHealth(battle, fighter) {
    const slot = dom.hud[fighter.slot];
    if (!slot) return;
    const percent = clamp((fighter.hp / fighter.def.maxHp) * 100, 0, 100);

    slot.fill.style.width = percent + '%';
    slot.hp.textContent = Math.max(0, Math.ceil(fighter.hp)) + ' HP';
    slot.fill.style.background =
      percent > 60
        ? 'linear-gradient(90deg, #48d42d, #7df34d)'
        : percent > 30
        ? 'linear-gradient(90deg, #f6b400, #ffd166)'
        : 'linear-gradient(90deg, #ef4444, #ff7a7a)';
  }

  function flashHealth(fighter) {
    const slot = dom.hud[fighter.slot];
    if (!slot) return;
    slot.fill.classList.remove('hurt');
    void slot.fill.offsetWidth; // restart the animation on back-to-back hits
    slot.fill.classList.add('hurt');
  }

  function updateHudNames(battle) {
    battle.fighters.forEach((fighter) => {
      const slot = dom.hud[fighter.slot];
      if (!slot) return;
      slot.name.textContent = fighter.def.name;
      slot.name.title = fighter.side + ' team — ' + fighter.def.name;
    });
    dom.box.setAttribute(
      'aria-label',
      'Arena: ' + battle.fighters[0].def.name + ' versus ' + battle.fighters[1].def.name
    );
  }

  function renderScores() {
    dom.hud[0].score.textContent = 'Wins: ' + state.scores.red;
    dom.hud[1].score.textContent = 'Wins: ' + state.scores.blue;
  }

  /** Chef's knife count is gameplay-critical, so it is shown in the HUD. */
  function renderBadges(battle) {
    battle.fighters.forEach((fighter) => {
      const slot = dom.hud[fighter.slot];
      if (!slot || !slot.badge) return;
      let text = '';
      let warn = false;

      if (fighter.def.blades) {
        const thrown = countDeployedKnives(battle, fighter);
        const inHand = Math.max(0, fighter.def.blades - thrown);
        text = 'Knives ' + inHand + '/' + fighter.def.blades;
        warn = inHand === 0;
      } else if (fighter.def.guard) {
        const ready = fighter.parryReadyAt <= battle.elapsedMs;
        text = ready ? 'Shield ready' : 'Shield recharging';
        warn = !ready;
      }

      if (!text) {
        slot.badge.classList.add('hidden');
        slot.badge.textContent = '';
        slot.badge.dataset.state = '';
        return;
      }
      if (slot.badge.dataset.state === text) return; // avoid pointless DOM writes
      slot.badge.dataset.state = text;
      slot.badge.classList.remove('hidden');
      slot.badge.textContent = text;
      slot.badge.classList.toggle('badge-empty', warn);
    });
  }

  function renderTimer(battle) {
    dom.timer.textContent = (Math.max(0, battle.remainingMs) / 1000).toFixed(1) + 's';
  }

  /* --------------------------------------------------------------------- *
   *  Geometry (arena coordinates)
   * --------------------------------------------------------------------- */

  function arenaRectOf(el) {
    const rect = el.getBoundingClientRect();
    const boxRect = dom.box.getBoundingClientRect();
    const left = rect.left - boxRect.left - dom.box.clientLeft;
    const top = rect.top - boxRect.top - dom.box.clientTop;
    return {
      left,
      top,
      right: left + rect.width,
      bottom: top + rect.height,
      width: rect.width,
      height: rect.height
    };
  }

  /** Falls back to simulation coordinates when the browser cannot lay out yet. */
  function visualRectOf(fighter) {
    const rect = arenaRectOf(fighter.el);
    if (rect.width && rect.height) return rect;
    return {
      left: fighter.x,
      top: fighter.y,
      right: fighter.x + fighter.size,
      bottom: fighter.y + fighter.size,
      width: fighter.size,
      height: fighter.size
    };
  }

  function hitRectOf(fighter) {
    const rect = visualRectOf(fighter);
    const insetX = Math.min(rect.width * CONFIG.hitboxInset, rect.width * 0.45);
    const insetY = Math.min(rect.height * CONFIG.hitboxInset, rect.height * 0.45);
    return {
      left: rect.left + insetX,
      top: rect.top + insetY,
      right: rect.right - insetX,
      bottom: rect.bottom - insetY,
      width: rect.width - insetX * 2,
      height: rect.height - insetY * 2
    };
  }

  function centerOf(fighter) {
    const rect = visualRectOf(fighter);
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  }

  function clampToArena(fighter, battle) {
    fighter.x = clamp(fighter.x, 0, Math.max(0, battle.width - fighter.size));
    fighter.y = clamp(fighter.y, 0, Math.max(0, battle.height - fighter.size));
  }

  /* --------------------------------------------------------------------- *
   *  Projectiles
   * --------------------------------------------------------------------- */

  function spawnProjectile(battle, shooter, target, type, options = {}) {
    if (battle.projectiles.length >= CONFIG.maxProjectiles) return null;

    const def = CHARACTERS[shooter.id] || CHARACTERS[shooter.def.id];
    const speedPxPerSec = (options.speed !== undefined ? options.speed : def.speed) * 60 * CONFIG.arenaSpeedScale;
    const angle =
      options.angle !== undefined ? options.angle : aimAngle(shooter, target, def.speed).angle;

    const origin = options.origin || centerOf(shooter);
    const muzzleDistance = options.muzzle !== undefined ? options.muzzle : shooter.size * CONFIG.muzzleFactor;
    const x = clamp(origin.x + Math.cos(angle) * muzzleDistance, 0, battle.width);
    const y = clamp(origin.y + Math.sin(angle) * muzzleDistance, 0, battle.height);

    const look = PROJECTILE_LOOK[type];
    const el = document.createElement('div');
    el.className = 'projectile type-' + type + (look.spin ? ' spinning' : '');
    el.setAttribute('aria-hidden', 'true');

    if (look.kind === 'emoji') {
      el.classList.add(type === 'middle-finger' ? 'middle-finger' : 'z-bullet');
      el.textContent = look.text;
      el.style.fontSize = look.size + 'px';
    } else {
      const img = document.createElement('img');
      img.src = look.asset;
      img.alt = '';
      img.style.width = look.width + 'px';
      img.style.height = look.height + 'px';
      img.onerror = () => {
        img.onerror = null;
        img.src = DEBRIS_FALLBACK[type] || '';
      };
      el.appendChild(img);
    }

    dom.box.appendChild(el);

    const projectile = {
      el,
      type,
      x,
      y,
      vx: Math.cos(angle) * speedPxPerSec,
      vy: Math.sin(angle) * speedPxPerSec,
      angle,
      radius: options.radius !== undefined ? options.radius : def.radius,
      damage: options.damage !== undefined ? options.damage : def.damage,
      shooterId: shooter.uid,
      targetId: target ? target.uid : null,
      ownerUid: shooter.uid,
      spin: look.spin,
      spinDeg: (angle * 180) / Math.PI,
      spinSpeed: look.spin ? 300 : 0,
      lifeMs: 0,
      lifespanMs: options.lifespanMs !== undefined ? options.lifespanMs : def.lifespanMs,
      wallBehaviour: options.wallBehaviour || null, // 'burst' | 'stick'
      halfW: (look.kind === 'image' ? look.width : look.size) / 2,
      halfH: (look.kind === 'image' ? look.height : look.size) / 2,
      state: 'flying',
      stuckAtMs: 0,
      dead: false
    };

    renderProjectile(projectile);
    battle.projectiles.push(projectile);
    if (type !== 'paper') shooter.stats.shots += 1;
    return projectile;
  }

  function renderProjectile(projectile) {
    let transform = 'translate(-50%,-50%) translate(' + projectile.x.toFixed(2) + 'px,' + projectile.y.toFixed(2) + 'px)';
    // Only spinning debris is rotated — emoji throws stay upright.
    if (projectile.spin) transform += ' rotate(' + projectile.spinDeg.toFixed(1) + 'deg)';
    projectile.el.style.transform = transform;
    projectile.el.style.left = '0px';
    projectile.el.style.top = '0px';
  }

  function aimAngle(fighter, target, speed) {
    const from = centerOf(fighter);
    if (!target) return { angle: 0, origin: from };
    const to = centerOf(target);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy) || 1;

    // Everything is in pixels per SECOND, so the lead time is in seconds too.
    const travelSeconds = Math.min(1, distance / Math.max(1, speed * 60 * CONFIG.arenaSpeedScale));
    const lead = travelSeconds * CONFIG.aimLead;

    // The shooter only *estimates* how the target is moving; the error grows
    // with flight time, which is what turns a prediction into a real fight.
    const error = CONFIG.aimVelocityError * (fighter.def.aimErrorScale || 1);
    const estimatedVx = target.vx * (1 + (Math.random() * 2 - 1) * error);
    const estimatedVy = target.vy * (1 + (Math.random() * 2 - 1) * error);

    return { angle: Math.atan2(dy + estimatedVy * lead, dx + estimatedVx * lead), origin: from };
  }

  function scheduleShots(battle, fighter, target) {
    const burst = fighter.def.burst;
    for (let i = 0; i < burst.shots; i++) {
      if (battle.queue.length >= CONFIG.maxQueuedShots) return;
      battle.queue.push({
        at: battle.elapsedMs + i * burst.gapMs,
        shooterId: fighter.uid,
        targetId: target.uid,
        spreadRad: burst.spreadRad
      });
    }
  }

  function drainShotQueue(battle) {
    for (let i = battle.queue.length - 1; i >= 0; i--) {
      if (battle.queue[i].at > battle.elapsedMs) continue;
      const shot = battle.queue.splice(i, 1)[0];
      if (!battle.running) continue;

      const shooter = battle.fighters.find((f) => f.uid === shot.shooterId);
      const target = battle.fighters.find((f) => f.uid === shot.targetId);
      if (!shooter || shooter.hp <= 0) continue;

      const def = shooter.def;
      if (def.blades && countDeployedKnives(battle, shooter) >= def.blades) continue;

      const look = PROJECTILE_LOOK[def.projectile];
      const angle = aimAngle(shooter, target, def.speed).angle + (Math.random() - 0.5) * shot.spreadRad;
      const wallBehaviour = def.projectile === 'briefcase' ? 'burst' : def.projectile === 'knife' ? 'stick' : null;

      spawnProjectile(battle, shooter, target, def.projectile, {
        angle,
        wallBehaviour,
        speed: def.speed,
        // Knives are thrown by hand, so they leave the sprite further out.
        muzzle: def.projectile === 'knife' ? shooter.size * 0.52 : undefined
      });

      if (look && def.blades) renderBadges(battle);
    }
  }

  /** One sword swing. Only connects if the knight has actually closed the gap. */
  function fireMelee(battle, fighter, target) {
    const def = fighter.def;
    const from = centerOf(fighter);
    const to = centerOf(target);
    const gap = Math.hypot(to.x - from.x, to.y - from.y);
    if (gap > def.meleeRangePx) return false;

    fighter.stats.shots += 1;
    spawnSlash(battle, from, to, fighter);

    // Routed through resolveHit so an opposing knight's guard applies here too.
    resolveHit(battle, target, {
      type: 'sword',
      damage: def.damage,
      ownerUid: fighter.uid,
      targetId: target.uid,
      parryCount: 0
    });
    return true;
  }

  /** Quick visual sweep from the knight to his target. */
  function spawnSlash(battle, from, to, fighter) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const reach = fighter.size * 0.55;
    const el = document.createElement('div');
    el.className = 'slash';
    const img = document.createElement('img');
    img.src = DEBRIS_ASSETS.sword;
    img.alt = '';
    img.onerror = () => {
      img.onerror = null;
      img.src = DEBRIS_FALLBACK.sword;
    };
    el.appendChild(img);
    el.style.left = (from.x + Math.cos(angle) * reach) + 'px';
    el.style.top = (from.y + Math.sin(angle) * reach) + 'px';
    el.style.transform = 'translate(-50%,-50%) rotate(' + ((angle * 180) / Math.PI).toFixed(1) + 'deg)';
    dom.box.appendChild(el);
    battle.floaters.push({ el, expiresAt: battle.elapsedMs + 240 });
  }

  function countDeployedKnives(battle, fighter) {
    let count = 0;
    for (let i = 0; i < battle.projectiles.length; i++) {
      const p = battle.projectiles[i];
      if (p.type === 'knife' && p.ownerUid === fighter.uid && !p.dead) count += 1;
    }
    return count;
  }

  /** Business Guy's briefcase breaks open into a ring of flying paperwork. */
  function burstPapers(battle, briefcase) {
    const count = CONFIG.paperCount;
    const owner = battle.fighters.find((f) => f.uid === briefcase.ownerUid);

    for (let i = 0; i < count; i++) {
      if (battle.projectiles.length >= CONFIG.maxProjectiles) break;

      const spread = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      let dirX = Math.cos(spread);
      let dirY = Math.sin(spread);

      // Nudge the burst off the wall and turn any outward-facing sheet around,
      // so nothing immediately leaves the arena.
      let x = briefcase.x;
      let y = briefcase.y;
      if (x <= CONFIG.paperSpawnNudge) {
        x = CONFIG.paperSpawnNudge;
        if (dirX < 0) dirX = -dirX;
      } else if (x >= battle.width - CONFIG.paperSpawnNudge) {
        x = battle.width - CONFIG.paperSpawnNudge;
        if (dirX > 0) dirX = -dirX;
      }
      if (y <= CONFIG.paperSpawnNudge) {
        y = CONFIG.paperSpawnNudge;
        if (dirY < 0) dirY = -dirY;
      } else if (y >= battle.height - CONFIG.paperSpawnNudge) {
        y = battle.height - CONFIG.paperSpawnNudge;
        if (dirY > 0) dirY = -dirY;
      }

      const angle = Math.atan2(dirY, dirX);
      const speedPxPerSec = PAPER.speed * 60 * CONFIG.arenaSpeedScale;
      const el = document.createElement('div');
      el.className = 'projectile type-paper spinning';
      el.setAttribute('aria-hidden', 'true');

      const img = document.createElement('img');
      img.src = DEBRIS_ASSETS.paper;
      img.alt = '';
      img.style.width = PROJECTILE_LOOK.paper.width + 'px';
      img.style.height = PROJECTILE_LOOK.paper.height + 'px';
      img.onerror = () => {
        img.onerror = null;
        img.src = DEBRIS_FALLBACK.paper;
      };
      el.appendChild(img);
      dom.box.appendChild(el);

      const projectile = {
        el,
        type: 'paper',
        x,
        y,
        vx: Math.cos(angle) * speedPxPerSec,
        vy: Math.sin(angle) * speedPxPerSec,
        angle,
        radius: PAPER.radius,
        damage: PAPER.damage,
        shooterId: briefcase.ownerUid,
        targetId: briefcase.targetId,
        ownerUid: briefcase.ownerUid,
        spin: true,
        spinDeg: (angle * 180) / Math.PI,
        spinSpeed: (Math.random() < 0.5 ? -1 : 1) * (220 + Math.random() * 260),
        lifeMs: -i * CONFIG.paperGapMs,
        lifespanMs: PAPER.lifespanMs,
        wallBehaviour: 'bounce',
        halfW: PROJECTILE_LOOK.paper.width / 2,
        halfH: PROJECTILE_LOOK.paper.height / 2,
        state: 'flying',
        stuckAtMs: 0,
        dead: false
      };

      renderProjectile(projectile);
      battle.projectiles.push(projectile);
    }

    spawnFloater(battle, briefcase.x, briefcase.y, 'PAPERWORK!', 'paperwork');
    if (owner) owner.stats.papers += count;
  }

  function stickToWall(battle, projectile) {
    const halfW = projectile.halfW * 0.5;
    const halfH = projectile.halfH * 0.5;

    // Push the sprite half into the wall so it reads as embedded.
    if (projectile.x <= halfW) projectile.x = halfW;
    else if (projectile.x >= battle.width - halfW) projectile.x = battle.width - halfW;
    if (projectile.y <= halfH) projectile.y = halfH;
    else if (projectile.y >= battle.height - halfH) projectile.y = battle.height - halfH;

    projectile.x = clamp(projectile.x, 0, battle.width);
    projectile.y = clamp(projectile.y, 0, battle.height);
    projectile.vx = 0;
    projectile.vy = 0;
    projectile.state = 'stuck';
    projectile.stuckAtMs = battle.elapsedMs;
    projectile.el.classList.add('stuck');
    renderProjectile(projectile);
  }

  /** Loose paperwork ricochets instead of dying on the first wall it meets. */
  function bounceOffWall(battle, projectile, sides) {
    const halfW = projectile.halfW * 0.6;
    const halfH = projectile.halfH * 0.6;

    if (sides.offLeft) {
      projectile.x = halfW;
      projectile.vx = Math.abs(projectile.vx);
    } else if (sides.offRight) {
      projectile.x = battle.width - halfW;
      projectile.vx = -Math.abs(projectile.vx);
    }

    if (sides.offTop) {
      projectile.y = halfH;
      projectile.vy = Math.abs(projectile.vy);
    } else if (sides.offBottom) {
      projectile.y = battle.height - halfH;
      projectile.vy = -Math.abs(projectile.vy);
    }

    projectile.angle = Math.atan2(projectile.vy, projectile.vx);
    projectile.spinSpeed = (Math.random() < 0.5 ? -1 : 1) * (200 + Math.random() * 260);
    projectile.x = clamp(projectile.x, 0, battle.width);
    projectile.y = clamp(projectile.y, 0, battle.height);
  }

  /** Chef Guy must walk to a stuck knife to reload. */
  function updateKnifePickups(battle) {
    battle.fighters.forEach((fighter) => {
      if (!fighter.def.blades || fighter.hp <= 0) return;
      const reach = visualRectOf(fighter);
      const grab = {
        left: reach.left - CONFIG.pickupPadPx,
        top: reach.top - CONFIG.pickupPadPx,
        right: reach.right + CONFIG.pickupPadPx,
        bottom: reach.bottom + CONFIG.pickupPadPx
      };

      battle.projectiles.forEach((projectile) => {
        if (projectile.dead) return;
        if (projectile.type !== 'knife' || projectile.state !== 'stuck') return;
        if (projectile.ownerUid !== fighter.uid) return;
        if (battle.elapsedMs - projectile.stuckAtMs < CONFIG.pickupPadMs) return;

        const reachRadius = Math.max(projectile.halfW, projectile.halfH) * 0.75;
        if (!circleHitsRect(projectile.x, projectile.y, reachRadius, grab)) return;

        projectile.dead = true;
        projectile.el.classList.add('collected');
        const el = projectile.el;
        window.setTimeout(() => el.remove(), 260);
        fighter.stats.recovered += 1;
        spawnFloater(battle, projectile.x, projectile.y, 'knife back', 'pickup');
        renderBadges(battle);
      });
    });
  }

  function updateProjectiles(battle, dtSec) {
    const list = battle.projectiles;
    // Rebuild the list each step: bursts may spawn new projectiles mid-loop.
    battle.projectiles = [];
    let lastIndex = -1;

    for (let i = 0; i < list.length; i++) {
      const projectile = list[i];
      if (projectile.dead) {
        continue;
      }

      if (projectile.state !== 'stuck') {
        // Parried shots curve after their new victim.
        if (projectile.homing) {
          const mark = projectile.targetId
            ? battle.fighters.find((f) => f.uid === projectile.targetId && f.hp > 0)
            : null;
          if (mark) {
            const speed = Math.hypot(projectile.vx, projectile.vy) || 1;
            const current = Math.atan2(projectile.vy, projectile.vx);
            const mx = centerOf(mark).x;
            const my = centerOf(mark).y;
            const desired = Math.atan2(my - projectile.y, mx - projectile.x);
            let turn = desired - current;
            turn = Math.atan2(Math.sin(turn), Math.cos(turn));
            const maxTurn = (CONFIG.homingTurnDegPerSec * Math.PI) / 180 * dtSec;
            const angle = current + clamp(turn, -maxTurn, maxTurn);
            projectile.vx = Math.cos(angle) * speed;
            projectile.vy = Math.sin(angle) * speed;
            projectile.angle = angle;
            projectile.spinDeg = (angle * 180) / Math.PI;
          }
        }

        projectile.x += projectile.vx * dtSec;
        projectile.y += projectile.vy * dtSec;
        projectile.lifeMs += dtSec * 1000;
        if (projectile.spin) projectile.spinDeg += projectile.spinSpeed * dtSec;
      }

      const target = projectile.targetId
        ? battle.fighters.find((f) => f.uid === projectile.targetId)
        : null;

      let remove = false;

      // 1. Did it hit the fighters? (stuck knives are scenery, not threats)
      if (projectile.state !== 'stuck') {
        for (let f = 0; f < battle.fighters.length; f++) {
          const candidate = battle.fighters[f];
          if (candidate.hp <= 0) continue;
          if (candidate.uid === projectile.ownerUid) continue;
          if (!circleHitsRect(projectile.x, projectile.y, projectile.radius, hitRectOf(candidate))) continue;

          // A piercing projectile (the briefcase) damages each fighter it
          // passes through once, then keeps flying until it hits a wall.
          if (projectile.pierce) {
            if (projectile.hitUids && projectile.hitUids.indexOf(candidate.uid) !== -1) continue;
            if (!projectile.hitUids) projectile.hitUids = [];
            projectile.hitUids.push(candidate.uid);
            resolveHit(battle, candidate, projectile);
            continue;
          }

          remove = resolveHit(battle, candidate, projectile);
          break;
        }
      }

      // 2. Walls
      if (!remove && projectile.state !== 'stuck') {
        const halfW = projectile.halfW * 0.6;
        const halfH = projectile.halfH * 0.6;
        const offLeft = projectile.x - halfW <= 0;
        const offRight = projectile.x + halfW >= battle.width;
        const offTop = projectile.y - halfH <= 0;
        const offBottom = projectile.y + halfH >= battle.height;

        if (offLeft || offRight || offTop || offBottom) {
          if (projectile.wallBehaviour === 'stick') {
            stickToWall(battle, projectile);
          } else if (projectile.wallBehaviour === 'burst') {
            burstPapers(battle, projectile);
            remove = true;
          } else if (projectile.wallBehaviour === 'bounce') {
            bounceOffWall(battle, projectile, { offLeft, offRight, offTop, offBottom });
          } else {
            remove = true;
          }
        }
      }

      // 3. Timeout / cleanup
      if (!remove && projectile.state !== 'stuck') {
        if (projectile.lifespanMs > 0 && projectile.lifeMs >= projectile.lifespanMs) remove = true;
        else if (projectile.lifeMs > 0) {
          const slack = Math.max(projectile.halfW, projectile.halfH) + 40;
          if (
            projectile.x < -slack ||
            projectile.y < -slack ||
            projectile.x > battle.width + slack ||
            projectile.y > battle.height + slack
          ) {
            remove = true;
          }
        }
      }

      if (remove) {
        if (projectile.state === 'stuck') stickToWall(battle, projectile);
        projectile.el.remove();
        projectile.dead = true;
        continue;
      }

      if (projectile.state !== 'stuck') renderProjectile(projectile);
      battle.projectiles.push(projectile);
      lastIndex = i;

      // A round can end from a hit inside this loop.
      if (battle.over) break;
    }

    // A hit inside this loop can end the round, which stops the loop early.
    // Everything still sitting in `list` past the current index would never be
    // reached again, so flush it explicitly — otherwise those nodes leak.
    if (battle.over) {
      for (let k = lastIndex + 1; k < list.length; k++) fizzleProjectile(list[k]);
      battle.projectiles.forEach(fizzleProjectile);
      battle.projectiles = [];
    }
  }

  /* --------------------------------------------------------------------- *
   *  Damage / feedback
   * --------------------------------------------------------------------- */

  function spawnFloater(battle, x, y, text, variant) {
    const el = document.createElement('div');
    el.className = 'damage-number' + (variant ? ' variant-' + variant : '');
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    dom.box.appendChild(el);
    battle.floaters.push({ el, expiresAt: battle.elapsedMs + CONFIG.damageNumberMs });

    const remove = () => el.remove();
    el.addEventListener('animationend', remove, { once: true });
    window.setTimeout(remove, CONFIG.damageNumberMs + 160);
  }

  function damageFighter(battle, fighter, amount, source, damageType) {
    if (battle.over || fighter.hp <= 0) return;

    fighter.hp = Math.max(0, fighter.hp - amount);
    renderHealth(battle, fighter);
    flashHealth(fighter);

    const center = centerOf(fighter);
    spawnFloater(battle, center.x, center.y, '-' + (Math.round(amount * 10) / 10));

    fighter.el.classList.add('hit');
    window.setTimeout(() => fighter.el.classList.remove('hit'), CONFIG.hitFlashMs);
    fighter.el.classList.add('zapped');
    window.setTimeout(() => fighter.el.classList.remove('zapped'), 280);

    if (source) {
      source.stats.hits += 1;
      source.stats.damage += amount;
      if (damageType) {
        source.stats.byType = source.stats.byType || {};
        source.stats.byType[damageType] = (source.stats.byType[damageType] || 0) + amount;
      }
    }

    if (fighter.hp <= 0) endRound(battle, source ? source.side : null, 'ko');
  }

  /* --------------------------------------------------------------------- *
   *  Simulation
   * --------------------------------------------------------------------- */

  function updateFighterMotion(battle, dtSec) {
    const [a, b] = battle.fighters;

    battle.fighters.forEach((fighter) => {
      if (fighter.hp <= 0) return;
      fighter.x += fighter.vx * dtSec;
      fighter.y += fighter.vy * dtSec;

      const maxX = battle.width - fighter.size;
      const maxY = battle.height - fighter.size;

      if (fighter.x <= 0) {
        fighter.x = 0;
        fighter.vx = Math.abs(fighter.vx);
      } else if (fighter.x >= maxX) {
        fighter.x = maxX;
        fighter.vx = -Math.abs(fighter.vx);
      }

      if (fighter.y <= 0) {
        fighter.y = 0;
        fighter.vy = Math.abs(fighter.vy);
      } else if (fighter.y >= maxY) {
        fighter.y = maxY;
        fighter.vy = -Math.abs(fighter.vy);
      }
    });

    resolveFighterCollision(a, b);

    battle.fighters.forEach((fighter) => {
      setFacing(fighter, fighter === a ? b : a);
      renderFighter(fighter);
    });
  }

  function resolveFighterCollision(a, b) {
    if (a.hp <= 0 || b.hp <= 0) return;

    const rectA = hitRectOf(a);
    const rectB = hitRectOf(b);
    if (!rectsOverlap(rectA, rectB)) return;

    const ac = centerOf(a);
    const bc = centerOf(b);
    let nx = bc.x - ac.x;
    let ny = bc.y - ac.y;
    const dist = Math.hypot(nx, ny) || 1;
    nx /= dist;
    ny /= dist;

    const overlapX = Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left);
    const overlapY = Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top);
    const push = Math.min(overlapX, overlapY) / 2 + 0.5;

    a.x -= nx * push;
    a.y -= ny * push;
    b.x += nx * push;
    b.y += ny * push;

    // Only trade velocities when they are actually closing, otherwise the pair
    // jitters forever while overlapping.
    const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (closing < 0) {
      const tvx = a.vx;
      const tvy = a.vy;
      a.vx = b.vx;
      a.vy = b.vy;
      b.vx = tvx;
      b.vy = tvy;
    }
  }

  function updateFiring(battle, stepMs) {
    battle.fighters.forEach((fighter) => {
      if (fighter.hp <= 0) return;
      fighter.fireCooldownMs -= stepMs;
      if (fighter.fireCooldownMs > 0) return;

      const target = battle.fighters.find((f) => f !== fighter && f.hp > 0);
      if (!target) {
        fighter.fireCooldownMs = stepMs;
        return;
      }

      // A knife-less chef cannot attack: he has to go and collect it first.
      if (fighter.def.blades && countDeployedKnives(battle, fighter) >= fighter.def.blades) {
        fighter.fireCooldownMs = 120; // retry soon; nothing is thrown
        return;
      }

      // Melee fighters (the knight) have nothing to schedule — they check the
      // distance every frame and swing the moment they are in range.
      if (fighter.def.melee) {
        const landed = fireMelee(battle, fighter, target);
        fighter.fireCooldownMs = landed ? fighter.def.fireIntervalMs : 60;
        return;
      }

      fighter.fireCooldownMs = Math.max(stepMs, fighter.fireCooldownMs + fighter.def.fireIntervalMs);
      scheduleShots(battle, fighter, target);
    });
  }

  function updateFloaters(battle) {
    for (let i = battle.floaters.length - 1; i >= 0; i--) {
      if (battle.elapsedMs >= battle.floaters[i].expiresAt) {
        battle.floaters[i].el.remove();
        battle.floaters.splice(i, 1);
      }
    }
  }

  function step(stepMs) {
    const battle = state.battle;
    if (!battle || !battle.running) return;

    battle.elapsedMs += stepMs;
    battle.remainingMs = Math.max(0, CONFIG.roundTimeLimitMs - battle.elapsedMs);
    const dtSec = stepMs / 1000;

    updateFighterMotion(battle, dtSec);
    drainShotQueue(battle);
    updateFiring(battle, stepMs);
    updateProjectiles(battle, dtSec);
    updateKnifePickups(battle);
    updateFloaters(battle);
    renderBadges(battle);
    renderTimer(battle);

    if (battle.running && battle.remainingMs <= 0) {
      const [left, right] = battle.fighters;
      const leftRatio = left.hp / left.def.maxHp;
      const rightRatio = right.hp / right.def.maxHp;
      if (leftRatio === rightRatio) endRound(battle, null, 'draw');
      else endRound(battle, leftRatio > rightRatio ? left.side : right.side, 'time');
    }
  }

  function makeFrame(battle) {
    return function frame(timestamp) {
      // Bail out if this loop belongs to a battle that is no longer current —
      // otherwise a double-click on "Start Match" leaves a second loop running.
      if (!battle.running || state.battle !== battle) return;

      state.rafId = window.requestAnimationFrame(makeFrame(battle));

      if (state.paused) {
        state.lastTs = 0;
        state.acc = 0;
        return;
      }

      if (!state.lastTs) state.lastTs = timestamp;
      let delta = timestamp - state.lastTs;
      state.lastTs = timestamp;

      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      if (delta > CONFIG.maxFrameDeltaMs) delta = CONFIG.maxFrameDeltaMs;

      state.acc += delta;

      let steps = 0;
      while (state.acc >= CONFIG.simStepMs && steps < CONFIG.maxSubSteps) {
        step(CONFIG.simStepMs);
        state.acc -= CONFIG.simStepMs;
        steps += 1;
        if (!battle.running) break;
      }

      if (steps >= CONFIG.maxSubSteps) state.acc = 0; // drop the backlog, never spiral
    };
  }

  function startLoop(battle) {
    stopLoop(state.battle);
    battle.running = true;
    state.battle = battle;
    state.lastTs = 0;
    state.acc = 0;
    state.rafId = window.requestAnimationFrame(makeFrame(battle));
  }

  function stopLoop(battle) {
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    if (battle) battle.running = false;
  }

  /* --------------------------------------------------------------------- *
   *  Round / match lifecycle
   * --------------------------------------------------------------------- */

  /**
   * Single entry point for "a projectile touched a fighter". Returns true when
   * the projectile is consumed by the hit.
   */
  function resolveHit(battle, target, projectile) {
    const shooter = battle.fighters.find((x) => x.uid === projectile.ownerUid) || null;
    const guard = target.def.guard;

    if (guard && shooter) {
      const gap = Math.hypot(shooter.x - target.x, shooter.y - target.y);

      if (gap > guard.rangePx && (projectile.parryCount || 0) < 2 && target.parryReadyAt <= battle.elapsedMs) {
        // Ranged attack: knock it straight back, homing on whoever sent it.
        parryProjectile(battle, projectile, target, shooter);
        target.parryReadyAt = battle.elapsedMs + guard.cooldownMs;
        return false; // still in play, now flying the other way
      }

      if (gap <= guard.rangePx) {
        // Melee-range hit: share the damage with the attacker.
        const deflected = projectile.damage * guard.deflectRatio;
        damageFighter(battle, target, projectile.damage - deflected, shooter, projectile.type);
        damageFighter(battle, shooter, deflected, target, 'deflect');
        target.stats.deflected += deflected;
        return true;
      }
    }

    damageFighter(battle, target, projectile.damage, shooter, projectile.type);
    return true;
  }

  /** Bounce an incoming projectile back at its owner, homing. */
  function parryProjectile(battle, projectile, knight, shooter) {
    const speed = Math.hypot(projectile.vx, projectile.vy) || 300;
    const dx = shooter.x - knight.x;
    const dy = shooter.y - knight.y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);

    projectile.ownerUid = knight.uid;
    projectile.targetId = shooter.uid;
    projectile.shooterId = knight.uid;
    projectile.homing = true;
    projectile.parryCount = (projectile.parryCount || 0) + 1;
    projectile.vx = Math.cos(angle) * speed;
    projectile.vy = Math.sin(angle) * speed;
    projectile.angle = angle;
    projectile.lifeMs = 0;
    if (projectile.lifespanMs > 0 && projectile.lifespanMs < 2600) projectile.lifespanMs = 2600;

    // Push it clear of the knight so it cannot re-trigger on him next step.
    const push = knight.size * 0.62;
    projectile.x = clamp(knight.x + knight.size / 2 + Math.cos(angle) * push, 0, battle.width);
    projectile.y = clamp(knight.y + knight.size / 2 + Math.sin(angle) * push, 0, battle.height);

    projectile.el.classList.add('parried');
    spawnFloater(battle, knight.x + knight.size / 2, knight.y + knight.size / 2, 'PARRY!', 'parry');
    knight.stats.parries += 1;
    renderProjectile(projectile);
  }

  /** Fade a projectile out and drop its node shortly after. */
  function fizzleProjectile(projectile) {
    if (!projectile || projectile.dead) return;
    projectile.dead = true;
    projectile.el.classList.add('fizzle');
    const el = projectile.el;
    window.setTimeout(() => el.remove(), 420);
  }

  function clearOverlay() {
    dom.box.querySelectorAll('.game-over').forEach((el) => el.remove());
    dom.box.classList.remove('ko');
  }

  function clearTransient(battle) {
    if (!battle) return;
    battle.projectiles.forEach((projectile) => projectile.el.remove());
    battle.projectiles.length = 0;
    battle.queue.length = 0;
    battle.floaters.forEach((item) => item.el.remove());
    battle.floaters.length = 0;
    // K.O. fizzling nodes have already left the list, so sweep the DOM too.
    dom.box.querySelectorAll('.projectile, .damage-number').forEach((el) => el.remove());
  }

  function endRound(battle, winnerSide, reason) {
    if (!battle || battle.over) return;

    battle.over = true;
    battle.winner = winnerSide;
    stopLoop(battle);

    // Fizzle whatever is still in the air instead of leaving it frozen on
    // screen (and in memory) behind the K.O. overlay.
    battle.queue.length = 0;
    battle.projectiles.forEach(fizzleProjectile);
    battle.projectiles.length = 0;

    // The simulation stops now, so anything driven by the sim clock (damage
    // numbers, sword sweeps) would sit frozen forever. Fade them out instead.
    battle.floaters.forEach((floater) => {
      floater.el.classList.add('fade-out');
      const el = floater.el;
      window.setTimeout(() => el.remove(), 420);
    });
    battle.floaters.length = 0;

    if (winnerSide === 'red') state.scores.red += 1;
    if (winnerSide === 'blue') state.scores.blue += 1;
    renderScores();

    const loser = battle.fighters.find((f) => f.hp <= 0);
    if (loser) loser.el.classList.add('ko-out');

    dom.box.classList.add('ko');
    window.setTimeout(() => dom.box.classList.remove('ko'), 460);

    const winner = battle.fighters.find((f) => f.side === winnerSide);
    const headline = reason === 'draw' ? 'Time!' : reason === 'time' ? 'Time!' : 'K.O.';
    const sub = winner
      ? winner.def.name + ' wins the round' + (reason === 'time' ? ' on health' : '') + '!'
      : 'Nobody wins this one.';

    const overlay = document.createElement('div');
    overlay.className = 'game-over';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-label', headline + ' ' + sub);
    overlay.innerHTML =
      '<div class="ko-title">' + headline + '</div>' +
      '<p class="ko-sub">' + sub + '</p>' +
      '<div class="ko-actions">' +
      '<button class="start-btn" type="button" data-action="rematch">Rematch</button>' +
      '<button class="ghost-btn" type="button" data-action="menu">Main Menu</button>' +
      '</div>';
    dom.box.appendChild(overlay);

    const focusTarget = overlay.querySelector('button[data-action="rematch"]');
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus({ preventScroll: true });

    dom.status.textContent = headline + ' ' + sub;
  }

  function resetRound(battle) {
    clearTransient(battle);

    battle.over = false;
    battle.winner = null;
    battle.elapsedMs = 0;
    battle.remainingMs = CONFIG.roundTimeLimitMs;

    battle.fighters.forEach((fighter) => {
      fighter.el.classList.remove('ko-out', 'hit', 'zapped');
      placeFighterAtStart(fighter, battle);
      renderFighter(fighter);
      renderHealth(battle, fighter);
    });

    clearOverlay();
    renderScores();
    renderBadges(battle);
    renderTimer(battle);
    dom.status.textContent = 'Round started.';
  }

  function showBattleScreen() {
    dom.menuScreen.classList.add('hidden');
    dom.battleScreen.classList.remove('hidden');
  }

  function showMenuScreen() {
    stopLoop(state.battle);
    if (state.battle) clearTransient(state.battle);
    clearOverlay();
    dom.battleScreen.classList.add('hidden');
    dom.menuScreen.classList.remove('hidden');
    if (dom.startBattleBtn && typeof dom.startBattleBtn.focus === 'function') {
      dom.startBattleBtn.focus({ preventScroll: true });
    }
  }

  function startMatch() {
    stopLoop(state.battle); // never leave an older match's loop alive

    let leftId;
    let rightId;

    if (state.mode === 'two') {
      leftId = state.pick.red;
      rightId = state.pick.blue;
    } else {
      const playerId = state.pick.single;
      const roster = Object.keys(CHARACTERS);
      const nextIndex = (roster.indexOf(playerId) + 1) % roster.length;
      const enemyId = roster[nextIndex];
      // Team choice decides which side of the arena the player fights on.
      leftId = state.team === 'red' ? playerId : enemyId;
      rightId = state.team === 'red' ? enemyId : playerId;
    }

    state.scores = { red: 0, blue: 0 };

    // Un-hide the arena *first*: a display:none box measures 0x0, which would
    // put both fighters on the same pixel in the corner.
    showBattleScreen();

    state.battle = createBattle(leftId, rightId);
    const battle = state.battle;

    resetRound(battle);
    startLoop(battle);
    dom.status.textContent =
      battle.fighters[0].def.name + ' versus ' + battle.fighters[1].def.name + '. Round started.';
  }

  function rematch() {
    const battle = state.battle;
    if (!battle) {
      startMatch();
      return;
    }
    resetRound(battle);
    startLoop(battle);
  }

  /* --------------------------------------------------------------------- *
   *  Events: buttons, overlay, resize, visibility, keyboard
   * --------------------------------------------------------------------- */

  dom.startBattleBtn.addEventListener('click', startMatch);
  dom.rematchBtn.addEventListener('click', rematch);
  dom.menuBtn.addEventListener('click', showMenuScreen);

  dom.box.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'rematch') rematch();
    if (button.dataset.action === 'menu') showMenuScreen();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (dom.battleScreen.classList.contains('hidden')) return;
    showMenuScreen();
  });

  document.addEventListener('visibilitychange', () => {
    state.paused = document.hidden;
    state.lastTs = 0;
    state.acc = 0;
  });

  function handleResize() {
    const battle = state.battle;
    if (!battle) return;

    const width = dom.box.clientWidth;
    const height = dom.box.clientHeight;
    if (!width || !height) return;

    const scaleX = battle.width ? width / battle.width : 1;
    const scaleY = battle.height ? height / battle.height : 1;
    const size = readFighterSize();
    const wasGuess = !battle.measured;

    battle.width = width;
    battle.height = height;
    battle.measured = true;

    battle.fighters.forEach((fighter) => {
      fighter.size = size;
      if (wasGuess) {
        // The spawn positions came from the fallback arena, so lay them out
        // again for the real one instead of scaling a guess.
        placeFighterAtStart(fighter, battle);
      } else {
        fighter.x *= scaleX;
        fighter.y *= scaleY;
        clampToArena(fighter, battle);
      }
      renderFighter(fighter);
    });

    if (!wasGuess) {
      battle.projectiles.forEach((projectile) => {
        projectile.x *= scaleX;
        projectile.y *= scaleY;
        renderProjectile(projectile);
      });
    }
  }

  if (typeof window.ResizeObserver === 'function') {
    new window.ResizeObserver(handleResize).observe(dom.box);
  } else {
    window.addEventListener('resize', handleResize);
  }
  window.addEventListener('orientationchange', handleResize);

  /* --------------------------------------------------------------------- *
   *  Boot
   * --------------------------------------------------------------------- */

  syncMenuUi();
  renderScores();

  // Debug/testing hook — used by tests/simulate.mjs, harmless in production.
  window.__manVsMan = {
    state,
    startMatch,
    rematch,
    endRound,
    showMenuScreen,
    CONFIG,
    CHARACTERS,
    PAPER,
    DEBRIS_ASSETS,
    countDeployedKnives
  };
})();
