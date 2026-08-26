"use strict";
/* ============================================================
   MUNDUS MIRIS — shared game engine.
   Top-down, hop-jump, oxygen-as-currency. All art procedural.

   Loaded by every level page as a classic script (NOT type="module",
   or startGame would be scoped out of the page's inline <script>).
   Each page calls startGame(n); everything that differs between levels
   lives in LEVELS below, and the terrain both levels share is built
   identically by the scene.
   ============================================================ */

const TUNE = {
  o2Max: 100, hpMax: 100,
  drainPerSec: 0.55,       // ambient (multiplied by settings slider)
  jumpCost: 2.0,
  swingCost: 3.0,
  tankRefillPct: 0.5,      // a tank restores half a full tank of O2
  suffocateHpPerSec: 12,
  moveSpeed: 95,           // slow, heavy
  jumpMs: 1000, jumpHeight: 30,
  swingCooldown: 420, swingRange: 30,
  startFlares: 3, craterFallPct: 0.55,
  hazardScale: 2.5, hazardMissRadius: 25,

  /* Meteor shower (Level 2). Tuned for "tense but survivable": a strike
     group every 1.5-2.1s, mostly landing near the player rather than on
     them. `tell` must stay above jumpMs/1000 so a player caught mid-hop
     can still land and walk clear. */
  meteor: {
    gapMin: 1.5, gapMax: 2.1,   // seconds between volleys
    perVolley: 3,               // 1 aimed + 2 lattice
    tell: 1.1,                  // telegraph seconds — must exceed jumpMs (1.0s)
                                // or a player who jumps as the marker appears
                                // lands exactly on impact with no slack
    stagger: 0.14,              // extra tell per rock, so hits read separately
    radius: 26,                 // kill radius AND the drawn ring radius
    dmgPct: 0.55,               // same bite as a bad crater landing
    iFrames: 700,               // ms immunity — caps one volley at a single hit
    grace: 2.5,                 // quiet seconds after spawn/respawn
    aimJitter: 34,              // px scatter on the aimed rock
    lead: 0.5,                  // fraction of tell to lead the player's heading
    grid: 70,                   // lattice pitch (echoes the crater-field pitch)
    fallH: 170,                 // px the rock visually falls
    maxScars: 60,               // ring-buffer cap on decorative impact marks
    shelter: [330, 940],        // no strikes while inside a side tunnel
  },

  /* Level 3: the cave. Each subsystem gets its own block, the same way the
     meteor shower does, so it can be tuned without hunting through code. */
  flashlight: {
    range: 190,               // px the beam reaches
    coneDeg: 100,             // beam width
    ambient: 0.90,            // darkness opacity: near-black, not total
    halo: 46,                 // small always-lit circle around the player
  },
  crawler: {
    hp: 3,                    // swings to kill (rocks take 2)
    damage: 6,
    contactCooldown: 700,     // ms between touches from the same crawler
    speed: 55,                // slower than the player's 95 — you can outrun one
    aggroRadius: 140,
    loseRadius: 320,          // gives up past this, so packs don't trail forever
  },
  boss: {
    hp: 20,
    damage: 18,
    telegraphMs: 500,         // tint-flash warning before it commits to a lunge
    lungeSpeed: 220,
    lungeMs: 700,
    restMs: 1100,
    aggroRadius: 420,
    contactCooldown: 900,
  },
  companion: {
    speedMult: 0.8,           // carrying him slows you
    o2DrainMult: 1.25,        // and costs air
    followLag: 34,            // px behind before he catches up
  },
  mercySwingCostMult: 0.8,    // leaving him: swings cost less, guilt is free
  tanksRequiredPhase1: 3,
};

/* Honour the OS reduced-motion setting for the impact shake, as the menu
   page already does for its prompt pulse. */
const REDUCED_MOTION = !!(window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const S = {  // mutable game state (reset on restart)
  o2: TUNE.o2Max, hp: TUNE.hpMax,
  flares: TUNE.startFlares,
  checkpoint: null,          // {x,y}
  hasClub: false, hasFlag: false,
  airborne: false, facing: {x:0,y:1},
  paused: false,             // dialogue or overlay open
  dead: false, won: false,
  deathCause: null,          // set by damage() at the fatal blow
  hasCompanion: false,       // Level 3: carrying him costs speed and air
  phase: 0,                  // Level 3 story phase, drives the objective hint
  startTime: 0, deaths: 0,
};

/* What each way of dying says and shows. The art is never preloaded — setting
   .src on first death is what fetches it, and the browser caches from there. */
const DEATHS = {
  fall:      { reason:'A hard fall cracked your suit seals. Vitals gone.',
               img:'assets/MundusMirisFallDeathImage.png' },
  suffocate: { reason:'Oxygen depleted. The suit kept you moving longer than it should have.',
               img:'assets/MundusMirisSuffocationDeathImage.png' },
  meteor:    { reason:'A strike caught you in the open. The suit did not hold.',
               img:'assets/MundusMirisAsteroidDeathImage.png' },
  crawler:   { reason:'They found you in the dark. There were more than you counted.', img:null },
  it:        { reason:'Something in the nest was much larger than the rest.', img:null },
  unknown:   { reason:'Your suit telemetry has gone dark.', img:null },
};

/* ---------------- Level 3: the cave ------------------------------------
   Kept in its own object so LEVELS stays readable. build() replaces the
   shared surface layout entirely; the world is still 1280x1900, running
   bottom (rappel point) to top (exit beacon). */
const L3 = {
  W_WALL:160, E_WALL:1120, TOP:150, BOT:1880,

  build(sc, W, H){
    const step = 48;
    const wall = (x,y)=>{ const c=sc.cliffs.create(x,y,'cliff').setScale(2); c.refreshBody(); c.setDepth(2); return c; };
    // a run of wall with an optional doorway gap punched in it
    const row = (x0,x1,y,gap)=>{ const o=[]; for(let x=x0;x<=x1;x+=step){
        if(gap && x>=gap[0] && x<=gap[1]) continue; o.push(wall(x,y)); } return o; };
    const col = (y0,y1,x,gap)=>{ const o=[]; for(let y=y0;y<=y1;y+=step){
        if(gap && y>=gap[0] && y<=gap[1]) continue; o.push(wall(x,y)); } return o; };

    sc.enemies = sc.physics.add.group();
    const dark = 0x0d0d14;
    sc.add.tileSprite(W/2,H/2,W,H,'ground').setTint(0x4a4a58);   // colder rock

    const { W_WALL:LW, E_WALL:RW, TOP:T, BOT:B } = L3;
    // ---- outer shell
    col(T,B,LW); col(T,B,RW); row(LW,RW,T); row(LW,RW,B);

    // ---- entry chamber (bottom): where you rappel in
    row(LW,RW,1650,[592,688]);

    // ---- search cavern: three clearings, each with a tank and a pack
    col(1250,1600,460,[1250,1298]);
    col(1250,1600,820,[1250,1298]);
    const clearings = [[300,1450],[640,1450],[980,1450]];
    clearings.forEach((c,i)=>{
      sc.spawnTank(c[0],c[1]);
      // 2-3 crawlers per clearing, spread so they don't stack on spawn
      const n = 2 + (i%2);
      for(let j=0;j<n;j++) sc.spawnCrawler(c[0]-60+j*60, c[1]-90, false);
    });

    // ---- empty camp: Mayo's dropped gear, and the trail out of it
    row(LW,RW,1150,[400,496]);
    sc.add.image(640,1060,'gear').setScale(2).setDepth(1060);
    // the drag-mark, heading north-west toward the trail mouth
    [[620,1030],[590,1000],[560,975],[520,955],[470,940],[440,915]]
      .forEach(p=> sc.add.image(p[0],p[1],'trail').setScale(2).setDepth(1));

    /* ---- the trail: a switchback, so the beam only ever shows you one leg.
       Gaps alternate sides — west, east, west — and the drag-marks above point
       at the first of them. */
    row(400,RW,930);      // leg A entered from the WEST gap (x 160-400)
    row(LW,880,780);      // leg B entered from the EAST gap (x 880-1120)
    row(400,RW,630);      // leg C entered from the WEST gap again
    sc.spawnTank(260,860);            // west end of leg A
    sc.spawnTank(1000,700);           // east end of leg B
    sc.add.image(700,850,'bones').setScale(2).setDepth(850);
    sc.add.image(500,700,'bones').setScale(2).setDepth(700);
    [[600,880],[850,820],[800,690],[520,660],[450,550],[700,520]]
      .forEach(p=> sc.spawnCrawler(p[0],p[1],false));

    // ---- the nest: sealed arena. The gate north is a solid run of wall while
    // IT lives, and gets destroyed the moment it goes down.
    row(LW,RW,470,[592,688]);         // way in, from leg C
    sc.nestGate = row(LW,RW,250);     // way out — no gap until the boss dies
    sc.boss = sc.spawnCrawler(640,350,true);
    [[420,300],[880,320],[500,420],[800,410]]
      .forEach(p=> sc.add.image(p[0],p[1],'bones').setScale(2).setDepth(p[1]));

    // ---- the exit beacon, above the nest
    const bc = sc.add.image(640,195,'beacon').setScale(2).setDepth(195);
    sc.tweens.add({targets:bc, alpha:0.25, duration:620, yoyo:true, repeat:-1});
  },

  triggers: [
    {x:640,y:1820,r:90,who:'Captain Mayo',text:'Ah— that is a bad landing. Leg is done. Go on without me, rookie — find us a way through and come back for me. Keep your light moving.',
      effect:(sc)=>{ setHint(''); }},
    {x:640,y:1600,r:70,who:'SUIT COMPUTER',text:'ADVISORY: ambient light below instrument threshold. Helmet lamp engaged. Battery is not rated for this. Something down here is warm, and it is not you.'},
    {x:640,y:1080,r:80,who:'Captain Mayo',text:'...Mayo? His gear is here. His tether is cut clean — not torn, cut. There is a drag mark heading north, and it is wet.',
      effect:(sc)=>{ S.phase=1; }},
    {x:300,y:700,r:55,who:'GEMINI-SUIT REMAINS',text:'The name tape reads BRANNIGAN. The mission board never listed a Brannigan. The suit is older than the colony.'},
    {x:980,y:560,r:55,who:'GEMINI-SUIT REMAINS',text:'This one is curled around a sample case, still sealed. Whatever it was carrying, it thought that mattered more than running.'},
    {x:640,y:430,r:80,who:'SUIT COMPUTER',text:'WARNING: mass reading ahead exceeds anything in the colony manifest. Recommend withdrawal. There is no route that permits withdrawal.'},
    // the choice — only after IT is down
    {x:640,y:300,r:70,who:'Captain Mayo',text:'You came back. Cannot feel my legs, rookie. You can carry me and we both go slow — or you leave me and you go fast. Your call. Make it quick.',
      cond:()=> S.phase>=2,
      choices:[
        {key:'1', label:'CARRY HIM', effect:(sc)=>{ sc.spawnCompanion(); sc.pop(sc.base.x,sc.base.y-30,'CARRYING MAYO',0xc9a227); }},
        {key:'2', label:'LEAVE HIM', effect:(sc)=>{ sc.swingCostMult=TUNE.mercySwingCostMult; sc.pop(sc.base.x,sc.base.y-30,'YOU LEFT HIM',0xb3202a); }},
      ]},
    {x:640,y:200,r:60,who:'SUIT COMPUTER',text:'Signal acquired. Surface relay, bearing north. It is blinking. Someone is still up there.',
      win:true},
  ],
};

/* ---------------- per-level configuration ------------------------------
   Terrain that is identical between levels (the corridor walls, crater
   field, trench rows, ridge gauntlet, tanks, tunnels) stays in the scene.
   Only what genuinely differs appears here. */
const LEVELS = {
  1: {
    id: 'level1',
    name: 'LEVEL 1 — LANDING',
    title: 'MUNDUS MIRIS — Level 1: Landing',
    spawn: {x:600, y:1850},
    start: {hasClub:false, hasFlag:false},
    ball: {x:470, y:1410},
    lander: {tex:'lander', x:660, y:1690},
    npcs: [[620,1780],[470,1380],[625,830]],
    // the two destructible gates; Level 2 omits these (already smashed)
    rocks: [
      [590,760],[625,752],[660,760],[608,782],[644,782],
      [590,560],[625,552],[660,560],[608,582],[644,582],
    ],
    meteors: false,
    goal: {
      mode: 'plantFlag',
      rect: [560,230,160,90],
      marker: {x:640, y:275, w:160, h:90},
      prompt: 'E — PLANT THE FLAG',
      requires: ()=> S.hasFlag,
    },
    win: {title:'FLAG PLANTED', flavor:'The ground begins to tremble...'},
    /* Directions checked against the actual trigger coordinates below:
       Mayo (470,1380) is 310px north and 190px west of the lander, and
       Henry (625,830) is 860px north of it — just past the trench rows,
       just short of the boulders. */
    hint: ()=> !S.hasClub ? 'FIND CAPTAIN MAYO — NORTH-WEST OF THE LANDER'
             : !S.hasFlag ? 'KING HENRY HAS THE FLAG — NORTH PAST THE TRENCHES'
             :              'HEAD NORTH — PLANT THE FLAG ON THE RIDGE',
    triggers: [
      // 1 — movement
      {x:560,y:1850,r:70,who:'Commander Okwonko',text:'Welcome to the surface, rookie. Take some time to get yourself familiar with moving in low gravity. Move with WASD or the arrow keys — take it slow now, it aint a race.', auto:true},
      // 2 — oxygen (jumping + tanks, one topic)
      {x:572,y:1690,r:60,who:'Commander Okwonko',text:'Watch out - Craters ahead. Tap SPACE to jump — gravity is one-sixth of home, so you will hang in the air a while, and every jump burns oxygen. When you are running low, tanks like those blue cylinders up ahead will refill you — never pass one by.'},
      // 3 — golf / weapon
      {x:470,y:1380,r:55,who:'Captain Mayo',text:'Catch. A six iron — don\'t ask why it was on the manifest. Press J to swing. Swings burn oxygen too, so make them count. Go on, hit the ball.',
        give:'club'},
      // 4 — flag, positioned right before the rock chokepoint
      {x:625,y:830,r:60,who:'King Henry',text:'Here — the flag. Plant it at the marker on the ridge north of here. Those boulders dead ahead are blocking the path — your club should crack them open. Watch for fissures higher up. Drop a flare with F if you want a checkpoint. Make us proud.',
        cond:()=>S.hasClub, give:'flag'},
      // secret side-tunnel lore
      {x:150,y:650,r:45,who:'WEATHERED PLACARD',text:'The universe is under no obligation to make sense to you. — Neil deGrasse Tyson'},
      {x:1150,y:350,r:45,who:'SCRATCHED STONE',text:'I tried to organize a party on the Moon, but nobody came. There was no atmosphere.'},
    ],
  },

  2: {
    id: 'level2',
    name: 'LEVEL 2 - DEATH FROM ABOVE',
    title: 'MUNDUS MIRIS — Level 2: Death From Above',
    spawn: {x:640, y:275},           // the summit — where Level 1 ended
    start: {hasClub:true, hasFlag:false},
    ball: {x:470, y:1410},
    /* The ascent stage has gone. y=1714 rather than 1690 so the shorter
       texture's landing pads sit on exactly the same ground line as Level 1's
       (both bottom out at y=1744). */
    lander: {tex:'landerBase', x:660, y:1714},
    npcs: [[570,1770]],              // Mayo, waiting by what's left of it
    /* Level 1's two gates were smashed on the way up, so they are absent.
       In their place, meteor rubble in new spots. Each band covers about
       two-thirds of the corridor and alternates sides, so the descent
       zigzags — under a shower, walking 300px sideways is cost enough
       without making the player stop and smash a full wall. */
    rocks: [
      // band 1 (y=500) — east side, between the crater barrier and the funnel
      [620,500],[660,500],[700,500],[740,500],[780,500],[820,500],[860,500],[900,500],
      // band 2 (y=640) — west side, between the funnel and the fissure row
      [400,640],[440,640],[480,640],[520,640],[560,640],[600,640],[640,640],
      // band 3 (y=1450) — split, with a gap at x 560-740; last gate before home
      [380,1450],[420,1450],[460,1450],[500,1450],[540,1450],
      [760,1450],[800,1450],[840,1450],[880,1450],
    ],
    meteors: true,
    goal: {mode:'trigger'},          // no zone: Mayo's win trigger ends it
    win: {title:'STRANDED',
          flavor:'The ridge is coming apart behind you. Mayo is already moving.'},
    hint: ()=> 'RUN — GET BACK TO THE LANDER',
    triggers: [
      {x:640,y:290,r:90,who:'Commander Okwonko',text:'Meteor shower incoming, Rookie — get your ass back to the lander. NOW! Watch the sky: where the ground lights up red, something is already on its way down.'},
      {x:570,y:1770,r:75,who:'Captain Mayo',text:'Lander is gone — ascent stage burned for orbit without us. We need to get off this surface or we are dead. I saw a cave in the ridge on the way down. Follow me!',
        win:true},
      // the side tunnels are still there, and still worth the detour
      {x:150,y:650,r:45,who:'WEATHERED PLACARD',text:'The universe is under no obligation to make sense to you. — Neil deGrasse Tyson'},
      {x:1150,y:350,r:45,who:'SCRATCHED STONE',text:'I tried to organize a party on the Moon, but nobody came. There was no atmosphere.'},
    ],
  },

  /* ---------------- Level 3: Nyctophobia ---------------------------------
     Underground, so none of the surface corridor applies — buildTerrain below
     replaces the shared layout entirely. Flow runs bottom (the rappel point)
     to top (the exit beacon): search -> empty camp -> the trail -> the nest
     -> the choice -> out. */
  3: {
    id: 'level3',
    name: 'LEVEL 3 — NYCTOPHOBIA',
    title: 'MUNDUS MIRIS — Level 3: Nyctophobia',
    spawn: {x:640, y:1820},
    start: {hasClub:true, hasFlag:false},
    ball: null,                      // no golf here
    lander: null,                    // underground
    npcs: [],                        // Mayo is a prop, placed by buildTerrain
    rocks: [],                       // all placed by buildTerrain
    meteors: false,
    dark: true,                      // switches on the flashlight/darkness pass
    goal: {mode:'trigger'},          // the beacon trigger ends it
    win: {title:'SIGNAL ACQUIRED',
          flavor:'Something is still moving back there. You do not look.'},
    hint: ()=> S.phase===0 ? 'FIND MAYO — SEARCH THE CAVERN'
             : S.phase===1 ? 'FOLLOW THE TRAIL — AND WATCH THE DARK'
             :               'GET OUT — HEAD FOR THE SIGNAL',
    triggers: L3.triggers,
    buildTerrain: (sc,W,H)=> L3.build(sc,W,H),
  },
};

const ui = {
  hp: document.getElementById('hpfill'),
  o2: document.getElementById('o2fill'),
  flares: document.getElementById('flareCount'),
  hint: document.getElementById('hint'),
  dlg: document.getElementById('dlg'),
  dlgWho: document.getElementById('dlgWho'),
  dlgText: document.getElementById('dlgText'),
  dlgPress: document.getElementById('dlgPress'),
  dead: document.getElementById('deadOverlay'),
  deadReason: document.getElementById('deadReason'),
  deadArt: document.getElementById('deadArt'),
  win: document.getElementById('winOverlay'),
  winStats: document.getElementById('winStats'),
  settings: document.getElementById('settings'),
  controlsPanel: document.getElementById('controlsPanel'),
  respawnO2: document.getElementById('respawnO2'),
  respawnVal: document.getElementById('respawnVal'),
  drainRate: document.getElementById('drainRate'),
  drainVal: document.getElementById('drainVal'),
  o2Timer: document.getElementById('o2Timer'),
  o2clock: document.getElementById('o2clock'),
};

document.getElementById('gear').onclick = () => {
  ui.settings.style.display = ui.settings.style.display === 'block' ? 'none' : 'block';
  ui.controlsPanel.style.display = 'none';
};
document.getElementById('controlsBtn').onclick = () => {
  ui.controlsPanel.style.display = ui.controlsPanel.style.display === 'block' ? 'none' : 'block';
  ui.settings.style.display = 'none';
};
/* Settings live in localStorage so they survive the trip out to the level-select
   page and back — they used to persist for free when this was all one page. */
const PREFS='mundusMirisPrefs';
/* Bumped when a stored default changes meaningfully. Anyone who played before
   the drain default moved to 1.5x has 1.0x saved, and would silently keep the
   old balance forever — so a stale version drops the saved drain (only) and
   takes the new default. Their respawn choice is personal taste, so it stays. */
const PREFS_V = 2;
(function loadPrefs(){
  try{
    const p=JSON.parse(localStorage.getItem(PREFS)||'{}');
    if(p.respawnO2) ui.respawnO2.value=p.respawnO2;
    if(p.drainRate && p.v===PREFS_V) ui.drainRate.value=p.drainRate;
    if(typeof p.o2Timer==='boolean') ui.o2Timer.checked=p.o2Timer;
  }catch(e){ /* private mode or blocked storage — defaults are fine */ }
  ui.respawnVal.textContent = ui.respawnO2.value + '%';
  ui.drainVal.textContent = (ui.drainRate.value/100).toFixed(1) + '×';
})();
function savePrefs(){
  try{ localStorage.setItem(PREFS, JSON.stringify({
    v: PREFS_V, respawnO2: ui.respawnO2.value, drainRate: ui.drainRate.value,
    o2Timer: ui.o2Timer.checked })); }catch(e){}
}
ui.respawnO2.oninput = () => { ui.respawnVal.textContent = ui.respawnO2.value + '%'; savePrefs(); };
ui.drainRate.oninput = () => { ui.drainVal.textContent = (ui.drainRate.value/100).toFixed(1) + '×'; savePrefs(); };
ui.o2Timer.onchange  = () => { savePrefs(); if(scene) scene.updateHUD(); };
document.getElementById('btnRestart').onclick = () => restartLevel();
document.getElementById('btnDeadRestart').onclick = () => restartLevel();
document.getElementById('btnWinRestart').onclick = () => restartLevel();
document.getElementById('btnRespawn').onclick = () => scene && scene.respawn();

let scene = null;
function restartLevel(){ if(scene) scene.scene.restart(); }
function hideDialog(){ ui.dlg.style.display = 'none'; }
function setHint(text){ ui.hint.textContent = text ? 'CURRENT OBJECTIVE: '+text : ''; }

/* Swap in the death art for a cause, fetching it on first use.
   Uses visibility rather than display while loading: with display:none the card
   would be short on the first frame and grow ~200px when a 2MB PNG decodes,
   shifting RESPAWN out from under the cursor mid-click. Reserving the box means
   only the pixels pop in. */
function setDeathArt(src){
  const el = ui.deadArt;
  if(!src){ el.style.display='none'; return; }
  el.style.display='block';
  if(el.getAttribute('src') === src){
    // Same cause as last time — already fetched. Re-assigning an identical src
    // does not reliably refire onload, which would strand it hidden forever.
    el.style.visibility = el.complete ? 'visible' : 'hidden';
    return;
  }
  el.style.visibility='hidden';
  el.onload  = ()=>{ el.style.visibility='visible'; };
  el.onerror = ()=>{ el.style.display='none'; };   // offline: card still works
  el.setAttribute('src', src);
}

/* ---------------- texture factory (all pixel art in code) --------------- */
function makeTextures(sc){
  const g = sc.add.graphics();
  const T = (key,w,h,draw) => { g.clear(); draw(g); g.generateTexture(key,w,h); };

  // ground tile: dark regolith with speckle
  T('ground',64,64,g=>{
    g.fillStyle(0x14141c); g.fillRect(0,0,64,64);
    const rnd = new Phaser.Math.RandomDataGenerator(['regolith']);
    for(let i=0;i<70;i++){ g.fillStyle(rnd.pick([0x1b1b26,0x10101a,0x1f1f2b]));
      g.fillRect(rnd.between(0,62),rnd.between(0,62),rnd.between(1,3),rnd.between(1,3)); }
  });

  // astronaut 14x18 (white suit, gold visor, backpack)
  T('astro',14,18,g=>{
    g.fillStyle(0x9a978c); g.fillRect(2,3,10,2);          // pack top
    g.fillStyle(0xd8d3c4); g.fillRect(3,1,8,7);           // helmet
    g.fillStyle(0xc9a227); g.fillRect(4,3,6,3);           // visor
    g.fillStyle(0xd8d3c4); g.fillRect(2,8,10,7);          // torso
    g.fillStyle(0xb8b3a4); g.fillRect(1,9,2,5); g.fillRect(11,9,2,5); // arms
    g.fillRect(3,15,3,3); g.fillRect(8,15,3,3);           // legs
    g.fillStyle(0xb3202a); g.fillRect(6,9,2,2);           // chest patch
  });
  // NPC variant: teal patch
  T('astroN',14,18,g=>{
    g.fillStyle(0x9a978c); g.fillRect(2,3,10,2);
    g.fillStyle(0xcfcabb); g.fillRect(3,1,8,7);
    g.fillStyle(0x3a7bd8); g.fillRect(4,3,6,3);
    g.fillStyle(0xcfcabb); g.fillRect(2,8,10,7);
    g.fillStyle(0xafaa9b); g.fillRect(1,9,2,5); g.fillRect(11,9,2,5);
    g.fillRect(3,15,3,3); g.fillRect(8,15,3,3);
    g.fillStyle(0x3a7bd8); g.fillRect(6,9,2,2);
  });

  T('shadow',14,6,g=>{ g.fillStyle(0x000000,0.45); g.fillEllipse(7,3,13,5); });

  // lander (decorative, 64x54)
  T('lander',64,54,g=>{
    g.fillStyle(0x5a5a66); g.fillRect(14,4,36,20);        // ascent stage
    g.fillStyle(0x3c3c46); g.fillRect(24,8,10,10);        // hatch
    g.fillStyle(0xc9a227); g.fillRect(10,24,44,16);       // descent gold foil
    g.fillStyle(0xa8861f); for(let i=0;i<5;i++) g.fillRect(12+i*9,26,6,12);
    g.fillStyle(0x777788); g.fillRect(4,38,4,14); g.fillRect(56,38,4,14);  // legs
    g.fillRect(0,50,12,3); g.fillRect(52,50,12,3);        // pads
    g.fillStyle(0x9aa0aa); g.fillRect(28,0,8,5);          // antenna dish
  });
  /* Level 2's lander after the ascent stage has burned for orbit, Apollo-style:
     descent stage and legs only, with a scorched separation plane on top.
     Its own 64x30 texture rather than the full one with the top cropped, so
     the static body shrinks with the art instead of keeping 48px of empty
     space above it that the player would still collide with. Every rect below
     is the original shifted up by 24 (the old descent-stage line). */
  T('landerBase',64,30,g=>{
    g.fillStyle(0xc9a227); g.fillRect(10,0,44,16);        // descent gold foil
    g.fillStyle(0xa8861f); for(let i=0;i<5;i++) g.fillRect(12+i*9,2,6,12);
    g.fillStyle(0x777788); g.fillRect(4,14,4,14); g.fillRect(56,14,4,14);  // legs
    g.fillRect(0,26,12,3); g.fillRect(52,26,12,3);        // pads
    g.fillStyle(0x2a2a33); g.fillRect(14,0,36,3);         // scorched mount ring
    g.fillStyle(0x1a1a20); g.fillRect(22,0,18,2);
  });

  // rocks
  T('boulder',20,16,g=>{ g.fillStyle(0x3a3a46); g.fillEllipse(10,9,19,13);
    g.fillStyle(0x4a4a58); g.fillEllipse(8,7,10,7); g.fillStyle(0x2c2c36); g.fillRect(4,13,12,2); });
  T('cliff',24,24,g=>{ g.fillStyle(0x23232e); g.fillRect(0,0,24,24);
    g.fillStyle(0x2e2e3a); g.fillRect(2,2,9,8); g.fillRect(13,11,8,9);
    g.fillStyle(0x181820); g.fillRect(0,21,24,3); });

  // crater / fissure (jumpable hazards)
  T('crater',30,20,g=>{ g.fillStyle(0x08080e); g.fillEllipse(15,10,28,17);
    g.lineStyle(2,0x2a2a36); g.strokeEllipse(15,10,28,17); });
  T('fissure',56,14,g=>{ g.fillStyle(0x07070c); g.fillRect(0,4,56,7);
    g.fillRect(8,2,10,3); g.fillRect(30,10,14,3); g.lineStyle(1,0x262633); g.strokeRect(0,4,56,7); });

  // oxygen tank
  T('tank',10,16,g=>{ g.fillStyle(0x3a7bd8); g.fillRect(2,3,6,12);
    g.fillStyle(0x6ba0e8); g.fillRect(3,4,2,9); g.fillStyle(0xd8d3c4); g.fillRect(3,0,4,3); });

  // flare (dropped, lit)
  T('flare',6,10,g=>{ g.fillStyle(0xb3202a); g.fillRect(2,2,3,8); g.fillStyle(0xffd54a); g.fillRect(2,0,3,3); });
  T('flareGlow',40,40,g=>{ g.fillStyle(0xff5a3c,0.18); g.fillCircle(20,20,19);
    g.fillStyle(0xffd54a,0.22); g.fillCircle(20,20,9); });

  // lore plaque marker
  T('plaque',16,12,g=>{ g.fillStyle(0x2c2c36); g.fillRect(0,0,16,12);
    g.fillStyle(0x44445a); g.fillRect(1,1,14,10);
    g.fillStyle(0x1c1c26); g.fillRect(3,3,10,2); g.fillRect(3,6,7,2); });

  // flag + planted flag
  T('flag',12,18,g=>{ g.fillStyle(0xb8b3a4); g.fillRect(1,0,2,18);
    g.fillStyle(0xb3202a); g.fillRect(3,1,9,7);
    g.fillStyle(0xd8d3c4); g.fillRect(3,3,9,2); g.fillStyle(0xc9a227); g.fillRect(4,2,3,2); });

  // golf ball + club pickup
  T('ball',5,5,g=>{ g.fillStyle(0xf2efe4); g.fillCircle(2,2,2); });
  T('club',14,6,g=>{ g.fillStyle(0x8a8798); g.fillRect(0,2,11,2); g.fillStyle(0xc9a227); g.fillRect(10,1,4,4); });

  // swing arc flash
  T('swing',22,22,g=>{ g.lineStyle(3,0xf2efe4,0.9); g.beginPath();
    g.arc(11,11,9,-0.8,0.8); g.strokePath(); });

  /* ---- Level 3: the cave ----
     Crawler: hunched, long-armed, ribbed torso, face tendrils, red eyes.
     Drawn 22x30 and placed at scale 2, so it reads a head taller than the
     28x36 astronaut — it should feel wrong to stand next to. */
  const crawlerBody = (g, skin, dark, eye) => {
    g.fillStyle(dark);
    // arms: long, dropping past the knees, hooking outward into claws
    g.fillRect(2,10,3,13);  g.fillRect(17,10,3,13);
    g.fillRect(1,21,3,6);   g.fillRect(18,21,3,6);
    g.fillRect(0,26,2,2);   g.fillRect(20,26,2,2);   // claw tips
    g.fillRect(3,26,2,2);   g.fillRect(17,26,2,2);
    // shoulders, hunched up around the head
    g.fillRect(4,8,5,4);    g.fillRect(13,8,5,4);
    g.fillStyle(skin);
    g.fillRect(7,9,8,12);                            // torso
    g.fillRect(6,20,4,8);   g.fillRect(12,20,4,8);   // haunches
    g.fillStyle(dark);
    g.fillRect(6,27,5,3);   g.fillRect(11,27,5,3);   // splayed feet
    // ribcage — thin dark bands, the detail that sells the silhouette
    for(let i=0;i<4;i++) g.fillRect(8,11+i*2,6,1);
    // head, low and forward
    g.fillStyle(skin); g.fillRect(7,2,8,7);
    g.fillStyle(dark);
    g.fillRect(6,1,10,2);                            // brow ridge
    g.fillRect(7,8,2,3);  g.fillRect(10,8,2,3);  g.fillRect(13,8,2,3);  // tendrils
    g.fillStyle(eye);
    g.fillRect(8,4,2,2);  g.fillRect(12,4,2,2);      // eyes
  };
  T('crawler',22,30,g=>crawlerBody(g,0x2a2a30,0x141418,0xd4302a));
  // the boss is the same shape read larger and colder, with brighter eyes
  T('crawlerBoss',22,30,g=>crawlerBody(g,0x38323c,0x1a1620,0xff3b2f));

  // soft-edged beam mask: a radial falloff the flashlight punches into the dark
  T('lightBlob',128,128,g=>{
    for(let r=64;r>0;r-=2){
      g.fillStyle(0xffffff, 0.020*(1-r/64)+0.004);
      g.fillCircle(64,64,r);
    }
  });
  // dropped gear at the empty camp, and the wounded companion
  T('gear',14,10,g=>{ g.fillStyle(0x3a7bd8); g.fillRect(1,3,7,6);
    g.fillStyle(0x9a978c); g.fillRect(8,4,5,4); g.fillStyle(0x2c2c36); g.fillRect(0,8,14,2); });
  // Gemini-suit skeleton: lore dressing along the trail and around the nest
  T('bones',16,12,g=>{ g.fillStyle(0xb8b3a4); g.fillRect(5,0,6,5);
    g.fillStyle(0x8a8798); g.fillRect(6,1,4,3);
    g.fillStyle(0xb8b3a4); g.fillRect(3,6,10,2); g.fillRect(2,9,5,2); g.fillRect(9,9,5,2); });
  // blinking exit waypoint
  T('beacon',10,16,g=>{ g.fillStyle(0x2c2c36); g.fillRect(3,6,4,10);
    g.fillStyle(0x6ba0e8); g.fillRect(2,0,6,6); g.fillStyle(0xd8f0ff); g.fillRect(3,1,4,3); });
  // red trail marker — the drag-mark leading out of the empty camp
  T('trail',10,6,g=>{ g.fillStyle(0x6e1a1a,0.85); g.fillEllipse(5,3,9,5);
    g.fillStyle(0x8f2222,0.7); g.fillEllipse(5,3,5,3); });

  // meteor telegraph. Its own texture rather than a tinted flareGlow, which is
  // the checkpoint colour — teaching that a lethal ring is a safe one would be
  // actively harmful. Drawn at exactly TUNE.meteor.radius, and never resized,
  // so the ring can't lie about where the damage lands.
  T('target',32,32,g=>{
    g.lineStyle(2,0xd4302a,0.95); g.strokeCircle(16,16,14);
    g.lineStyle(2,0xd4302a,0.6);
    g.lineBetween(16,0,16,6);   g.lineBetween(16,26,16,32);
    g.lineBetween(0,16,6,16);   g.lineBetween(26,16,32,16);
  });
  // impact scar — deliberately NOT crater-shaped, so a cosmetic mark is never
  // mistaken for a hazard you have to jump
  T('impact',24,16,g=>{
    g.fillStyle(0x1a1016); g.fillEllipse(12,8,22,13);
    g.fillStyle(0x2a1a1e); g.fillEllipse(12,8,12,7);
    g.fillStyle(0x0e0e14); g.fillEllipse(12,8,5,3);
  });

  // big red "definitely nothing here" arrows — plain triangles, drawn separately
  // per direction (rather than flipping one texture) so each can use an origin
  // set to its own visual centroid, keeping it aligned under the sign text
  T('arrowR',24,20,g=>{ g.fillStyle(0xd4302a); g.beginPath();
    g.moveTo(0,0); g.lineTo(24,10); g.lineTo(0,20); g.closePath(); g.fillPath(); });
  T('arrowL',24,20,g=>{ g.fillStyle(0xd4302a); g.beginPath();
    g.moveTo(24,0); g.lineTo(0,10); g.lineTo(24,20); g.closePath(); g.fillPath(); });

  g.destroy();
}

/* ------------------------------ scene ----------------------------------- */
class LevelScene extends Phaser.Scene {
  constructor(cfg){ super(cfg.id); this.cfg = cfg; }

  create(){
    scene = this;
    const cfg = this.cfg;
    // reset state
    Object.assign(S,{ o2:TUNE.o2Max, hp:TUNE.hpMax, flares:TUNE.startFlares, checkpoint:null,
      hasClub:cfg.start.hasClub, hasFlag:cfg.start.hasFlag, hasCompanion:false, phase:0, airborne:false, facing:{x:0,y:1}, paused:false,
      dead:false, won:false, deathCause:null, startTime:this.time.now, deaths:0 });
    ui.dead.style.display='none'; ui.win.style.display='none'; hideDialog();
    setDeathArt(null);   // a restart must not flash the previous run's art

    makeTextures(this);
    const W=1280, H=1900;
    this.physics.world.setBounds(0,0,W,H);
    this.add.tileSprite(W/2,H/2,W,H,'ground');

    // starfield vignette at top edge (cosmetic)
    for(let i=0;i<40;i++){ this.add.rectangle(Phaser.Math.Between(0,W),Phaser.Math.Between(0,40),2,2,0xd8d3c4,0.5); }

    // ---- groups
    this.cliffs = this.physics.add.staticGroup();   // never passable
    this.hazards = this.physics.add.staticGroup();  // craters/fissures — jumpable
    this.rocks = this.physics.add.staticGroup();    // destructible boulders
    this.tanks = this.physics.add.staticGroup();
    this.flarePickups = this.physics.add.staticGroup();
    // dynamic, unlike the rest — Level 3's buildTerrain creates and fills it,
    // and it stays null on the surface levels
    this.enemies = null;

    // ---- player (invisible physics base + visual sprite + shadow)
    this.base = this.physics.add.image(cfg.spawn.x,cfg.spawn.y,'shadow').setVisible(false);
    this.base.body.setSize(12,8); this.base.setCollideWorldBounds(true); this.base.setDamping(true).setDrag(0.0008);
    this.shadow = this.add.image(0,0,'shadow');
    this.player = this.add.image(0,0,'astro').setScale(2);
    this.z = 0;

    // ---- lander (solid) + NPCs. Level 3 is underground and has no lander,
    // so this is guarded the same way the golf ball below already is.
    this.lander = null;
    if(cfg.lander){
      const L = cfg.lander;
      this.lander = this.physics.add.staticImage(L.x,L.y,L.tex).setScale(2).setDepth(L.y);
      this.lander.refreshBody();
    }
    cfg.npcs.forEach(p=> this.addNPC(p[0],p[1]));

    // golf ball
    this.ball = null;
    if(cfg.ball){
      this.ball = this.physics.add.image(cfg.ball.x,cfg.ball.y,'ball').setScale(2);
      this.ball.setDamping(true).setDrag(0.02).setBounce(0.6).setCollideWorldBounds(true);
      this.physics.add.collider(this.ball,this.cliffs);
      this.physics.add.collider(this.ball,this.rocks);
    }

    /* ---- course layout. Levels 1 and 2 share the surface corridor and set no
       buildTerrain, so they fall through to the block below exactly as before.
       Level 3 is underground and supplies its own, keeping its whole layout in
       one place rather than littering this block with per-level branches. */
    if(cfg.buildTerrain){
      cfg.buildTerrain(this, W, H);
    } else {
    this.buildWalls(W,H);

    // tanks placed right after the oxygen tutorial line, before the craters
    this.spawnTank(480,1550); this.spawnTank(790,1600);

    // jump-tutorial craters
    this.hazard('crater',490,1620); this.hazard('crater',410,1650); this.hazard('crater',572,1650); this.hazard('crater',700,1650); this.hazard('crater',790,1665); this.hazard('crater',880,1645);

    // crater field — checkerboard: craters on the "black" squares, open
    // ground on the "white" ones. Crater hitboxes are 75x50, so spacing
    // them closer than that on each axis makes diagonal neighbors' boxes
    // overlap at the corners — no gap to sneak through, only jump over.
    const cfCols=[400,465,530,595,660,725,790,855], cfRows=[1150,1190,1230,1270,1310,1350];
    cfRows.forEach((y,ri)=>cfCols.forEach((x,ci)=>{
      if((ci+ri)%2===0) this.hazard('crater',x,y);
    }));

    // fissures (must jump) — each row spans the full corridor width with
    // slight overlap between bars, so there's no gap to walk around; three
    // rows means three mandatory hops to cross the trench section
    const trCols=[430,560,690,820], trRows=[920,1000,1080];
    trRows.forEach(y=>trCols.forEach(x=>this.hazard('fissure',x,y)));

    // destructible boulders — per level, since Level 2's gates are already
    // smashed and its rubble sits elsewhere
    cfg.rocks.forEach(p=>this.spawnRock(p[0],p[1]));

    // ridge gauntlet — post-flag climb to the summit, mixing all three
    // hazard types so the final stretch takes some jumping, some rock
    // breaking, or both
    // tier 1: fissure barrier — jump only
    [[430,680],[560,680],[690,680],[820,680]].forEach(p=>this.hazard('fissure',p[0],p[1]));
    // (tier 2, the funnelled rock gate at y=560, comes from cfg.rocks above —
    //  its funnel walls are still built by buildWalls for both levels)
    // tier 3: crater barrier — jump only
    [400,470,540,610,680,750,820].forEach(x=>this.hazard('crater',x,440));
    // tier 4: final approach — rocks block the west side, craters the east,
    // so the last stretch is whichever mix of jumping and breaking you pick
    [400,435,470,505,540,575,610].forEach(x=>this.spawnRock(x,370));
    [650,720,790,860].forEach(x=>this.hazard('crater',x,370));

    // extra tanks + bonus flare along route
    this.spawnTank(895,1140); this.spawnTank(430,960); this.spawnTank(640,620);
    const fp = this.flarePickups.create(500,860,'flare').setScale(2); fp.refreshBody();

    // secret tunnels: reward chambers (oxygen tank + lore marker in each)
    this.spawnTank(185,650);
    this.add.image(150,650,'plaque').setScale(2).setDepth(650);
    this.spawnTank(1115,350);
    this.add.image(1150,350,'plaque').setScale(2).setDepth(350);
    }  // end shared surface layout

    // goal zone — the summit on Level 1; Level 2 ends via a trigger instead
    this.goalZone = null;
    if(cfg.goal.rect){
      this.goalZone = new Phaser.Geom.Rectangle(...cfg.goal.rect);
      const m = cfg.goal.marker;
      if(m) this.add.rectangle(m.x,m.y,m.w,m.h).setStrokeStyle(1,0xc9a227,0.35);
    }

    // ---- colliders
    this.physics.add.collider(this.base,this.cliffs);
    if(this.lander) this.physics.add.collider(this.base,this.lander);
    this.physics.add.collider(this.base,this.rocks);
    this.physics.add.collider(this.base,this.hazards,null,()=> this.z===0);
    this.physics.add.overlap(this.base,this.tanks,(b,t)=>{ if(S.o2<TUNE.o2Max-1){ S.o2=Math.min(TUNE.o2Max,S.o2+TUNE.o2Max*TUNE.tankRefillPct); this.pop(t.x,t.y,'+O2',0x6ba0e8); t.destroy(); }});
    this.physics.add.overlap(this.base,this.flarePickups,(b,f)=>{ S.flares++; this.pop(f.x,f.y,'+FLARE',0xffd54a); f.destroy(); });

    // ---- camera
    this.cameras.main.setBounds(0,0,W,H).startFollow(this.base,true,0.12,0.12);
    this.cameras.main.setZoom(1.4);

    // ---- input
    // K1/K2 back the branching-choice dialogue (ONE/TWO are the digit-row keys)
    this.keys = this.input.keyboard.addKeys(
      {W:'W',A:'A',S:'S',D:'D',UP:'UP',DOWN:'DOWN',LEFT:'LEFT',RIGHT:'RIGHT',
       SPACE:'SPACE',J:'J',F:'F',E:'E',K1:'ONE',K2:'TWO'});
    this.lastSwing = 0; this.dlgGuard = 0;

    // ---- dialogue triggers (drain pauses while open)
    // Copied per run so `fired` never leaks across a restart.
    this.triggers = cfg.triggers.map(t=>Object.assign({},t));
    this.triggers.forEach(t=>t.fired=false);

    // ---- meteor shower. Arrays are rebuilt here rather than relied on to
    // survive: scene.restart() destroys the game objects but leaves these
    // holding dead references.
    this.meteorsOn = !!cfg.meteors;
    this.meteors = [];
    this.scars = [];
    this.meteorTimer = TUNE.meteor.grace;
    this.lastMeteorHit = 0;

    // ---- Level 3: darkness, enemies, companion. Same rebuild-in-create rule
    // as the meteors: a restart must not leave stale sprite references behind.
    this.dark = null; this.companion = null; this.nestGate = [];
    this.swingCostMult = 1;
    if(cfg.dark) this.buildDarkness();
    if(this.enemies){
      this.physics.add.collider(this.base,this.enemies);
      this.physics.add.collider(this.enemies,this.cliffs);
      this.physics.add.overlap(this.base,this.enemies,(b,e)=>{
        const C = e.isBoss ? TUNE.boss : TUNE.crawler;
        if(this.time.now - e.lastTouch < C.contactCooldown) return;
        e.lastTouch = this.time.now;
        this.damage(C.damage, e.isBoss?'it':'crawler');
        this.cameras.main.shake(90,0.005);
        this.pop(this.base.x,this.base.y-24,'-'+C.damage,0xb3202a);
      });
    }

    this.updateHUD();
    setHint('');
  }

  /* ---------- helpers ---------- */
  addNPC(x,y){ const n=this.add.image(x,y,'astroN').setScale(2).setDepth(y);
    this.add.image(x,y+16,'shadow'); return n; }
  hazard(key,x,y){ const h=this.hazards.create(x,y,key).setScale(TUNE.hazardScale); h.refreshBody(); h.setDepth(1); }
  spawnRock(x,y){ const r=this.rocks.create(x,y,'boulder').setScale(2); r.refreshBody(); r.hp=2; r.setDepth(y); }
  spawnTank(x,y){ const t=this.tanks.create(x,y,'tank').setScale(2); t.refreshBody(); t.setDepth(y); }
  buildWalls(W,H){
    const step=48;
    const wall=(x,y)=>{ const c=this.cliffs.create(x,y,'cliff').setScale(2); c.refreshBody(); c.setDepth(2); };
    const baffle=(x0,x1,y)=>{ for(let x=x0;x<=x1;x+=step) wall(x,y); };
    const OUT_W=60, OUT_E=1220, COR_W=320, COR_E=950;
    // gaps left in the corridor walls where the secret tunnels breach through
    const westBreach=[1284,1332], eastBreach=[996,1044];

    // corridor walls, skipping the breach points (boulders go there instead)
    for(let y=180;y<H;y+=step){
      if(!westBreach.includes(y)) wall(COR_W,y);
      if(!eastBreach.includes(y)) wall(COR_E,y);
    }
    // outer boundary — seals the margins so the side channels are only
    // reachable through the breach, not by walking around the map edge
    for(let y=180;y<H;y+=step){ wall(OUT_W,y); wall(OUT_E,y); }
    // top cap, now full width to seal both side channels from above
    for(let x=OUT_W;x<=OUT_E;x+=step) wall(x,180);
    // funnel pinches before the main rock chokepoint
    [[380,760],[430,760],[480,760],[530,760],[860,760],[810,760],[760,760],[710,760]].forEach(p=>wall(p[0],p[1]));
    // funnel pinch for the second rock gate in the post-flag ridge gauntlet
    [[380,560],[430,560],[480,560],[530,560],[860,560],[810,560],[760,560],[710,560]].forEach(p=>wall(p[0],p[1]));

    // west tunnel: zigzag baffles forcing a winding path
    baffle(60,240,1150);
    baffle(170,320,980);
    baffle(60,240,800);
    // east tunnel: zigzag baffles, mirrored
    baffle(1030,1220,850);
    baffle(950,1140,680);
    baffle(1030,1220,500);

    // boulders blocking each tunnel entrance — break with the club to enter
    [[COR_W,1284],[COR_W,1332]].forEach(p=>this.spawnRock(p[0],p[1]));
    [[COR_E,996],[COR_E,1044]].forEach(p=>this.spawnRock(p[0],p[1]));

    // "totally not secret tunnels" signage, pointing at the rocks hiding each breach
    // (text and arrow sit side by side on one row so the sign reads horizontally)
    this.add.image(355,1308,'arrowL').setOrigin(0.667,0.5).setScale(1.3).setDepth(1308);
    this.add.text(375,1308,'DEFINITELY NO SECRETS AHEAD',{fontFamily:'monospace',fontSize:'10px',color:'#d4302a'}).setOrigin(0,0.5).setDepth(1308);

    this.add.text(895,1020,'DEFINITELY NO SECRETS AHEAD',{fontFamily:'monospace',fontSize:'10px',color:'#d4302a'}).setOrigin(1,0.5).setDepth(1020);
    this.add.image(915,1020,'arrowR').setOrigin(0.333,0.5).setScale(1.3).setDepth(1020);
  }
  /* ---------- meteor shower ----------
     Driven entirely from update(), never from Phaser timers or tweens. That
     is deliberate: update() already returns early on death, win and dialogue
     (see its first two blocks), so meteors inherit all three gates for free.
     A time.addEvent scheduler would keep raining rocks onto the death screen
     and detonate mid-dialogue, when input is swallowed and the player cannot
     dodge — unavoidable damage. Frozen mid-telegraph is the correct pause
     behaviour: 0.4s from impact when a trigger fires is still 0.4s from
     impact when it is dismissed. */
  clearMeteors(){
    this.meteors.forEach(m=>{ m.ring.destroy(); m.clock.destroy(); m.rock.destroy(); });
    this.meteors.length = 0;
    this.meteorTimer = TUNE.meteor.grace;
    this.lastMeteorHit = 0;
  }
  addScar(x,y){
    // Cosmetic only. Real hazards here would seal the corridor: at ~30 strikes
    // a minute, random craters reach the crater-field's own "no gap to sneak
    // through" density within a minute, and a walled-in player just suffocates.
    const s = this.add.image(x,y,'impact').setScale(2).setDepth(0).setAlpha(0.7);
    this.scars.push(s);
    if(this.scars.length > TUNE.meteor.maxScars) this.scars.shift().destroy();
  }
  addMeteor(x,y,i){
    const M = TUNE.meteor;
    x = Phaser.Math.Clamp(x, 350, 920);    // corridor interior, walls at 320/950
    y = Phaser.Math.Clamp(y, 200, 1880);
    const t = M.tell + i*M.stagger;
    const ring  = this.add.image(x,y,'target').setDepth(1)
                      .setDisplaySize(M.radius*2, M.radius*2);
    const clock = this.add.circle(x,y,M.radius,0xd4302a,0.22).setDepth(1).setScale(0);
    const rock  = this.add.image(x, y-M.fallH, 'boulder').setScale(1).setDepth(9997);
    this.meteors.push({x,y,t,t0:t,ring,clock,rock});
  }
  spawnVolley(){
    const M = TUNE.meteor, b = this.base, v = b.body.velocity, J = M.aimJitter;
    // one aimed strike, led half a telegraph along the player's heading, with
    // enough jitter that it usually lands near them rather than exactly on them
    this.addMeteor(b.x + v.x*M.tell*M.lead + Phaser.Math.Between(-J,J),
                   b.y + v.y*M.tell*M.lead + Phaser.Math.Between(-J,J), 0);
    // the rest land on a lattice snapped around the player, so standing still
    // is never safe either
    const G = M.grid;
    const gx = Math.round(b.x/G)*G, gy = Math.round(b.y/G)*G;
    const cells = Phaser.Utils.Array.Shuffle(
      [[-2,-1],[-1,-2],[1,-2],[2,-1],[-2,1],[-1,2],[1,2],[2,1],[-1,-1],[1,1],[-1,1],[1,-1]]);
    for(let i=1;i<M.perVolley;i++){
      const c = cells[i-1];
      this.addMeteor(gx + c[0]*G, gy + c[1]*G, i);
    }
  }
  meteorImpact(time, m){
    const M = TUNE.meteor;
    m.ring.destroy(); m.clock.destroy(); m.rock.destroy();
    this.addScar(m.x, m.y);
    const d = Phaser.Math.Distance.Between(this.base.x, this.base.y, m.x, m.y);
    // shake scales with proximity and stops entirely far off — 30+ full-strength
    // shakes a minute would be unplayable
    if(d < 150 && !REDUCED_MOTION) this.cameras.main.shake(110, 0.006*(1-d/150));
    // i-frames matter: without them a volley landing around a cornered player
    // deals 3x55% at once, which is death with no counterplay
    if(d < M.radius && time - this.lastMeteorHit > M.iFrames){
      this.lastMeteorHit = time;
      this.damage(TUNE.hpMax*M.dmgPct, 'meteor');
      S.o2 = Math.max(0, S.o2-4);
      this.pop(this.base.x, this.base.y-24, 'DIRECT HIT', 0xb3202a);
    }
  }
  updateMeteors(time, sec){
    if(!this.meteorsOn) return;
    const M = TUNE.meteor;
    for(let i=this.meteors.length-1; i>=0; i--){
      const m = this.meteors[i];
      m.t -= sec;
      if(m.t > 0){
        const p = 1 - m.t/m.t0;                 // 0 -> 1 as impact nears
        m.ring.setAlpha(0.30 + 0.55*p);         // brightens, never resizes
        m.clock.setScale(p);                    // the filled circle is the clock
        m.rock.setPosition(m.x, m.y - M.fallH*(1-p)).setScale(1 + 0.9*p);
        continue;
      }
      this.meteorImpact(time, m);
      this.meteors.splice(i,1);
    }
    // Side tunnels are shelter: a breather, a reward for having found them in
    // Level 1, and it avoids meteors detonating against cliffs off-screen.
    if(this.base.x < M.shelter[0] || this.base.x > M.shelter[1]){
      this.meteorTimer = Math.max(this.meteorTimer, 0.4);  // brief re-arm on exit
      return;
    }
    this.meteorTimer -= sec;
    if(this.meteorTimer <= 0){
      this.meteorTimer = Phaser.Math.FloatBetween(M.gapMin, M.gapMax);
      this.spawnVolley();
    }
  }

  /* ---------- Level 3: darkness + flashlight ----------
     A dark rectangle locked to the camera, with the beam punched through it in
     ERASE blend mode. Chosen over Phaser's Light2D pipeline because that would
     mean opting every shared texture helper into a pipeline — reaching into
     Levels 1 and 2's rendering for no benefit to them. */
  buildDarkness(){
    const F = TUNE.flashlight;
    this.dark = this.add.renderTexture(0,0,840,620)
      .setOrigin(0,0).setScrollFactor(0).setDepth(9000);
    this.beam = this.make.image({key:'lightBlob', add:false}).setOrigin(0.5,0.5);
    this.halo = this.make.image({key:'lightBlob', add:false}).setOrigin(0.5,0.5)
      .setScale(F.halo/64);
  }
  updateDarkness(){
    if(!this.dark) return;
    const F = TUNE.flashlight, cam = this.cameras.main;
    // screen-space position of the player, since the overlay doesn't scroll
    const sx = (this.base.x - cam.worldView.x) * cam.zoom;
    const sy = (this.base.y - cam.worldView.y) * cam.zoom;
    this.dark.clear();
    this.dark.fill(0x04040a, F.ambient);
    // a small always-lit halo, so you can see your own feet
    this.dark.erase(this.halo, sx, sy);
    // the cone: overlapping blobs marching out along facing, widening as they go
    const f = S.facing, ang = Math.atan2(f.y, f.x);
    const half = Phaser.Math.DegToRad(F.coneDeg)/2;
    const steps = 7;
    for(let i=1;i<=steps;i++){
      const t = i/steps, d = F.range*t*cam.zoom;
      const spread = Math.tan(half)*d;
      const w = Math.max(28, spread*1.5);
      this.beam.setScale(w/64);
      for(let s=-1;s<=1;s++){
        this.beam.setAlpha(1 - 0.25*Math.abs(s));
        this.dark.erase(this.beam,
          sx + Math.cos(ang)*d - Math.sin(ang)*spread*s*0.6,
          sy + Math.sin(ang)*d + Math.cos(ang)*spread*s*0.6);
      }
    }
  }

  /* ---------- Level 3: crawlers ----------
     State lives on the sprite, the way spawnRock already hangs `hp` on rocks.
     Driven from update() like the meteors, so it inherits the dead/won/paused
     gates for free. */
  spawnCrawler(x,y,boss){
    const C = boss ? TUNE.boss : TUNE.crawler;
    const e = this.enemies.create(x,y, boss?'crawlerBoss':'crawler');
    e.setScale(boss?3.4:2).setDepth(y).setCollideWorldBounds(true);
    e.body.setSize(14,18);
    e.hp = C.hp; e.isBoss = !!boss; e.lastTouch = 0;
    e.state = 'idle'; e.stateAt = 0;
    e.home = {x,y};
    return e;
  }
  updateCrawlers(time, sec){
    if(!this.enemies) return;
    const px = this.base.x, py = this.base.y;
    this.enemies.getChildren().forEach(e=>{
      const C = e.isBoss ? TUNE.boss : TUNE.crawler;
      const d = Phaser.Math.Distance.Between(e.x,e.y,px,py);
      e.setDepth(e.y);

      if(e.isBoss){
        // wind up -> lunge -> rest, so the player gets a fair read on it
        if(e.state==='idle' && d < C.aggroRadius){ e.state='wind'; e.stateAt=time; }
        else if(e.state==='wind'){
          e.setTint(time%160<80 ? 0xff6a5a : 0xffffff);
          if(time-e.stateAt > C.telegraphMs){
            e.state='lunge'; e.stateAt=time; e.clearTint();
            this.physics.moveTo(e, px, py, C.lungeSpeed);
          }
        }
        else if(e.state==='lunge' && time-e.stateAt > C.lungeMs){
          e.state='rest'; e.stateAt=time; e.setVelocity(0,0);
        }
        else if(e.state==='rest' && time-e.stateAt > C.restMs){ e.state='idle'; }
        return;
      }

      if(e.state==='idle'){
        e.setVelocity(0,0);
        if(d < C.aggroRadius) e.state='chase';
      } else {
        if(d > C.loseRadius){ e.state='idle'; e.setVelocity(0,0); return; }
        this.physics.moveTo(e, px, py, C.speed);
      }
    });
  }
  hurtEnemy(e, n){
    e.hp -= n;
    if(e.hp > 0){ e.setTint(0x9a4a4a); this.time.delayedCall(120,()=>e.active&&e.clearTint()); return; }
    this.pop(e.x,e.y, e.isBoss?'IT FALLS':'KILLED', 0xd8d3c4);
    if(e.isBoss) this.onBossDown();
    e.destroy();
  }
  onBossDown(){
    // the nest's exit is walled while it lives — drop those tiles now
    (this.nestGate||[]).forEach(w=>w.destroy());
    this.nestGate = [];
    S.phase = 2;                 // unlocks Mayo's Carry/Leave trigger
    this.cameras.main.shake(500,0.006);
    setHint('THE WAY OUT IS OPEN');
  }

  pop(x,y,txt,color){
    const t=this.add.text(x,y,txt,{fontFamily:'monospace',fontSize:'12px',color:'#'+color.toString(16).padStart(6,'0')}).setOrigin(0.5).setDepth(9999);
    this.tweens.add({targets:t,y:y-24,alpha:0,duration:900,onComplete:()=>t.destroy()});
  }

  /* ---------- dialogue ---------- */
  showTrigger(t){
    t.fired=true; S.paused=true; this.dlgGuard=this.time.now+350;
    ui.dlgWho.textContent=t.who; ui.dlgText.textContent=t.text; ui.dlg.style.display='block';
    this.pendingGive=t.give||null;
    this.pendingWin=!!t.win;
    this.pendingEffect=t.effect||null;   // arbitrary story beat on dismiss
    /* A trigger carrying `choices` swaps the "E — CONTINUE" prompt for numbered
       options and waits on 1/2 instead of E. Everything else about the box —
       the pause, the speaker, the drain freeze — is reused untouched. */
    this.pendingChoices = t.choices || null;
    ui.dlgPress.textContent = this.pendingChoices
      ? this.pendingChoices.map(c=>c.key+' — '+c.label).join('    ')
      : 'E — CONTINUE';
  }
  dismissDialog(choice){
    // with choices open, only a valid choice closes the box
    if(this.pendingChoices && !choice) return;
    ui.dlg.style.display='none'; S.paused=false;
    ui.dlgPress.textContent='E — CONTINUE';
    if(this.pendingGive==='club'){ S.hasClub=true; this.pop(this.base.x,this.base.y-30,'CLUB GET',0xc9a227); }
    if(this.pendingGive==='flag'){ S.hasFlag=true; this.pop(this.base.x,this.base.y-30,'FLAG GET',0xb3202a); }
    this.pendingGive=null;
    if(this.pendingEffect){ const f=this.pendingEffect; this.pendingEffect=null; f(this); }
    if(choice && choice.effect) choice.effect(this);
    this.pendingChoices=null;
    // a trigger flagged win:true ends the level once its line is dismissed
    if(this.pendingWin){ this.pendingWin=false; this.winLevel(); }
  }

  /* ---------- Level 3: the companion, if you carried him ---------- */
  spawnCompanion(){
    this.companion = this.add.image(this.base.x, this.base.y+20,'astroN').setScale(2);
    S.hasCompanion = true;
  }
  updateCompanion(sec){
    if(!this.companion) return;
    const lag = TUNE.companion.followLag;
    const dx = this.base.x - this.companion.x, dy = this.base.y - this.companion.y;
    const d = Math.hypot(dx,dy);
    if(d > lag){
      const k = Math.min(1, (d-lag)/d * sec*6);
      this.companion.x += dx*k; this.companion.y += dy*k;
    }
    this.companion.setDepth(this.companion.y);
  }

  /* ---------- death / respawn / win ---------- */
  /* Every source of damage goes through here so the killing blow records itself.
     The early return is the point: once HP is at zero the cause is locked, so a
     crater fall that kills you while O2 already reads zero reports the fall
     rather than being relabelled suffocation by the next drain tick. */
  damage(amount, cause){
    if(S.hp<=0) return;
    S.hp = Math.max(0, S.hp - amount);
    if(S.hp<=0) S.deathCause = cause;
  }
  die(cause){
    if(S.dead||S.won) return;
    S.dead=true; S.deaths++;
    const d = DEATHS[cause] || DEATHS.unknown;
    ui.deadReason.textContent = d.reason;
    setDeathArt(d.img);
    document.getElementById('btnRespawn').textContent = S.checkpoint ? 'RESPAWN AT FLARE' : 'RESPAWN AT LANDER';
    ui.dead.style.display='flex';
  }
  respawn(){
    const p=S.checkpoint||this.cfg.spawn;
    this.base.setPosition(p.x,p.y); this.base.setVelocity(0,0);
    S.hp=TUNE.hpMax; S.o2=TUNE.o2Max*(parseInt(ui.respawnO2.value,10)/100);
    S.dead=false; S.deathCause=null; ui.dead.style.display='none';
    // drop anything still in the air, or a strike queued before you died lands
    // on the respawned player instantly
    this.clearMeteors();
  }
  winLevel(){
    if(S.won) return; S.won=true;
    const secs=Math.round((this.time.now-S.startTime)/1000);
    if(this.cfg.goal.mode==='plantFlag'){
      const flag=this.add.image(this.base.x,this.base.y-14,'flag').setScale(2).setDepth(9999);
      this.tweens.add({targets:flag,y:flag.y-6,duration:300,yoyo:true});
    }
    ui.winStats.textContent=`Time ${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')} · Deaths ${S.deaths} · Flares left ${S.flares}`;
    this.time.delayedCall(700,()=>{ ui.win.style.display='flex'; this.cameras.main.shake(600,0.004); });
  }

  /* ---------- per-frame ---------- */
  update(time,dt){
    if(S.dead||S.won){ this.base.setVelocity(0,0); this.syncVisuals(); return; }
    const k=this.keys, sec=dt/1000;

    // dialogue handling
    if(S.paused){
      this.base.setVelocity(0,0);
      if(time>this.dlgGuard){
        if(this.pendingChoices){
          // 1/2 pick a branch; E is deliberately inert so you can't skip past it
          for(const c of this.pendingChoices){
            if(Phaser.Input.Keyboard.JustDown(this.keys['K'+c.key])){ this.dismissDialog(c); break; }
          }
        } else if(Phaser.Input.Keyboard.JustDown(k.E)) this.dismissDialog();
      }
      this.syncVisuals(); this.updateHUD(); return;
    }
    for(const t of this.triggers){
      if(!t.fired && (!t.cond||t.cond()) &&
         Phaser.Math.Distance.Between(this.base.x,this.base.y,t.x,t.y)<t.r){ this.showTrigger(t); break; }
    }

    // movement
    let vx=0,vy=0;
    if(k.A.isDown||k.LEFT.isDown)vx=-1; else if(k.D.isDown||k.RIGHT.isDown)vx=1;
    if(k.W.isDown||k.UP.isDown)vy=-1; else if(k.S.isDown||k.DOWN.isDown)vy=1;
    // carrying the companion slows you down
    const spd = TUNE.moveSpeed * (S.hasCompanion ? TUNE.companion.speedMult : 1);
    if(vx||vy){ const n=Math.hypot(vx,vy); S.facing={x:vx/n,y:vy/n};
      this.base.setVelocity(vx/n*spd, vy/n*spd);
    } else this.base.setVelocity(0,0);

    // jump
    if(Phaser.Input.Keyboard.JustDown(k.SPACE) && !S.airborne){
      S.airborne=true; S.o2=Math.max(0,S.o2-TUNE.jumpCost);
      this.tweens.addCounter({from:0,to:Math.PI,duration:TUNE.jumpMs,
        onUpdate:tw=>{ this.z=Math.sin(tw.getValue())*TUNE.jumpHeight; },
        onComplete:()=>{ this.z=0; S.airborne=false;
          // landed inside a hazard? take a tumble + O2 hit, nudge out
          const hit=this.hazards.getChildren().find(h=>Phaser.Math.Distance.Between(h.x,h.y,this.base.x,this.base.y)<TUNE.hazardMissRadius);
          if(hit){ this.damage(TUNE.hpMax*TUNE.craterFallPct,'fall'); S.o2=Math.max(0,S.o2-4);
            this.cameras.main.shake(120,0.006); this.pop(this.base.x,this.base.y-24,'ROUGH LANDING',0xb3202a);
            this.base.setPosition(this.base.x,hit.y+34); }
        }});
    }

    // swing
    if(Phaser.Input.Keyboard.JustDown(k.J) && S.hasClub && !S.airborne && time-this.lastSwing>TUNE.swingCooldown){
      this.lastSwing=time; S.o2=Math.max(0,S.o2-TUNE.swingCost*this.swingCostMult);
      const sx=this.base.x+S.facing.x*18, sy=this.base.y-8+S.facing.y*18;
      const arc=this.add.image(sx,sy,'swing').setScale(2).setDepth(9998)
        .setRotation(Math.atan2(S.facing.y,S.facing.x));
      this.tweens.add({targets:arc,alpha:0,duration:180,onComplete:()=>arc.destroy()});
      // hit rocks
      this.rocks.getChildren().slice().forEach(r=>{
        if(Phaser.Math.Distance.Between(r.x,r.y,sx,sy)<TUNE.swingRange){
          r.hp--; this.cameras.main.shake(80,0.004);
          if(r.hp<=0){ this.pop(r.x,r.y,'CRACK',0xd8d3c4); r.destroy(); }
          else r.setTint(0x9a9aa8);
        }});
      // hit crawlers — the club is the only weapon, so it has to work on them
      if(this.enemies) this.enemies.getChildren().slice().forEach(e=>{
        if(Phaser.Math.Distance.Between(e.x,e.y,sx,sy)<TUNE.swingRange+8){
          this.cameras.main.shake(70,0.004); this.hurtEnemy(e,1);
        }});
      // hit ball — guarded: Level 3 has no ball
      if(this.ball && Phaser.Math.Distance.Between(this.ball.x,this.ball.y,sx,sy)<TUNE.swingRange){
        this.ball.setVelocity(S.facing.x*260,S.facing.y*260); this.pop(this.ball.x,this.ball.y,'FORE!',0xc9a227);
      }
    }

    // flare checkpoint
    if(Phaser.Input.Keyboard.JustDown(k.F)){
      if(S.flares>0){ S.flares--; S.checkpoint={x:this.base.x,y:this.base.y};
        this.add.image(this.base.x,this.base.y,'flareGlow').setDepth(1);
        this.add.image(this.base.x,this.base.y,'flare').setScale(2).setDepth(this.base.y-1);
        this.pop(this.base.x,this.base.y-24,'CHECKPOINT',0xffd54a);
      } else this.pop(this.base.x,this.base.y-24,'NO FLARES',0xb3202a);
    }

    // meteors — placed after the dead/won and paused early-returns above, so
    // they stop with everything else, and before the oxygen block below, so a
    // meteor kill is what gets reported rather than simultaneous asphyxiation
    this.updateMeteors(time, sec);
    this.updateCrawlers(time, sec);
    this.updateCompanion(sec);

    // goal zone (Level 1 plants the flag here; Level 2 has no zone and wins
    // from Mayo's trigger at the lander instead)
    const g = this.cfg.goal;
    const atGoal = this.goalZone &&
      Phaser.Geom.Rectangle.Contains(this.goalZone,this.base.x,this.base.y);
    if(atGoal && g.requires()){
      setHint(g.prompt);
      ui.hint.classList.add('flag-ready');
      if(Phaser.Input.Keyboard.JustDown(k.E) && time>this.dlgGuard) this.winLevel();
    } else {
      ui.hint.classList.remove('flag-ready');
      setHint(this.cfg.hint());
    }

    // oxygen economy
    const mult=(parseInt(ui.drainRate.value,10)/100)
      * (S.hasCompanion ? TUNE.companion.o2DrainMult : 1);
    S.o2=Math.max(0,S.o2-TUNE.drainPerSec*mult*sec);
    if(S.o2<=0){ this.damage(TUNE.suffocateHpPerSec*sec,'suffocate'); }
    if(S.hp<=0) this.die(S.deathCause || 'unknown');

    this.syncVisuals(); this.updateHUD(); this.updateDarkness();
  }

  syncVisuals(){
    this.shadow.setPosition(this.base.x,this.base.y+4).setScale(1.6-this.z/40);
    this.player.setPosition(this.base.x,this.base.y-14-this.z).setDepth(this.base.y);
  }
  updateHUD(){
    ui.hp.style.width=(S.hp/TUNE.hpMax*100)+'%';
    ui.o2.style.width=(S.o2/TUNE.o2Max*100)+'%';
    const low = S.o2 < 25;
    ui.o2.classList.toggle('low',low);
    ui.flares.textContent='FLARES ×'+S.flares;

    // optional countdown: how long the remaining oxygen actually lasts at the
    // current drain setting. Flashes once it drops under the same threshold
    // that already makes the bar blink.
    if(ui.o2Timer.checked){
      const rate = TUNE.drainPerSec * (parseInt(ui.drainRate.value,10)/100);
      ui.o2clock.style.display='block';
      if(rate > 0){
        const s = Math.max(0, Math.ceil(S.o2/rate));
        ui.o2clock.textContent = Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
      } else {
        ui.o2clock.textContent = '--:--';   // drain slider at zero
      }
      ui.o2clock.classList.toggle('low',low);
    } else {
      ui.o2clock.style.display='none';
    }
  }
}

/* ---------------- boot ---------------------------------------------------
   The level pages carry identical (inert) chrome markup; every string that
   differs between levels is written here from the config, so the config
   stays the single source of truth. */
function applyChrome(cfg){
  document.title = cfg.title;
  const el = document.getElementById('levelName');
  if(el) el.textContent = cfg.name;
  const wt = document.getElementById('winTitle');
  if(wt) wt.textContent = cfg.win.title;
  const wf = document.getElementById('winFlavor');
  if(wf) wf.textContent = cfg.win.flavor;
}

function startGame(n){
  const cfg = LEVELS[n];
  if(!cfg) throw new Error('Unknown level: '+n);
  applyChrome(cfg);
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: 840, height: 620,
    pixelArt: true,
    backgroundColor: '#0a0a12',
    physics: { default:'arcade', arcade:{ debug:false } },
    // Bind the config to the scene class. scene.restart() re-runs create()
    // on the same instance, so this.cfg survives a restart.
    scene: [ class extends LevelScene { constructor(){ super(cfg); } } ],
  });
}
