(function(){
  "use strict";

  // Pristine copy of this page, taken before the script adds a canvas, panels
  // or any runtime state. The HTML snapshot export starts from this copy so a
  // saved file re-opens cleanly (a serialized live DOM would carry a stale
  // canvas element and push the real scene off screen).
  var SNAPSHOT_SOURCE = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;

  // ---- Habitat switch (Pond | Open sea). The page is built ONCE for one habitat; switching
  // reloads with "#pond" or "#sea", so every geometry-dependent system is built cleanly. ----
  //   sea  : open ocean, phytoplankton producers -> INVERTED pyramid of biomass (default)
  //   pond : plant-rich pond, rooted plants + algae -> UPRIGHT pyramid of biomass
  // The pyramid of ENERGY is upright in both.
  // A saved HTML snapshot carries its edits in a small data block (script element id "tethysBaked",
  // setting window.TETHYS_BAKED),
  // placed in the page before this script: the habitat it was saved in, organism image links and
  // profile image links. Without it (the normal site) the built-in defaults are used.
  var BAKED = (window.TETHYS_BAKED && typeof window.TETHYS_BAKED === "object") ? window.TETHYS_BAKED : {};
  var ECO_DEFAULT_MODE = BAKED.mode === "pond" ? "pond" : "sea";   // a snapshot reopens in the habitat it was saved in
  var ECO_HASH = "";
  try { ECO_HASH = (window.location.hash || "").toLowerCase(); } catch (e) {}
  var ECO_MODE = ECO_HASH.indexOf("pond") !== -1 ? "pond" : (ECO_HASH.indexOf("sea") !== -1 ? "sea" : (ECO_DEFAULT_MODE === "pond" ? "pond" : "sea"));
  var IS_POND = ECO_MODE === "pond";
  // A switch carries the view across the reload (camera angle, selected level, graph, a pending import)
  // through sessionStorage. Only accepted if it targets THIS habitat and is fresh.
  var ECO_SWITCH_KEY = "tethys-trophicus-switch";
  var ECO_PENDING = null;
  try {
    var ecoRaw = window.sessionStorage.getItem(ECO_SWITCH_KEY);
    if (ecoRaw){
      var ecoObj = JSON.parse(ecoRaw);
      if (ecoObj && ecoObj.to === ECO_MODE && Math.abs(Date.now() - ecoObj.t) < 20000) ECO_PENDING = ecoObj;
      else window.sessionStorage.removeItem(ECO_SWITCH_KEY);
    }
  } catch (e) {}
  var ECO_SWITCHED = !!ECO_PENDING;   // arrived via the switch: don't show the intro card again
  var ecoSwitchTo = function(){ return false; };   // assigned by the habitat-switch module at the end

  // =========================================================
  // Coordinate system: Y = up, X = left/right, Z = depth.
  // AQUATIC FORK — INVERTED pyramid of biomass: narrow at the bottom
  // (phytoplankton, small standing crop) and widest at the top.
  // The (virtual) apex points DOWN, APEX_DEPTH below the floor, so TL1
  // keeps a usable width instead of collapsing to a point.
  //
  // Envelope (the "crucial geometry rule"): at any height y,
  //   halfWidth(y) = 6 * (y + 2.4) / 14.4
  //   halfDepth(y) = 3 * (y + 2.4) / 14.4
  // Every layer, gap and particle reads its bounds from this
  // single function so later phases (organisms, labels, etc.)
  // stay geometrically consistent with the shell.
  // =========================================================
  var TOTAL_HEIGHT = 12;
  var BASE_HALF_WIDTH = 6;
  var BASE_HALF_DEPTH = 3;

  var APEX_DEPTH = 2.4;   // the inverted apex sits at y = -2.4 (hidden below the sea floor)
  // Pond: the original upright envelope, 6 * (1 - y/12), apex at the top.
  function halfW(y){ return IS_POND ? BASE_HALF_WIDTH * (1 - y/TOTAL_HEIGHT) : BASE_HALF_WIDTH * (y + APEX_DEPTH) / (TOTAL_HEIGHT + APEX_DEPTH); }
  function halfD(y){ return IS_POND ? BASE_HALF_DEPTH * (1 - y/TOTAL_HEIGHT) : BASE_HALF_DEPTH * (y + APEX_DEPTH) / (TOTAL_HEIGHT + APEX_DEPTH); }
  function deg(d){ return THREE.MathUtils.degToRad(d); }

  // =========================================================
  // Data — trophic levels. Y ranges are the exact spec values;
  // width/depth at each boundary are DERIVED from the envelope
  // functions above (not hand-typed), so the taper is always
  // mathematically consistent with the outer pyramid shell.
  // =========================================================
  // biomassRef (g/m², dry weight): TL1 = 4 and TL2 = 21 follow Odum's classic English Channel figures
  // (small, fast-turnover phytoplankton crop supporting a larger zooplankton crop). TL3/TL4 are ILLUSTRATIVE
  // values that continue the inverted shape for teaching. ENERGY stays upright (100 -> 10 -> 1 -> 0.1):
  // a pyramid of energy can never be inverted.
  var TROPHIC_DATA = [
    { id:1, label:"Trophic Level 1", energy:100,  livingBiomass:100, biomassRef:4,   color:0x4ade80, glow:1.00, yBottom:0.4,  yTop:3.0  },
    { id:2, label:"Trophic Level 2", energy:10,   livingBiomass:100, biomassRef:21, color:0xfacc15, glow:0.75, yBottom:3.8,  yTop:6.0  },
    { id:3, label:"Trophic Level 3", energy:1,    livingBiomass:100, biomassRef:28, color:0xfb923c, glow:0.50, yBottom:6.8,  yTop:8.8  },
    { id:4, label:"Trophic Level 4", energy:0.1,  livingBiomass:100, biomassRef:35,  color:0xf87171, glow:0.30, yBottom:9.6,  yTop:11.2 }
  ];
  // Pond biomass (g/m² dry weight): Odum's Silver Springs data, producers 809 · herbivores 37 ·
  // carnivores 11 · top carnivores 1.5 — a classic UPRIGHT aquatic pyramid of biomass.
  var BIOMASS_REF = { sea: [4, 21, 28, 35], pond: [809, 37, 11, 1.5] };
  // Which values are ILLUSTRATIVE (not measured): open-sea TL3 + TL4 (indices). Marked on the graph and profile.
  var BIOMASS_ILLUSTRATIVE = { sea: [2, 3], pond: [] };
  BIOMASS_REF[ECO_MODE].forEach(function(v, i){ TROPHIC_DATA[i].biomassRef = v; });
  var GAP_ATTEN     = [1.0, 0.55, 0.30];
  var GAP_PARTICLES = [30, 16, 7];
  var GAP_SPEED     = [0.22, 0.19, 0.16];
  var GAP_LANES_Z   = [-0.62, -0.2, 0.2, 0.62]; // fractions of halfDepth(y), spread across the prism's depth

  // =========================================================
  // Build layout: layers[] (with derived corner dims) + gaps[]
  // =========================================================
  var layers = TROPHIC_DATA.map(function(def){
    return {
      def: def,
      yBottom: def.yBottom, yTop: def.yTop,
      wBottom: 2*halfW(def.yBottom), dBottom: 2*halfD(def.yBottom),
      wTop:    2*halfW(def.yTop),    dTop:    2*halfD(def.yTop)
    };
  });

  var gaps = [];
  for (var gi=0; gi<layers.length-1; gi++){
    gaps.push({
      index: gi,
      yBottom: layers[gi].yTop,
      yTop: layers[gi+1].yBottom,
      attenuation: GAP_ATTEN[gi],
      particleCount: GAP_PARTICLES[gi],
      flowSpeed: 2.0 + gi*0.4,
      driftSpeed: GAP_SPEED[gi],
      colorA: layers[gi].def.color,
      colorB: layers[gi+1].def.color
    });
  }

  // =========================================================
  // Geometry validation — Phase 1B
  //
  // Pure, read-only inspection of the layout built above. It
  // never touches THREE, rendering, camera or interaction code,
  // and never mutates layers/gaps — it only reports on them.
  // Toggle with DEV_MODE; console-only, so it never appears in
  // the student-facing view regardless of the flag.
  // =========================================================
  var DEV_MODE = true;
  var EPSILON = 0.001;

  var EXPECTED_LAYERS = [
    { id:1, yBottom:0.4, yTop:3.0 },
    { id:2, yBottom:3.8, yTop:6.0 },
    { id:3, yBottom:6.8, yTop:8.8 },
    { id:4, yBottom:9.6, yTop:11.2 }
  ];
  var EXPECTED_GAP = 0.8;
  var EXPECTED_APEX_CLEARANCE = 0.8;
  var EXPECTED_BASE_CLEARANCE = 0.4;

  function validateEcosystemGeometry(input){
    var vLayers = input.layers;
    var envelope = input.envelope;
    var tol = (input.tolerance !== undefined) ? input.tolerance : 0.001;
    var checks = [];

    function check(name, passed, actual, expected){
      checks.push({ name:name, passed:!!passed, actual:actual, expected:expected });
    }
    function approx(a, b, t){ return Math.abs(a-b) <= t; }

    // Recompute a layer's triangular corners independently of the
    // renderer's geometry builder, purely from its stored dims —
    // this is what makes containment/separation checks meaningful
    // rather than tautological.
    function triCorners(hw, hd, y){
      return {
        F: { x:0,            y:y, z: hd       },
        R: { x: 0.866*hw,    y:y, z:-0.5*hd   },
        L: { x:-0.866*hw,    y:y, z:-0.5*hd   }
      };
    }
    function layerAABB(layer){
      var hwB = layer.wBottom/2, hdB = layer.dBottom/2;
      var hwT = layer.wTop/2,    hdT = layer.dTop/2;
      var maxAbsX = Math.max(0.866*hwB, 0.866*hwT);
      var maxZ = Math.max(hdB, hdT);        // front tip, widest at top (inverted)
      var minZ = -0.5*Math.max(hdB, hdT);   // rear edge, widest at bottom
      return {
        xMin:-maxAbsX, xMax:maxAbsX,
        yMin: layer.yBottom, yMax: layer.yTop,
        zMin: minZ, zMax: maxZ
      };
    }
    function boxesOverlap(a, b){
      return (a.xMin <= b.xMax && a.xMax >= b.xMin) &&
             (a.yMin <= b.yMax && a.yMax >= b.yMin) &&
             (a.zMin <= b.zMax && a.zMax >= b.zMin);
    }

    // 1. Global envelope
    check("Global height", envelope.totalHeight === 12, envelope.totalHeight, 12);
    var yWide = IS_POND ? 0 : envelope.totalHeight, yApex = IS_POND ? envelope.totalHeight : -APEX_DEPTH;
    check("Widest width (" + (IS_POND ? "base" : "top") + ")", Math.abs(envelope.halfW(yWide)*2 - 12) < tol, envelope.halfW(yWide)*2, 12);
    check("Widest depth (" + (IS_POND ? "base" : "top") + ")", Math.abs(envelope.halfD(yWide)*2 - 6) < tol, envelope.halfD(yWide)*2, 6);
    check("Apex position (" + (IS_POND ? "upright" : "inverted") + ")", Math.abs(envelope.halfW(yApex)) < tol, "(0, " + yApex + ", 0)", IS_POND ? "(0, 12, 0)" : "(0, -2.4, 0)");

    // 2. Exactly four layers, correct/unique IDs
    var ids = vLayers.map(function(l){ return l.def.id; });
    var uniqueIds = ids.filter(function(v,i){ return ids.indexOf(v) === i; });
    check("Four trophic layers", vLayers.length === 4, vLayers.length, 4);
    check("No duplicate layer IDs", uniqueIds.length === ids.length, ids.join(","), "unique");
    check("Expected IDs [1,2,3,4]", ids.join(",") === "1,2,3,4", ids.join(","), "1,2,3,4");

    // 3 + 4. Y ranges, yBottom<yTop, ordering, no vertical overlap
    for (var i=0;i<vLayers.length;i++){
      var L = vLayers[i];
      var exp = EXPECTED_LAYERS[i] || {};
      check("TL"+L.def.id+" yBottom<yTop", L.yBottom < L.yTop, L.yBottom+"<"+L.yTop, "yBottom<yTop");
      check("TL"+L.def.id+" Y range matches spec",
        approx(L.yBottom, exp.yBottom, tol) && approx(L.yTop, exp.yTop, tol),
        "["+L.yBottom+","+L.yTop+"]", "["+exp.yBottom+","+exp.yTop+"]");
      if (i>0){
        var prev = vLayers[i-1];
        check("TL"+prev.def.id+" < TL"+L.def.id+" (no overlap)",
          L.yBottom >= prev.yTop, L.yBottom+" >= "+prev.yTop, "true");
      }
    }

    // 5. Gaps = 0.8
    for (var g=0; g<input.gaps.length; g++){
      var gap = input.gaps[g];
      var measured = gap.yTop - gap.yBottom;
      check("Gap "+(g+1)+" = 0.8", approx(measured, EXPECTED_GAP, tol),
        measured.toFixed(3), EXPECTED_GAP.toFixed(2)+" ± "+tol);
    }

    // 6. Apex clearance
    var tl4 = vLayers[vLayers.length-1];
    var apexClearance = envelope.totalHeight - tl4.yTop;
    check("Apex clearance = 0.8", approx(apexClearance, EXPECTED_APEX_CLEARANCE, tol),
      apexClearance.toFixed(3), EXPECTED_APEX_CLEARANCE.toFixed(2));

    // 7. Base clearance
    var tl1 = vLayers[0];
    var baseClearance = tl1.yBottom - 0;
    check("Base clearance = 0.4", approx(baseClearance, EXPECTED_BASE_CLEARANCE, tol),
      baseClearance.toFixed(3), EXPECTED_BASE_CLEARANCE.toFixed(2));

    // 8. Tapering + non-degenerate dims
    vLayers.forEach(function(L){
      if (IS_POND){
        check("TL"+L.def.id+" width tapers (bottom>=top)", L.wBottom >= L.wTop, L.wBottom+">="+L.wTop, "true");
        check("TL"+L.def.id+" depth tapers (bottom>=top)", L.dBottom >= L.dTop, L.dBottom+">="+L.dTop, "true");
      } else {
        check("TL"+L.def.id+" width widens upward (top>=bottom, inverted)", L.wTop >= L.wBottom, L.wTop+">="+L.wBottom, "true");
        check("TL"+L.def.id+" depth widens upward (top>=bottom, inverted)", L.dTop >= L.dBottom, L.dTop+">="+L.dBottom, "true");
      }
      check("TL"+L.def.id+" no zero/negative width", L.wBottom > 0 && L.wTop > 0, "wBottom="+L.wBottom+", wTop="+L.wTop, "> 0");
      check("TL"+L.def.id+" no zero/negative depth", L.dBottom > 0 && L.dTop > 0, "dBottom="+L.dBottom+", dTop="+L.dTop, "> 0");
    });

    // 9. Real 3D depth — distinct front/rear surfaces, not a flat plane
    vLayers.forEach(function(L){
      var cB = triCorners(L.wBottom/2, L.dBottom/2, L.yBottom);
      var cT = triCorners(L.wTop/2, L.dTop/2, L.yTop);
      var frontRearSpreadB = Math.abs(cB.F.z - cB.R.z);
      var frontRearSpreadT = Math.abs(cT.F.z - cT.R.z);
      check("TL"+L.def.id+" has distinct front/rear surfaces",
        frontRearSpreadB > EPSILON && frontRearSpreadT > EPSILON,
        "Δz(bottom)="+frontRearSpreadB.toFixed(3)+", Δz(top)="+frontRearSpreadT.toFixed(3), "> 0");
    });

    // 10. 3D separation via bounding-box intersection (not just Y)
    for (var s=1; s<vLayers.length; s++){
      var boxA = layerAABB(vLayers[s-1]);
      var boxB = layerAABB(vLayers[s]);
      var overlap = boxesOverlap(boxA, boxB);
      check("TL"+vLayers[s-1].def.id+" ∩ TL"+vLayers[s].def.id+" = empty",
        !overlap, overlap ? "intersecting" : "empty", "empty");
    }

    // 11. Envelope containment — every corner stays inside halfW/halfD
    vLayers.forEach(function(L){
      [
        { y:L.yBottom, hw:L.wBottom/2, hd:L.dBottom/2 },
        { y:L.yTop,    hw:L.wTop/2,    hd:L.dTop/2    }
      ].forEach(function(level){
        var c = triCorners(level.hw, level.hd, level.y);
        var envW = envelope.halfW(level.y);
        var envD = envelope.halfD(level.y);
        var pts = [c.F, c.R, c.L];
        var withinX = pts.every(function(p){ return Math.abs(p.x) <= envW + tol; });
        var withinZ = pts.every(function(p){ return Math.abs(p.z) <= envD + tol; });
        check("TL"+L.def.id+" y="+level.y+" within envelope",
          withinX && withinZ,
          "maxAbsX="+Math.max.apply(null,pts.map(function(p){return Math.abs(p.x);})).toFixed(3)+
          ", maxAbsZ="+Math.max.apply(null,pts.map(function(p){return Math.abs(p.z);})).toFixed(3),
          "<= ("+envW.toFixed(3)+", "+envD.toFixed(3)+")");
      });
    });

    var passed = checks.every(function(c){ return c.passed; });
    return { passed: passed, checks: checks };
  }

  function printValidationReport(result){
    var width = 46;
    var line = new Array(width+1).join("─");
    console.log("ECOSYSTEM GEOMETRY VALIDATION");
    console.log(line);
    result.checks.forEach(function(c){
      var mark = c.passed ? "✓" : "✗";
      console.log(mark + " " + c.name + (c.passed ? "" : ""));
      if (!c.passed){
        console.log("  Actual:   " + c.actual);
        console.log("  Expected: " + c.expected);
      }
    });
    console.log(line);
    console.log("RESULT: " + (result.passed ? "PASS" : "FAIL") +
      "  (" + result.checks.filter(function(c){return c.passed;}).length + "/" + result.checks.length + " checks)");
  }

  if (DEV_MODE){
    var validationResult = validateEcosystemGeometry({
      layers: layers,
      gaps: gaps,
      envelope: {
        totalHeight: TOTAL_HEIGHT,
        baseHalfWidth: BASE_HALF_WIDTH,
        baseHalfDepth: BASE_HALF_DEPTH,
        halfW: halfW,
        halfD: halfD
      },
      tolerance: EPSILON
    });
    printValidationReport(validationResult);
  }

  var MID_Y = 5.4; // slightly below true geometric centre — frames base + apex well

  // =========================================================
  // Scene setup
  // =========================================================
  var container = document.getElementById("canvas-container");
  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x041420, 0.016);   // open-water haze

  var camera = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 150);

  var renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x041420, 1);
  container.appendChild(renderer.domElement);

  var ambient = new THREE.AmbientLight(0x44506a, 0.6);
  scene.add(ambient);
  var key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(10, 18, 10);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0x88aaff, 0.32);
  fill.position.set(-12, 6, -9);
  scene.add(fill);
  var rim = new THREE.PointLight(0x6cffe0, 0.5, 30);
  rim.position.set(0, TOTAL_HEIGHT+2, 4);
  scene.add(rim);

  window.addEventListener("resize", function(){
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // =========================================================
  // Camera controls — custom orbit (drag rotate, wheel/pinch zoom)
  // =========================================================
  var START_THETA = deg(30), START_PHI = deg(68), START_RADIUS = 35;
  var controls = {
    theta: START_THETA, phi: START_PHI, radius: START_RADIUS,
    targetTheta: START_THETA, targetPhi: START_PHI, targetRadius: START_RADIUS,
    minPhi: deg(24), maxPhi: deg(87),
    minRadius: 10, maxRadius: 70,
    target: new THREE.Vector3(-2.9, MID_Y + 0.3, 0), // shifted left of the pyramid centre so the Sun stays in frame
    update: function(){
      this.theta  += (this.targetTheta  - this.theta)  * 0.09;
      this.phi    += (this.targetPhi    - this.phi)    * 0.09;
      this.radius += (this.targetRadius - this.radius) * 0.09;
      var sinPhi = Math.sin(this.phi);
      camera.position.set(
        this.target.x + this.radius*sinPhi*Math.sin(this.theta),
        this.target.y + this.radius*Math.cos(this.phi),
        this.target.z + this.radius*sinPhi*Math.cos(this.theta)
      );
      camera.lookAt(this.target);
    },
    clampPhi: function(){ this.targetPhi = THREE.MathUtils.clamp(this.targetPhi, this.minPhi, this.maxPhi); },
    clampRadius: function(){ this.targetRadius = THREE.MathUtils.clamp(this.targetRadius, this.minRadius, this.maxRadius); },
    reset: function(){
      this.targetTheta = START_THETA;
      this.targetPhi = START_PHI;
      this.targetRadius = START_RADIUS;
    }
  };

  // =========================================================
  // Layer geometry — truncated TRIANGULAR pyramid slabs.
  // Cross-section in the X-Z plane is a triangle (front tip +
  // rear edge + two side faces), inscribed inside the halfW/
  // halfD envelope bounds — not a 4-sided box. Built as a
  // non-indexed BufferGeometry so computeVertexNormals() gives
  // clean flat shading per face.
  // =========================================================
  function buildFrustumGeometry(yBottom, yTop, wB, dB, wT, dT){
    function corners(hw, hd, y){
      return {
        F: [0,            y,  hd],        // front tip
        R: [ 0.866*hw,    y, -0.5*hd],    // rear-right
        L: [-0.866*hw,    y, -0.5*hd]     // rear-left
      };
    }
    var cb = corners(wB/2, dB/2, yBottom);
    var ct = corners(wT/2, dT/2, yTop);
    var pos = [];
    function quad(p0,p1,p2,p3){
      pos.push(p0[0],p0[1],p0[2], p1[0],p1[1],p1[2], p2[0],p2[1],p2[2]);
      pos.push(p0[0],p0[1],p0[2], p2[0],p2[1],p2[2], p3[0],p3[1],p3[2]);
    }
    function tri(p0,p1,p2){
      pos.push(p0[0],p0[1],p0[2], p1[0],p1[1],p1[2], p2[0],p2[1],p2[2]);
    }
    quad(cb.R, cb.L, ct.L, ct.R); // rear face
    quad(cb.F, cb.R, ct.R, ct.F); // right-side face
    quad(cb.L, cb.F, ct.F, ct.L); // left-side face
    tri(cb.F, cb.L, cb.R);        // bottom cap
    tri(ct.F, ct.R, ct.L);        // top cap
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  }

  var layerMeshes = [];
  function createLayerMesh(layer){
    var geo = buildFrustumGeometry(layer.yBottom, layer.yTop, layer.wBottom, layer.dBottom, layer.wTop, layer.dTop);
    var mat = new THREE.MeshPhongMaterial({
      color: layer.def.color,
      emissive: layer.def.color,
      emissiveIntensity: 0.16*layer.def.glow,
      shininess: 45,
      specular: 0x223344,
      transparent: true,
       opacity: 0.94,
      side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(geo, mat);

    var edgeGeo = new THREE.EdgesGeometry(geo, 1);
    var edgeMat = new THREE.LineBasicMaterial({ color: layer.def.color, transparent:true, opacity:0.5 });
    mesh.add(new THREE.LineSegments(edgeGeo, edgeMat));

    mesh.userData = {
      layerId: layer.def.id,
      baseEmissive: 0.16*layer.def.glow,
      selectedEmissive: 0.9,
      currentEmissive: 0.16*layer.def.glow,
      baseScale: 1, selectedScale: 1.035, currentScale: 1, targetScale: 1,
      edgeMat: edgeMat,
      producerGlowAmount: 0, // driven only by updateProducerActivationTransition() — see Solar/PAR system
      producerBoost: 0.3,
      pressGlowAmount: 0     // driven only by the long-press tracker — see Trophic Profile system
    };
    return mesh;
  }
  layers.forEach(function(layer){
    var mesh = createLayerMesh(layer);
    scene.add(mesh);
    layerMeshes.push(mesh);
  });

  // =========================================================
  // AQUATIC WAVES — added in the aquatic fork
  //   1. a Gerstner-wave water surface on top of every trophic tier (sun glint, fresnel, crest foam)
  //   2. drifting caustic light on each tier's faces, brightest just under the surface
  //   3. OXYGEN bubbles from the producers (TL1) only, and only while light reaches them
  // Purely visual: the surfaces/overlays are children of the layer meshes (so they
  // follow the selection scale) and are never raycast (layer picking is
  // non-recursive). Nothing here touches energy, biomass, selection or the Sun.
  // =========================================================
  var aquaWaveTime = { value: 0 };
  var aquaSunPos = { value: new THREE.Vector3(-9, 8, 0) }, aquaSunOn = { value: 0 };   // shared by every tier: where the Sun is, and how bright
  function aquaNoRaycast(){}

  function buildWaterSurfaceGeometry(y, hw, hd, N){
    var F = [0, hd], R = [0.866 * hw, -0.5 * hd], L = [-0.866 * hw, -0.5 * hd];
    var pos = [], idx = [], id = {}, n = 0, i, j;
    for (i = 0; i <= N; i++){
      for (j = 0; j <= N - i; j++){
        var a = i / N, b = j / N, c = 1 - a - b;
        pos.push(F[0] * c + R[0] * a + L[0] * b, y, F[1] * c + R[1] * a + L[1] * b);
        id[i + "," + j] = n++;
      }
    }
    for (i = 0; i < N; i++){
      for (j = 0; j < N - i; j++){
        idx.push(id[i + "," + j], id[(i + 1) + "," + j], id[i + "," + (j + 1)]);
        if (j < N - i - 1) idx.push(id[(i + 1) + "," + j], id[(i + 1) + "," + (j + 1)], id[i + "," + (j + 1)]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  var aquaSurfaces = [];
  layerMeshes.forEach(function(layerMesh){
    var layer = layers[layerMesh.userData.layerId - 1];
    if (!layer) return;
    var id = layer.def.id;
    var base = new THREE.Color(layer.def.color);
    var deep = base.clone().lerp(new THREE.Color(0x0b3a5c), 0.55);     // the tier's colour under blue water
    var light = base.clone().lerp(new THREE.Color(0xe8fbff), 0.55);    // sunlit crest

    // 1. realistic water surface on top of the tier: Gerstner waves (crests sharpen, troughs flatten) from
    //    four directions, lit by the Sun — fresnel sky reflection, a moving sun glint and foam on the crests.
    var yS = layer.yTop + 0.03;
    var surfGeo = buildWaterSurfaceGeometry(yS, halfW(layer.yTop) * 0.97, halfD(layer.yTop) * 0.97, 48);
    var surfMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: aquaWaveTime, uSunPos: aquaSunPos, uSunOn: aquaSunOn,
        uDeep: { value: deep }, uShallow: { value: light }, uSeed: { value: id * 1.37 }
      },
      vertexShader:
        "uniform float uTime; uniform float uSeed;\n" +
        "varying vec3 vWorld; varying vec3 vN; varying float vCrest;\n" +
        // one Gerstner wave: d = direction, k = wavenumber, a = amplitude, s = speed, q = steepness
        "void wave(vec2 d, float k, float a, float s, float q, vec3 p0, inout vec3 p, inout vec3 n, inout float crest){\n" +
        "  float f = k * dot(d, p0.xz) - s * uTime + uSeed;\n" +
        "  float c = cos(f), sn = sin(f);\n" +
        "  p.x += q * a * d.x * c; p.z += q * a * d.y * c; p.y += a * sn;\n" +
        "  n.x -= d.x * k * a * c; n.z -= d.y * k * a * c; n.y -= q * k * a * sn;\n" +
        "  crest += sn * a;\n" +
        "}\n" +
        "void main(){\n" +
        "  vec3 p0 = position, p = position, n = vec3(0.0, 1.0, 0.0); float crest = 0.0;\n" +
        "  wave(normalize(vec2( 1.0, 0.35)), 2.3, 0.032, 1.6, 0.55, p0, p, n, crest);\n" +
        "  wave(normalize(vec2(-0.6, 1.0)),  3.1, 0.020, 1.9, 0.50, p0, p, n, crest);\n" +
        "  wave(normalize(vec2( 0.2,-1.0)),  4.7, 0.011, 2.6, 0.45, p0, p, n, crest);\n" +
        "  wave(normalize(vec2(-1.0,-0.3)),  7.9, 0.006, 3.4, 0.40, p0, p, n, crest);\n" +
        "  vCrest = crest / 0.069;\n" +                                        // -1 trough .. +1 crest
        "  vec4 w = modelMatrix * vec4(p, 1.0); vWorld = w.xyz;\n" +
        "  vN = normalize(mat3(modelMatrix) * normalize(n));\n" +
        "  gl_Position = projectionMatrix * viewMatrix * w;\n" +
        "}",
      fragmentShader:
        "uniform float uTime; uniform vec3 uSunPos; uniform float uSunOn; uniform vec3 uDeep; uniform vec3 uShallow;\n" +
        "varying vec3 vWorld; varying vec3 vN; varying float vCrest;\n" +
        "void main(){\n" +
        "  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;\n" +
        "  vec3 V = normalize(cameraPosition - vWorld), L = normalize(uSunPos - vWorld);\n" +
        "  float ndv = clamp(dot(N, V), 0.0, 1.0);\n" +
        "  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);\n" +             // Schlick fresnel: grazing views reflect more
        "  vec3 body = mix(uDeep, uShallow, smoothstep(-0.8, 1.0, vCrest) * 0.75 + 0.25 * max(dot(N, L), 0.0));\n" +
        "  vec3 sky = mix(vec3(0.10, 0.22, 0.32), vec3(0.55, 0.78, 0.92), 0.35 + 0.65 * uSunOn);\n" +
        "  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 90.0) * (0.25 + 1.6 * uSunOn);\n" +   // sun glint
        "  float foamN = 0.5 + 0.5 * sin(vWorld.x * 23.0 + uTime * 1.3) * sin(vWorld.z * 19.0 - uTime * 1.1);\n" +
        "  float foam = smoothstep(0.62, 0.95, vCrest) * (0.35 + 0.65 * foamN);\n" +
        "  vec3 col = mix(body, sky, fres) + vec3(1.0, 0.97, 0.88) * spec + vec3(0.92, 0.97, 1.0) * foam * 0.45;\n" +
        "  gl_FragColor = vec4(col, clamp(0.34 + 0.40 * fres + 0.35 * spec + 0.25 * foam, 0.0, 0.92));\n" +
        "}",
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
    var surf = new THREE.Mesh(surfGeo, surfMat);
    surf.raycast = aquaNoRaycast;
    surf.renderOrder = 1;
    surf.frustumCulled = false;
    layerMesh.add(surf);
    aquaSurfaces.push(surf);

    // 2. underwater light on the tier's faces: drifting caustic network (light focused by the waves
    //    above), strongest just under the surface and fading with depth, plus faint travelling swell lines.
    var rippleMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: aquaWaveTime, uSunOn: aquaSunOn, uCol: { value: light.clone().lerp(new THREE.Color(0xbff6ff), 0.35) },
        uY0: { value: layer.yBottom }, uY1: { value: layer.yTop }, uSeed: { value: id * 2.11 }
      },
      vertexShader:
        "varying vec3 vPos;\n" +
        "void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform float uTime; uniform float uSunOn; uniform vec3 uCol; uniform float uY0; uniform float uY1; uniform float uSeed;\n" +
        "varying vec3 vPos;\n" +
        "float caustic(vec2 p, float t){\n" +                                  // domain-warped sine network -> thin bright lines
        "  float c = 0.0;\n" +
        "  for (int i = 0; i < 3; i++){\n" +
        "    float fi = float(i);\n" +
        "    p += vec2(sin(p.y * 1.7 + t * 0.9 + fi * 1.3), cos(p.x * 1.4 - t * 0.7 + fi * 2.1)) * 0.42;\n" +
        "    c += abs(sin(p.x * 1.1) * cos(p.y * 1.1));\n" +
        "  }\n" +
        "  return pow(1.0 - clamp(c / 3.0, 0.0, 1.0), 6.0);\n" +
        "}\n" +
        "void main(){\n" +
        "  float ty = clamp((vPos.y - uY0) / (uY1 - uY0), 0.0, 1.0);\n" +
        "  vec2 q = vec2(vPos.x + vPos.z * 0.6, vPos.z - vPos.x * 0.3 + vPos.y * 0.8) * 2.4 + uSeed;\n" +
        "  float caus = caustic(q, uTime) * (0.25 + 0.75 * smoothstep(0.15, 1.0, ty));\n" +   // brighter near the surface
        "  float wob = 0.08 * sin(vPos.x * 2.3 + uTime * 1.1 + uSeed) + 0.06 * sin(vPos.z * 3.1 - uTime * 0.8);\n" +
        "  float swell = smoothstep(0.86, 1.0, sin((vPos.y + wob) * 7.0 - uTime * 1.2));\n" +
        "  float light = 0.55 + 0.45 * uSunOn;\n" +
        "  gl_FragColor = vec4(uCol, (0.22 * caus + 0.06 * swell + 0.05 * smoothstep(0.82, 1.0, ty)) * light);\n" +
        "}",
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    var ripple = new THREE.Mesh(layerMesh.geometry, rippleMat);   // geometry shared, never disposed here
    ripple.raycast = aquaNoRaycast;
    ripple.renderOrder = 1;
    ripple.frustumCulled = false;
    layerMesh.add(ripple);
  });

  // 3. OXYGEN BUBBLES — from the PRODUCERS (TL1) only, and only in light.
  //    Photosynthesis releases O2 (like the classic Hydrilla bubble experiment); consumers do not:
  //    they USE oxygen in respiration. So: Sun off -> no bubbles; after PAR reaches TL1 the bubbles
  //    start from the living producers, rise (growing slightly as pressure falls) and pop at TL1's
  //    water surface. Dead producers stop bubbling. Purely visual; no effect on energy or biomass.
  var bubbleTexture = (function(){
    var size = 64, c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(32, 32, 14, 32, 32, 27);              // clear centre, bright rim
    grad.addColorStop(0, "rgba(205,242,255,0.22)"); grad.addColorStop(0.7, "rgba(215,246,255,0.5)"); grad.addColorStop(1, "rgba(240,253,255,1)");
    g.fillStyle = grad; g.beginPath(); g.arc(32, 32, 27, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,255,255,0.95)";
    g.beginPath(); g.ellipse(23, 21, 6, 4, -0.6, 0, Math.PI * 2); g.fill();  // highlight
    return new THREE.CanvasTexture(c);
  })();
  var O2_N = 70;
  var o2Pos = new Float32Array(O2_N * 3), o2Size = new Float32Array(O2_N), o2Alpha = new Float32Array(O2_N), o2 = [];
  for (var oi = 0; oi < O2_N; oi++) o2.push({ live: false, wait: Math.random() * 1.5, x: 0, y: -50, z: 0, v: 0, s: 0, ph: 0, pop: 0 });
  var o2Geo = new THREE.BufferGeometry();
  o2Geo.setAttribute("position", new THREE.BufferAttribute(o2Pos, 3));
  o2Geo.setAttribute("aSize", new THREE.BufferAttribute(o2Size, 1));
  o2Geo.setAttribute("aAlpha", new THREE.BufferAttribute(o2Alpha, 1));
  var o2Mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: bubbleTexture }, uScale: { value: 400 }, uMinPx: { value: 6 } },
    vertexShader:
      "uniform float uScale; uniform float uMinPx; attribute float aSize; attribute float aAlpha; varying float vA;\n" +
      "void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize > 0.0 ? max(aSize * uScale / max(0.1, -mv.z), uMinPx * aSize / 0.28) : 0.0; gl_Position = projectionMatrix * mv; vA = aAlpha; }",
    fragmentShader:
      "uniform sampler2D uTex; varying float vA;\n" +
      "void main(){ vec4 t = texture2D(uTex, gl_PointCoord); float a = t.a * vA; if (a < 0.01) discard; gl_FragColor = vec4(t.rgb, a); }",
    transparent: true, depthWrite: false, depthTest: false
  });
  var o2Points = new THREE.Points(o2Geo, o2Mat);
  o2Points.frustumCulled = false;
  o2Points.renderOrder = 3;
  o2Points.raycast = aquaNoRaycast;
  scene.add(o2Points);
  var o2Rate = 0;

  function o2Spawn(b){
    var L1 = layers[0], src = null, living = [];
    if (typeof ORGANISM_ASSETS !== "undefined") ORGANISM_ASSETS.forEach(function(a){ if (a.trophicLevel === 1 && a.status === "living" && organismSlots[a.id]) living.push(organismSlots[a.id].sprite.position); });
    var y, hw, hd, x, z;
    if (living.length && Math.random() < 0.75){                          // most bubbles stream from the plants / algae themselves
      src = living[Math.floor(Math.random() * living.length)];
      y = THREE.MathUtils.clamp(src.y + (Math.random() - 0.6) * 0.6, L1.yBottom + 0.1, L1.yTop - 0.3);
      x = src.x + (Math.random() - 0.5) * 0.7; z = src.z + (Math.random() - 0.5) * 0.5;
    } else {                                                               // the rest anywhere in the producer tier
      y = THREE.MathUtils.lerp(L1.yBottom + 0.1, L1.yTop - 0.6, Math.random());
      var u = Math.random(), v = Math.random(); if (u + v > 1){ u = 1 - u; v = 1 - v; }
      hw = halfW(y) * 0.8; hd = halfD(y) * 0.8;
      x = 0.866 * hw * (u - v); z = hd * (1 - u - v) - 0.5 * hd * (u + v);
    }
    // keep the start inside TL1's cross-section at that height
    hw = halfW(y) * 0.86; hd = halfD(y) * 0.86;
    var F = [0, hd], R = [0.866 * hw, -0.5 * hd], Lf = [-0.866 * hw, -0.5 * hd];
    var sd = function(p, q){ return (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (z - q[1]); };
    var d1 = sd(F, R), d2 = sd(R, Lf), d3 = sd(Lf, F);
    if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)){ x *= 0.4; z = z * 0.4; }
    b.live = true; b.pop = 0; b.x = x; b.y = y; b.z = z;
    b.v = 0.30 + Math.random() * 0.35; b.s = 0.20 + Math.random() * 0.16;   // drawn larger than life so they read at classroom distance b.ph = Math.random() * 6.283;
  }

  function updateAquaticWaves(elapsedTime, delta){
    aquaWaveTime.value = elapsedTime;
    if (typeof SUN_POSITION !== "undefined" && SUN_POSITION) aquaSunPos.value.copy(SUN_POSITION);
    var glow = (typeof sunData !== "undefined" && sunData) ? sunData.currentGlow : 0;
    aquaSunOn.value = glow;
    o2Uniform();
    // light reaching the producers: PAR has arrived (producers activating / energised); scaled by the living producers
    var lit = (typeof simState !== "undefined" && typeof SIM_STATE !== "undefined") &&
              (simState === SIM_STATE.PRODUCER_ACTIVATING || simState === SIM_STATE.PRODUCER_ENERGISED);
    var living = 1;                                                       // share of the producer organisms still alive
    if (typeof ORGANISM_ASSETS !== "undefined"){
      var nP = 0, nL = 0;
      ORGANISM_ASSETS.forEach(function(a){ if (a.trophicLevel === 1){ nP++; if (a.status === "living") nL++; } });
      living = nP ? nL / nP : 0;
    }
    o2Rate += ((lit ? living : 0) - o2Rate) * Math.min(1, delta * 1.5);
    var surfaceY = layers[0].yTop + 0.03, any = false;
    for (var i = 0; i < O2_N; i++){
      var b = o2[i];
      if (!b.live){
        b.wait -= delta;
        if (b.wait <= 0){
          b.wait = 0.2 + Math.random() * 1.6;
          if (Math.random() < o2Rate) o2Spawn(b);
        }
        o2Alpha[i] = 0; o2Size[i] = 0;
        continue;
      }
      any = true;
      if (b.pop > 0){                                                      // popping at the surface: a quick flash and gone
        b.pop += delta;
        var k = b.pop / 0.18;
        o2Size[i] = b.s * (1.35 + 0.6 * k); o2Alpha[i] = Math.max(0, 0.9 * (1 - k));
        if (k >= 1){ b.live = false; o2Alpha[i] = 0; o2Size[i] = 0; }
        continue;
      }
      b.v += delta * 0.08;                                                 // speeds up a little as it rises
      b.y += b.v * delta;
      var rise = THREE.MathUtils.clamp((b.y - layers[0].yBottom) / (surfaceY - layers[0].yBottom), 0, 1);
      o2Pos[i * 3]     = b.x + Math.sin(elapsedTime * 3.1 + b.ph) * 0.035 * (0.5 + rise);   // small zig-zag
      o2Pos[i * 3 + 1] = b.y;
      o2Pos[i * 3 + 2] = b.z + Math.cos(elapsedTime * 2.7 + b.ph) * 0.025;
      o2Size[i] = b.s * (1 + 0.35 * rise);                                  // grows as water pressure falls
      o2Alpha[i] = 0.85 * Math.min(1, (b.y - (layers[0].yBottom + 0.05)) * 4 + 0.2);
      if (b.y >= surfaceY) b.pop = 1e-4;
    }
    o2Points.visible = any;
    o2Geo.attributes.position.needsUpdate = true;
    o2Geo.attributes.aSize.needsUpdate = true;
    o2Geo.attributes.aAlpha.needsUpdate = true;
  }
  function o2Uniform(){                                                    // point size follows the canvas height (as PointsMaterial does)
    var h = (renderer && renderer.domElement) ? renderer.domElement.height : 800;
    o2Mat.uniforms.uScale.value = h * 0.5;
    o2Mat.uniforms.uMinPx.value = 7 * ((renderer && renderer.getPixelRatio) ? renderer.getPixelRatio() : 1);   // still readable from the default (far) view
  }

  // =========================================================
  // TROPHIC PYRAMID FRAME
  //
  // The slabs already carry the exact trophic geometry. This separate,
  // non-interactive frame clarifies the shared food-chain silhouette:
  // broad producer base, progressively narrower consumer tiers, and one
  // continuous apex. It does not join layerMeshes and cannot affect
  // raycasting, selection, or the energy-flow system.
  // =========================================================
  function pyramidCorners(y){
    var hw = halfW(y), hd = halfD(y);
    return [
      new THREE.Vector3(0, y, hd),
      new THREE.Vector3(0.866*hw, y, -0.5*hd),
      new THREE.Vector3(-0.866*hw, y, -0.5*hd)
    ];
  }
  function addFrameSegment(points, a, b){
    points.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  var pyramidFramePositions = [];
  // Inverted: the narrow end is at the bottom (TL1), the broad rim at the top.
  var frameBase = pyramidCorners(layers[0].yBottom);
  var frameTop = pyramidCorners(TOTAL_HEIGHT);

  // Three long edges and the broad top rim make the inverted pyramid readable
  // even when the individual trophic tiers are viewed at an angle.
  var frameApex = new THREE.Vector3(0, TOTAL_HEIGHT, 0);
  frameBase.forEach(function(corner, ci){
    addFrameSegment(pyramidFramePositions, corner, IS_POND ? frameApex : frameTop[ci]);   // pond: upright, edges meet at the apex
  });
  addFrameSegment(pyramidFramePositions, frameBase[0], frameBase[1]);
  addFrameSegment(pyramidFramePositions, frameBase[1], frameBase[2]);
  addFrameSegment(pyramidFramePositions, frameBase[2], frameBase[0]);
  if (!IS_POND){
    addFrameSegment(pyramidFramePositions, frameTop[0], frameTop[1]);
    addFrameSegment(pyramidFramePositions, frameTop[1], frameTop[2]);
    addFrameSegment(pyramidFramePositions, frameTop[2], frameTop[0]);
  }

  // Subtle horizontal rings retain the stepped food-chain reading without
  // changing any layer face, gap, or proportion.
  layers.forEach(function(layer){
    var bottom = pyramidCorners(layer.yBottom);
    var top = pyramidCorners(layer.yTop);
    [bottom, top].forEach(function(ring){
      addFrameSegment(pyramidFramePositions, ring[0], ring[1]);
      addFrameSegment(pyramidFramePositions, ring[1], ring[2]);
      addFrameSegment(pyramidFramePositions, ring[2], ring[0]);
    });
  });

  var pyramidFrameGeo = new THREE.BufferGeometry();
  pyramidFrameGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(pyramidFramePositions, 3)
  );
  var pyramidFrame = new THREE.LineSegments(
    pyramidFrameGeo,
    new THREE.LineBasicMaterial({
      color:0xc9ffe9,
      transparent:true,
      opacity:0.24,
      depthWrite:false,
      depthTest:true
    })
  );
  pyramidFrame.renderOrder = 1;
  scene.add(pyramidFrame);

  // =========================================================
  // Energy-flow system — wave lines + particles inside gaps.
  // Paths hug the central vertical axis (small X drift only)
  // while being distributed across the prism's depth (Z lanes),
  // and are scaled by halfW(y)/halfD(y) so they stay inside the
  // envelope as it narrows through each corridor.
  // =========================================================
  var glowTexture = (function makeGlowTexture(){
    var size = 64;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var ctx = c.getContext("2d");
    var grad = ctx.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,size,size);
    return new THREE.CanvasTexture(c);
  })();

  function buildGapCurve(gap, zFrac, phase){
    var pts = [];
    var N = 12;
    for (var i=0;i<=N;i++){
      var t = i/N;
      var y = THREE.MathUtils.lerp(gap.yBottom, gap.yTop, t);
      var hw = halfW(y), hd = halfD(y);
      var z = zFrac*hd*0.85 + Math.sin(t*Math.PI*3 + phase)*hd*0.06;
      var x = Math.sin(t*Math.PI*2.4 + phase*1.3)*hw*0.14;
      pts.push(new THREE.Vector3(x, y, z));
    }
    return new THREE.CatmullRomCurve3(pts);
  }

  var waveTubes = [];
  function createWaveTube(gap, zFrac, phase){
    var curve = buildGapCurve(gap, zFrac, phase);
    var tubularSegments = 46;
    var radialSegments = 6;
    var geo = new THREE.TubeGeometry(curve, tubularSegments, 0.05, radialSegments, false);
    var ringVerts = radialSegments + 1;
    var colorArr = new Float32Array((tubularSegments+1) * ringVerts * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colorArr, 3));
    var mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    var baseColor = new THREE.Color(gap.colorA).lerp(new THREE.Color(gap.colorB), 0.5);
    mesh.userData.update = function(elapsed){
      for (var seg=0; seg<=tubularSegments; seg++){
        var t = seg/tubularSegments;
        var wave = 0.5 + 0.5*Math.sin(t*Math.PI*2*2.2 - elapsed*gap.flowSpeed);
        var brightness = (0.3 + wave*0.95) * gap.attenuation;
        for (var k=0;k<ringVerts;k++){
          var idx = (seg*ringVerts + k) * 3;
          colorArr[idx]   = baseColor.r * brightness;
          colorArr[idx+1] = baseColor.g * brightness;
          colorArr[idx+2] = baseColor.b * brightness;
        }
      }
      geo.attributes.color.needsUpdate = true;
    };
    return mesh;
  }

  var particleSystems = [];
  function createParticleSystem(gap){
    var count = gap.particleCount;
    var positions = new Float32Array(count*3);
    var progress = new Float32Array(count);
    var zFracArr = new Float32Array(count);
    var xFracArr = new Float32Array(count);
    var speedArr = new Float32Array(count);
    for (var i=0;i<count;i++){
      progress[i] = Math.random();
      zFracArr[i] = (Math.random()*2-1)*0.82;
      xFracArr[i] = (Math.random()*2-1)*0.16;
      speedArr[i] = gap.driftSpeed * (0.75 + Math.random()*0.5);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    var baseColor = new THREE.Color(gap.colorA).lerp(new THREE.Color(gap.colorB), 0.5);
    var mat = new THREE.PointsMaterial({
      color: baseColor, size: 0.16, map: glowTexture,
      transparent: true, opacity: Math.min(1, 0.55 + gap.attenuation*0.5),
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var points = new THREE.Points(geo, mat);
    points.userData.update = function(delta){
      for (var i=0;i<count;i++){
        progress[i] += delta*speedArr[i];
        if (progress[i] > 1) progress[i] -= 1;
        var t = progress[i];
        var y = THREE.MathUtils.lerp(gap.yBottom, gap.yTop, t);
        var hw = halfW(y), hd = halfD(y);
        positions[i*3]   = xFracArr[i]*hw;
        positions[i*3+1] = y;
        positions[i*3+2] = zFracArr[i]*hd;
      }
      geo.attributes.position.needsUpdate = true;
    };
    return points;
  }

  gaps.forEach(function(gap){
    GAP_LANES_Z.forEach(function(zFrac, laneIdx){
      var tube = createWaveTube(gap, zFrac, laneIdx*1.7 + gap.index);
      scene.add(tube);
      waveTubes.push(tube);
    });
    var particles = createParticleSystem(gap);
    scene.add(particles);
    particleSystems.push(particles);
  });

  // Subtle apex marker — the point the whole envelope converges to
  var apexMat = new THREE.SpriteMaterial({
    map: glowTexture, color: 0xffe9c7, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite:false
  });
  var apexSprite = new THREE.Sprite(apexMat);
  apexSprite.scale.set(0.6, 0.6, 1);
  apexSprite.position.set(0, TOTAL_HEIGHT, 0);
  apexSprite.visible = IS_POND;   // inverted (sea) pyramid: there is no apex at the top
  scene.add(apexSprite);

  // =========================================================
  // ORGANISM ASSET SYSTEM — photorealistic transparent images
  //
  // The asset manifest is intentionally separate from rendering logic.
  // Replace the placeholder PNG/WebP paths below with real transparent
  // nature-documentary assets without touching prism geometry, camera
  // placement, energy flow, or interaction code.
  //
  // x and z are fractions of the layer envelope at the asset's y.
  // y is a fraction of that layer's vertical range.  scale is the
  // desired world-space image height before the layer-thickness clamp.
  // Positions are spread across each layer's triangular cross-section
  // (front / left-rear / right-rear) and staggered in height so the
  // placeholders never bunch together or overlap in the default view.
  //
  // Sprites are not added to layerMeshes, so they can never become
  // raycast targets or interfere with layer selection/long-press.
  // =========================================================
  function newIconCanvas(size){
    var c = document.createElement("canvas");
    c.width = c.height = size;
    return { canvas:c, ctx:c.getContext("2d") };
  }
  function iconTexture(drawFn, size){
    size = size || 128;
    var ic = newIconCanvas(size);
    drawFn(ic.ctx, size);
    var tex = new THREE.CanvasTexture(ic.canvas);
    tex.needsUpdate = true;
    return tex;
  }

  function drawDeadMatterIcon(ctx, s){
    ctx.save();
    ctx.translate(s*0.5, s*0.5);
    ctx.rotate(-0.22);
    ctx.fillStyle = "rgba(126,105,77,0.78)";
    ctx.beginPath();
    ctx.moveTo(-s*0.28, s*0.03);
    ctx.quadraticCurveTo(-s*0.08, -s*0.24, s*0.25, -s*0.11);
    ctx.quadraticCurveTo(s*0.34, s*0.02, s*0.16, s*0.19);
    ctx.quadraticCurveTo(-s*0.08, s*0.25, -s*0.28, s*0.03);
    ctx.fill();
    ctx.fillStyle = "rgba(181,151,106,0.62)";
    ctx.beginPath();
    ctx.ellipse(-s*0.05, s*0.12, s*0.08, s*0.035, -0.45, 0, Math.PI*2);
    ctx.ellipse(s*0.18, -s*0.18, s*0.045, s*0.022, 0.2, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }
  var deadMatterTexture = iconTexture(drawDeadMatterIcon, 64);

  // Eleven replaceable image slots for an OPEN-WATER (pelagic) food chain:
  // 3 phytoplankton producers, 4 grazing zooplankton, 3 planktivores, 1 top predator.
  // Image paths are placeholders — drop transparent PNGs at these paths (or paste links
  // with the editor); until then each slot shows a drawn placeholder card.
  var SEA_ORGANISM_ASSETS = [
    { id:"tl1-diatoms", label:"TL1 \u00b7 Diatoms", trophicLevel:1, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Producers/Diatoms.png",
      x:-0.50, y:0.22, z:0.10, scale:0.8, opacity:0.98 },
    { id:"tl1-dinoflagellates", label:"TL1 \u00b7 Dinoflagellates", trophicLevel:1, biomassContribution:3, status:"living", imageUrl:"Solus-Assets/Aquatic/Producers/Dinoflagellates.png",
      x:0.50, y:0.50, z:0.10, scale:0.8, opacity:0.96 },
    { id:"tl1-green-microalgae", label:"TL1 \u00b7 Green microalgae", trophicLevel:1, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Producers/Green%20Microalgae.png",
      x:-0.05, y:0.82, z:0.30, scale:0.75, opacity:0.98 },
    { id:"tl2-copepod", label:"TL2 \u00b7 Copepod", trophicLevel:2, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Primary%20Consumers/Copepod.png",
      x:0.04, y:0.30, z:0.40, scale:1.0, opacity:0.98 },
    { id:"tl2-krill", label:"TL2 \u00b7 Krill", trophicLevel:2, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Primary%20Consumers/Krill.png",
      x:0.52, y:0.25, z:-0.25, scale:1.0, opacity:0.96 },
    { id:"tl2-ciliate", label:"TL2 \u00b7 Ciliate", trophicLevel:2, biomassContribution:2, status:"living", imageUrl:"Solus-Assets/Aquatic/Primary%20Consumers/Ciliate.png",
      x:-0.55, y:0.68, z:-0.10, scale:0.9, opacity:0.96 },
    { id:"tl2-pteropod", label:"TL2 \u00b7 Pteropod", trophicLevel:2, biomassContribution:2, status:"living", imageUrl:"Solus-Assets/Aquatic/Primary%20Consumers/Pteropod.png",
      x:0.18, y:0.76, z:-0.40, scale:0.9, opacity:0.96 },
    { id:"tl3-herring", label:"TL3 \u00b7 Herring", trophicLevel:3, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Secondary%20Consumers/Herring%20-%20Copepod.png",
      x:-0.42, y:0.62, z:-0.30, scale:1.1, opacity:0.98 },
    { id:"tl3-anchovy", label:"TL3 \u00b7 Anchovy", trophicLevel:3, biomassContribution:3, status:"living", imageUrl:"Solus-Assets/Aquatic/Secondary%20Consumers/Anchovy%20-%20Krill.png",
      x:0.48, y:0.30, z:-0.20, scale:1.05, opacity:0.96 },
    { id:"tl3-arrow-worm", label:"TL3 \u00b7 Arrow worm", trophicLevel:3, biomassContribution:3, status:"living", imageUrl:"Solus-Assets/Aquatic/Secondary%20Consumers/Arrow%20Worm%20-%20Copepod.png",
      x:0.00, y:0.32, z:0.42, scale:1.0, opacity:0.96 },
    { id:"tl4-blue-shark", label:"TL4 \u00b7 Blue shark", trophicLevel:4, biomassContribution:8, status:"living", imageUrl:"Solus-Assets/Aquatic/Tertiary%20Consumers/Blue%20Shark%20-%20Herring.png",
      x:0.10, y:0.40, z:0.20, scale:1.35, opacity:0.98 }
  ];
  // POND (habitat switch): a plant-rich freshwater pond. Rooted and floating plants plus algal mats
  // hold most of the producer biomass, so here the pyramid of biomass is UPRIGHT.
  // Positions reuse the original upright-pyramid layout (wide producer base).
  var POND_ORGANISM_ASSETS = [
    { id:"pond-tl1-hydrilla", label:"TL1 · Hydrilla", trophicLevel:1, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Producers/Hydrilla.png",
      x:-0.45, y:0.43, z:-0.3, scale:1.65, opacity:0.98 },
    { id:"pond-tl1-spirogyra", label:"TL1 · Spirogyra (algae)", trophicLevel:1, biomassContribution:3, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Producers/Spirogyra.png",
      x:0.62, y:0.31, z:-0.25, scale:1.4, opacity:0.96 },
    { id:"pond-tl1-lotus", label:"TL1 · Lotus", trophicLevel:1, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Producers/Lotus.png",
      x:0.08, y:0.29, z:0.47, scale:1.65, opacity:0.98 },
    { id:"pond-tl2-daphnia", label:"TL2 · Daphnia (water flea)", trophicLevel:2, biomassContribution:2, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Primary%20Consumers/Daphnia.png",
      x:0.05, y:0.15, z:0.33, scale:1.0, opacity:0.98 },
    { id:"pond-tl2-snail", label:"TL2 · Pond snail", trophicLevel:2, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Primary%20Consumers/Pond%20Snail.png",
      x:0.43, y:0.15, z:-0.27, scale:0.9, opacity:0.96 },
    { id:"pond-tl2-tadpole", label:"TL2 · Tadpole", trophicLevel:2, biomassContribution:3, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Primary%20Consumers/Tadpole.png",
      x:0.14, y:0.55, z:-0.38, scale:0.9, opacity:0.96 },
    { id:"pond-tl2-mayfly-nymph", label:"TL2 · Mayfly nymph", trophicLevel:2, biomassContribution:2, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Primary%20Consumers/Mayfly%20Nymph.png",
      x:-0.44, y:0.65, z:-0.26, scale:1.0, opacity:0.96 },
    { id:"pond-tl3-small-fish", label:"TL3 · Small fish", trophicLevel:3, biomassContribution:5, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Secondary%20Consumers/Small%20Fish%20-%20Daphnia.png",
      x:-0.23, y:0.67, z:-0.4, scale:0.92, opacity:0.98 },
    { id:"pond-tl3-frog", label:"TL3 · Frog", trophicLevel:3, biomassContribution:3, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Secondary%20Consumers/Frog%20-%20Insect.png",
      x:0.56, y:0.21, z:-0.16, scale:0.78, opacity:0.96 },
    { id:"pond-tl3-dragonfly-nymph", label:"TL3 · Dragonfly nymph", trophicLevel:3, biomassContribution:3, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Secondary%20Consumers/Dragonfly%20Nymph%20-%20Tadpole.png",
      x:-0.05, y:0.25, z:0.38, scale:0.78, opacity:0.96 },
    { id:"pond-tl4-water-snake", label:"TL4 · Water snake", trophicLevel:4, biomassContribution:8, status:"living", imageUrl:"Solus-Assets/Aquatic/Pond/Tertiary%20Consumers/Water%20Snake%20-%20Frog.png",
      x:0.13, y:0.31, z:0.19, scale:0.75, opacity:0.98 }
  ];
  var ORGANISM_ASSETS = IS_POND ? POND_ORGANISM_ASSETS : SEA_ORGANISM_ASSETS;
  if (BAKED.organismUrls && typeof BAKED.organismUrls === "object"){              // snapshot: its links become the defaults
    SEA_ORGANISM_ASSETS.concat(POND_ORGANISM_ASSETS).forEach(function(a){
      if (typeof BAKED.organismUrls[a.id] === "string") a.imageUrl = BAKED.organismUrls[a.id];
    });
  }


  var organismTextureLoader = new THREE.TextureLoader();
  organismTextureLoader.setCrossOrigin("anonymous");
  var embeddedOrganisms = [];
  var organismSlots = {};
  var organismEditorInputs = {};
  var organismEditorPreviews = {};
  var organismEditorOpen = false;
  var ORGANISM_URL_STORAGE_KEY = "aquatic-organism-image-urls-v1";   // separate from the terrestrial simulator
  var defaultOrganismUrls = {};

  ORGANISM_ASSETS.forEach(function(asset){
    // The original image for each slot now lives in this repo (Solus-Assets/...), so
    // "Restore placeholders" and the long-press "Original" button bring these back.
    defaultOrganismUrls[asset.id] = asset.imageUrl;
  });
  try {
    var savedOrganismUrls = JSON.parse(window.localStorage.getItem(ORGANISM_URL_STORAGE_KEY) || "{}");
    ORGANISM_ASSETS.forEach(function(asset){
      var saved = savedOrganismUrls[asset.id];
      // Old saved links to the deleted Supabase storage can never load again, and old "builtin:"
      // values only stood in for those missing images — ignore both so the repo images show.
      if (saved && saved.indexOf("supabase.co") === -1 && saved.indexOf("builtin:") !== 0) asset.imageUrl = saved;
    });
  } catch (e) {
    // localStorage can be unavailable for some file:// browser contexts.
  }

  function saveOrganismUrls(){
    try {
      var urls = {};
      try { urls = JSON.parse(window.localStorage.getItem(ORGANISM_URL_STORAGE_KEY) || "{}") || {}; } catch (e2) { urls = {}; }
      ORGANISM_ASSETS.forEach(function(asset){ urls[asset.id] = asset.imageUrl; });   // merge: Pond and Open-sea links live side by side
      window.localStorage.setItem(ORGANISM_URL_STORAGE_KEY, JSON.stringify(urls));
    } catch (e) {}
  }

  // Simple drawn icons (centred near 180,95 on the 360x240 card) for organisms without an accurate emoji.
  function drawPlaceholderGlyph(ctx, kind){
    var i;
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    function ell(x, y, rx, ry, rot, fill, stroke){ ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); if (fill){ ctx.fillStyle = fill; ctx.fill(); } if (stroke){ ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); } }
    function line(a, b, c, d, col, w){ ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.strokeStyle = col; ctx.lineWidth = w || 2; ctx.stroke(); }
    if (kind === "lotus"){                                             // floating round leaf + pink flower
      ell(180, 122, 74, 15, 0, "#3f8a3a", "#2c6129");
      line(180, 122, 180, 108, "#2c6129", 3);
      for (i = -2; i <= 2; i++){ ctx.save(); ctx.translate(180, 108); ctx.rotate(i * 0.36); ell(0, -24, 11, 26, 0, "#f3a6c6", "#c4588c"); ctx.restore(); }
      ell(180, 104, 9, 6, 0, "#f7d34a");
    } else if (kind === "tadpole"){                                    // round body + finned tail
      ctx.beginPath(); ctx.moveTo(182, 84); ctx.quadraticCurveTo(220, 66, 252, 94); ctx.quadraticCurveTo(220, 110, 182, 106); ctx.closePath();
      ctx.fillStyle = "rgba(120,132,92,0.85)"; ctx.fill();
      ell(160, 95, 28, 22, 0, "#4b5a3a", "#33402a");
      ell(146, 86, 3.5, 3.5, 0, "#e9f0e0"); ell(146, 104, 3.5, 3.5, 0, "#e9f0e0");
    } else if (kind === "mayfly" || kind === "dragonfly"){             // aquatic insect nymphs
      var col = kind === "mayfly" ? "#9a8a58" : "#6f7a40", dark = "#3c3420", broad = kind === "dragonfly";
      for (i = 0; i < 3; i++){                                          // six legs from the thorax
        var lx = 146 + i * 10;
        line(lx, 95, lx - 8 + i * 8, 66, dark, 2.5); line(lx - 8 + i * 8, 66, lx - 16 + i * 14, 58, dark, 2);
        line(lx, 95, lx - 8 + i * 8, 124, dark, 2.5); line(lx - 8 + i * 8, 124, lx - 16 + i * 14, 132, dark, 2);
      }
      ell(126, 95, 12, 12, 0, col, dark);                               // head
      ell(118, 87, 4, 4, 0, dark); ell(118, 103, 4, 4, 0, dark);        // eyes
      ell(152, 95, 17, 13, 0, col, dark);                               // thorax
      ell(154, 95, 12, 16, 0, "rgba(70,80,40,0.55)");                   // wing pads
      if (broad){ ell(205, 95, 38, 19, 0, col, dark); for (i = 0; i < 5; i++) line(178 + i * 12, 80, 178 + i * 12, 110, "rgba(40,34,20,0.5)", 1.5); line(243, 95, 252, 95, dark, 3); }
      else {
        for (i = 0; i < 6; i++){ ell(178 + i * 12, 95, 9 - i * 0.6, 11 - i * 0.8, 0, col, dark);
          ell(178 + i * 12, 82 - i * 0.2, 5, 3, -0.5, "rgba(190,200,170,0.75)"); ell(178 + i * 12, 108 + i * 0.2, 5, 3, 0.5, "rgba(190,200,170,0.75)"); }   // plate gills
        line(242, 95, 276, 84, dark, 2); line(242, 95, 280, 95, dark, 2); line(242, 95, 276, 106, dark, 2);   // three tails
      }
    } else if (kind === "arrowworm"){                                  // slender transparent body, fins, head hooks
      ell(182, 95, 74, 7, 0, "rgba(214,232,238,0.85)", "rgba(160,190,200,0.9)");
      ctx.fillStyle = "rgba(190,215,225,0.7)";
      [[205, 1], [205, -1], [160, 1], [160, -1]].forEach(function(f){ ctx.beginPath(); ctx.moveTo(f[0] - 16, 95 + f[1] * 5); ctx.lineTo(f[0] + 14, 95 + f[1] * 5); ctx.lineTo(f[0] + 6, 95 + f[1] * 16); ctx.closePath(); ctx.fill(); });
      ctx.beginPath(); ctx.moveTo(254, 95); ctx.lineTo(272, 80); ctx.lineTo(272, 110); ctx.closePath(); ctx.fill();   // tail fin
      for (i = 0; i < 4; i++){ line(110, 92, 98 - i * 2, 80 + i * 3, "#e8d9a6", 1.6); line(110, 98, 98 - i * 2, 110 - i * 3, "#e8d9a6", 1.6); }   // grasping spines
      ell(118, 91, 2, 2, 0, "#25303a"); ell(118, 99, 2, 2, 0, "#25303a");
    }
    ctx.restore();
  }
  function makeBuiltinPlaceholderTexture(asset){
    var c=document.createElement("canvas"); c.width=360; c.height=240; var ctx=c.getContext("2d");
    var colors={1:"#4ade80",2:"#facc15",3:"#fb923c",4:"#f87171"};
    // Microscopic organisms share the microscope icon; organisms with no accurate emoji get a small drawing.
    var icons={"tl1-diatoms":"🔬","tl1-dinoflagellates":"🔬","tl1-green-microalgae":"🔬","tl2-copepod":"🔬","tl2-krill":"🦐","tl2-ciliate":"🔬","tl2-pteropod":"🐚","tl3-herring":"🐟","tl3-anchovy":"🐟","tl3-arrow-worm":"draw:arrowworm","tl4-blue-shark":"🦈",
               "pond-tl1-hydrilla":"🌿","pond-tl1-spirogyra":"🔬","pond-tl1-lotus":"draw:lotus","pond-tl2-daphnia":"🔬","pond-tl2-snail":"🐌","pond-tl2-tadpole":"draw:tadpole","pond-tl2-mayfly-nymph":"draw:mayfly","pond-tl3-small-fish":"🐟","pond-tl3-frog":"🐸","pond-tl3-dragonfly-nymph":"draw:dragonfly","pond-tl4-water-snake":"🐍"};
    ctx.fillStyle="#0b1220";ctx.fillRect(0,0,360,240);ctx.strokeStyle=colors[asset.trophicLevel];ctx.lineWidth=6;ctx.strokeRect(10,10,340,220);
    var icon=icons[asset.id]||"●";
    if(icon.indexOf("draw:")===0) drawPlaceholderGlyph(ctx,icon.slice(5));
    else { ctx.font="82px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(icon,180,95); }
    ctx.textAlign="center";ctx.textBaseline="middle";
    ctx.font="700 22px Roboto, 'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";ctx.fillStyle="#e7ecf5";ctx.fillText(asset.label.replace(/^TL\d · /,""),180,166);
    ctx.font="14px Roboto, 'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";ctx.fillStyle=colors[asset.trophicLevel];ctx.fillText("IMAGE PLACEHOLDER",180,201);
    var texture=new THREE.CanvasTexture(c);texture.needsUpdate=true;return texture;
  }
  function applyBuiltinPlaceholder(asset,slot){
    if(!slot.builtinTexture)slot.builtinTexture=makeBuiltinPlaceholderTexture(asset);
    slot.material.map=slot.builtinTexture;slot.sprite.scale.set(slot.maxImageHeight*1.5,slot.maxImageHeight,1);slot.sprite.visible=asset.status!=="deadMatter";
  }
  function loadOrganismImage(asset, slot){
    if(asset.imageUrl.indexOf("builtin:")===0){applyBuiltinPlaceholder(asset,slot);return;}
    var requestedUrl = asset.imageUrl;
    var oldTexture = slot.material.map;
    slot.sprite.userData.imageUrl = requestedUrl;
    organismTextureLoader.load(
      requestedUrl,
      function(texture){
        if (asset.imageUrl !== requestedUrl){
          texture.dispose();
          return;
        }
        if (oldTexture && oldTexture !== texture && oldTexture !== slot.builtinTexture) oldTexture.dispose();   // the drawn fallback card is kept for reuse
        texture.needsUpdate = true;
        slot.material.map = texture;
        var image = texture.image;
        var ratio = (image && image.height) ? image.width / image.height : 1;
        slot.sprite.scale.set(slot.maxImageHeight * ratio, slot.maxImageHeight, 1);
        slot.sprite.visible = asset.status !== "deadMatter";
        updateOrganismEditorPreview(asset.id, requestedUrl, true);
      },
      undefined,
      function(){
        // A link that won't load falls back to the drawn placeholder card instead of vanishing,
        // so there is always something on the pyramid to long-press and fix.
        if (asset.imageUrl === requestedUrl){
          if (oldTexture && oldTexture !== slot.builtinTexture) oldTexture.dispose();
          applyBuiltinPlaceholder(asset, slot);
        }
        updateOrganismEditorPreview(asset.id, requestedUrl, false);
        console.warn("Organism asset unavailable:", requestedUrl);
      }
    );
  }

  function updateOrganismEditorPreview(id, url, loaded){
    var preview = organismEditorPreviews[id];
    if (!preview) return;
    preview.src = url;
    preview.classList.toggle("missing", !loaded);
  }

  function addOrganismAsset(asset){
    var layer = layers[asset.trophicLevel - 1];
    if (!layer) return;

    var placeY = layer.yBottom + (layer.yTop - layer.yBottom) * asset.y;
    var hw = halfW(placeY);
    var hd = halfD(placeY);
    // Placeholders are billboards, so front/back depth does not limit their
    // on-screen size; only the layer's own thickness caps the image height.
    var maxImageHeight = Math.min(
      asset.scale,
      (layer.yTop - layer.yBottom) * 0.9
    );
    var material = new THREE.SpriteMaterial({
      transparent:true,
      opacity:asset.opacity,
      depthTest:false,
      depthWrite:false
    });
    var sprite = new THREE.Sprite(material);
    // The sprite remains at a genuine interior X/Y/Z position. It is
    // rendered after the translucent prism face only to preserve the
    // photographic silhouette at mobile size; it is not a selection target.
    sprite.position.set(asset.x * hw, placeY, asset.z * hd);
    sprite.renderOrder = 2;
    sprite.scale.set(maxImageHeight, maxImageHeight, 1);
    sprite.userData = {
      organismId:asset.id,
      trophicLevel:asset.trophicLevel,
      status:asset.status,
      imageUrl:asset.imageUrl,
      asset:asset
    };
    sprite.visible = false;
    scene.add(sprite);
    embeddedOrganisms.push(sprite);
    organismSlots[asset.id] = {
      asset:asset,
      sprite:sprite,
      material:material,
      maxImageHeight:maxImageHeight,
      baseOpacity:asset.opacity,
      deadMatter:null
    };
    loadOrganismImage(asset, organismSlots[asset.id]);
  }
  ORGANISM_ASSETS.forEach(addOrganismAsset);

  function updateOrganismAssetUrl(id, url){
    var asset = ORGANISM_ASSETS.filter(function(item){ return item.id === id; })[0];
    var slot = organismSlots[id];
    if (!asset || !slot) return;
    asset.imageUrl = (url || "").trim();
    if (!asset.imageUrl) {
      slot.sprite.visible = false;
      if (slot.material.map){
        slot.material.map.dispose();
        slot.material.map = null;
      }
      updateOrganismEditorPreview(id, "", false);
    } else {
      loadOrganismImage(asset, slot);
    }
    saveOrganismUrls();
  }

  function renderOrganismEditor(){
    var list = document.getElementById("organismEditorList");
    if (!list) return;
    list.innerHTML = "";
    organismEditorInputs = {};
    organismEditorPreviews = {};
    ORGANISM_ASSETS.forEach(function(asset){
      var row = document.createElement("div");
      row.className = "organism-editor-row";
      row.dataset.organismId = asset.id;

      var preview = document.createElement("img");
      preview.className = "organism-editor-preview missing";
      preview.alt = asset.label + " preview";
      preview.src = asset.imageUrl;
      preview.addEventListener("load", function(){ preview.classList.remove("missing"); });
      preview.addEventListener("error", function(){ preview.classList.add("missing"); });
      row.appendChild(preview);

      var meta = document.createElement("div");
      meta.className = "organism-editor-meta";
      var label = document.createElement("label");
      label.className = "organism-editor-label";
      label.textContent = asset.label;
      meta.appendChild(label);

      var input = document.createElement("input");
      input.className = "organism-editor-input";
      input.type = "url";
      input.placeholder = "https://.../organism.webp";
      input.value = asset.imageUrl;
      input.setAttribute("aria-label", asset.label + " image URL");
      input.addEventListener("change", function(){
        updateOrganismAssetUrl(asset.id, input.value);
      });
      input.addEventListener("keydown", function(e){
        if (e.key === "Enter"){
          e.preventDefault();
          updateOrganismAssetUrl(asset.id, input.value);
          input.blur();
        }
      });
      meta.appendChild(input);
      row.appendChild(meta);
      list.appendChild(row);
      organismEditorInputs[asset.id] = input;
      organismEditorPreviews[asset.id] = preview;
    });
  }

  function focusOrganismEditor(id){
    var input = organismEditorInputs[id];
    if (!input) return;
    input.focus();
    input.select();
  }

  function setOrganismEditorOpen(isOpen){
    organismEditorOpen = !!isOpen;
    var panel = document.getElementById("organismEditorPanel");
    if (!panel) return;
    panel.classList.toggle("open", organismEditorOpen);
    var toggleBtn = document.getElementById("organismEditorToggle");            // icon shows the open state
    if (toggleBtn){ toggleBtn.classList.toggle("active", organismEditorOpen); toggleBtn.setAttribute("aria-expanded", organismEditorOpen ? "true" : "false"); }
    if (organismEditorOpen){ renderOrganismEditor(); a11yOpen(panel, document.getElementById("organismEditorClose")); }
    else { a11yClose(panel); }
  }

  // Press-and-hold gesture for a DOM control (used below to restore organism placeholders and to
  // unlock the image-URL editor). Same 600 ms threshold/10px tolerance as the pyramid's own long-press,
  // so holding feels consistent everywhere. Returns { fired } — a click handler checks and clears this
  // to tell a completed hold apart from the ordinary click that follows the pointer release.
  function bindHoldGesture(el, onHold, ms, onProgress){
    var dur = ms || LONG_PRESS_MS;
    var st = { fired:false, active:false, t0:0, sx:0, sy:0, raf:0 };
    function stop(){ st.active = false; if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0; el.style.removeProperty("--hold"); if (onProgress) onProgress(-1); }
    function tick(now){
      if (!st.active) return;
      var k = Math.min(1, (now - st.t0) / dur);
      // A held gesture is functional feedback, not decorative motion, so unlike other animation in
      // this app it keeps updating even with reduced motion requested; only the smooth ramp is skipped.
      el.style.setProperty("--hold", (ecoReduceMotionMQ && ecoReduceMotionMQ.matches) ? Math.round(k) : k.toFixed(3));
      if (onProgress) onProgress(dur - (now - st.t0));
      if (k >= 1){ st.fired = true; stop(); onHold(); return; }
      st.raf = requestAnimationFrame(tick);
    }
    el.addEventListener("pointerdown", function(e){
      if (e.button !== undefined && e.button !== 0) return;
      st.active = true; st.fired = false; st.t0 = performance.now(); st.sx = e.clientX; st.sy = e.clientY;
      st.raf = requestAnimationFrame(tick);
    });
    el.addEventListener("pointermove", function(e){
      if (st.active && Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > LONG_PRESS_MOVE_TOLERANCE) stop();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function(type){ el.addEventListener(type, stop); });
    return st;
  }

  // Undoes what Simulate mortality did to ONE organism — status, sprite visibility/opacity/tint, the
  // level's living-biomass share, the floating debris fragment, and the body that fell to the soil — all
  // without touching asset.imageUrl, so whatever image (built-in or a custom URL) it had stays exactly as is.
  function reviveOrganism(asset){
    if (asset.status === "living") return false;
    var slot = organismSlots[asset.id];
    var def = TROPHIC_DATA[asset.trophicLevel - 1];
    def.livingBiomass = Math.min(100, def.livingBiomass + asset.biomassContribution);   // undo finishMortality's subtraction
    asset.status = "living";
    if (slot){
      slot.sprite.userData.status = "living";
      slot.sprite.visible = true;
      slot.sprite.material.opacity = slot.baseOpacity;
      slot.sprite.material.color.setRGB(1, 1, 1);
      if (slot.deadMatter){                                       // remove the floating debris fragment
        scene.remove(slot.deadMatter);
        slot.deadMatter.material.dispose();                        // unique per fragment — its texture map is shared and stays
        var di = deadMatterSprites.indexOf(slot.deadMatter);
        if (di !== -1) deadMatterSprites.splice(di, 1);
        slot.deadMatter = null;
      }
    }
    for (var i = remainsList.length - 1; i >= 0; i--){              // remove the body that fell to the soil
      if (remainsList[i].asset === asset) { remainsRoot.remove(remainsList[i].group); remainsList.splice(i, 1); }
    }
    return true;
  }

  // Long-press action: bring back every organism mortality removed, images untouched.
  function reviveDeadOrganisms(){
    var any = false;
    ORGANISM_ASSETS.forEach(function(asset){ if (reviveOrganism(asset)) any = true; });
    if (any){ updateBiomassUI(selectedId); updateMortalityControl(); }
    return any;
  }

  // The panel's explicit "Restore placeholders" button: also revives (a dead organism's placeholder was
  // missing too), then additionally resets every image back to the built-in placeholder.
  function restoreAllOrganismPlaceholders(){
    ORGANISM_ASSETS.forEach(function(asset){
      reviveOrganism(asset);
      asset.imageUrl = defaultOrganismUrls[asset.id];
      if (organismSlots[asset.id]) loadOrganismImage(asset, organismSlots[asset.id]);
    });
    saveOrganismUrls();
    updateBiomassUI(selectedId);
    updateMortalityControl();
    if (organismEditorOpen) renderOrganismEditor();   // refresh the open panel's previews too
  }

  // Locked by default: opening the panel takes a full 15 s hold (long enough that it can't happen by
  // accident), announced every 3 s for screen-reader users since a plain tap gives no other feedback.
  // Closing it — Close, Done, or tapping the pencil again — always relocks: "locked" IS "closed" here,
  // there is no separate flag to reset, so nothing can carry an unlocked state into a reload.
  var organismEditorToggleEl = document.getElementById("organismEditorToggle");
  var organismLockStatusEl = document.getElementById("organismLockStatus");
  var orgLockAnnounceAt = -1;
  var orgEditorHold = bindHoldGesture(organismEditorToggleEl, function(){
    organismLockStatusEl.textContent = "Unlocked";
    setOrganismEditorOpen(true);
  }, 15000, function(msLeft){
    if (msLeft < 0){ orgLockAnnounceAt = -1; organismLockStatusEl.textContent = ""; return; }   // a cancelled hold shouldn't leave a stale countdown for screen readers
    var secLeft = Math.ceil(msLeft / 1000);
    if (secLeft !== orgLockAnnounceAt && secLeft % 3 === 0){ orgLockAnnounceAt = secLeft; organismLockStatusEl.textContent = "Hold " + secLeft + " more seconds to unlock"; }
  });
  organismEditorToggleEl.addEventListener("click", function(e){
    if (orgEditorHold.fired){ orgEditorHold.fired = false; return; }   // the hold already unlocked and opened it
    if (organismEditorOpen){ setOrganismEditorOpen(false); return; }   // open: a plain tap closes (and relocks)
    if (e.detail === 0){ setOrganismEditorOpen(true); return; }        // keyboard activation (Enter/Space) isn't a holdable gesture
    organismEditorToggleEl.classList.remove("locked-nudge"); void organismEditorToggleEl.offsetWidth; organismEditorToggleEl.classList.add("locked-nudge");
  });
  document.getElementById("organismEditorClose").addEventListener("click", function(){
    setOrganismEditorOpen(false);
  });
  document.getElementById("organismEditorDone").addEventListener("click", function(){
    setOrganismEditorOpen(false);
  });
  document.getElementById("organismEditorReset").addEventListener("click", restoreAllOrganismPlaceholders);

  // ---- Long-press an organism picture on the pyramid -> small box to change its image link ----
  var organismUrlBoxEl = document.getElementById("organismUrlBox");
  var organismUrlInputEl = document.getElementById("organismUrlInput");
  var organismUrlThumbEl = document.getElementById("organismUrlThumb");
  var organismUrlBoxId = null;
  function organismUrlBoxOpen(){ return !organismUrlBoxEl.hidden; }
  function showOrganismUrlThumb(url){
    organismUrlThumbEl.classList.remove("missing");
    organismUrlThumbEl.src = url || "";
    if (!url) organismUrlThumbEl.classList.add("missing");
  }
  organismUrlThumbEl.addEventListener("error", function(){ organismUrlThumbEl.classList.add("missing"); });
  function openOrganismUrlBox(id){
    var slot = organismSlots[id];
    if (!slot) return;
    organismUrlBoxId = id;
    document.getElementById("organismUrlName").textContent = slot.asset.label.replace(/^TL\d · /, "");
    organismUrlInputEl.value = slot.asset.imageUrl;
    showOrganismUrlThumb(slot.asset.imageUrl);
    organismUrlBoxEl.classList.remove("invalid");
    organismUrlBoxEl.hidden = false;
    organismUrlInputEl.focus();
    organismUrlInputEl.select();
  }
  function closeOrganismUrlBox(){
    organismUrlBoxEl.hidden = true;
    organismUrlBoxId = null;
  }
  function applyOrganismUrlBox(){
    if (!organismUrlBoxId) return;
    var v = organismUrlInputEl.value.trim();
    if (/^(javascript|vbscript):/i.test(v) || /^data:(?!image\/)/i.test(v)){ organismUrlBoxEl.classList.add("invalid"); return; }
    updateOrganismAssetUrl(organismUrlBoxId, v || defaultOrganismUrls[organismUrlBoxId]);   // blank = back to the original picture
    if (organismEditorOpen) renderOrganismEditor();
    closeOrganismUrlBox();
  }
  document.getElementById("organismUrlApply").addEventListener("click", applyOrganismUrlBox);
  document.getElementById("organismUrlCancel").addEventListener("click", closeOrganismUrlBox);
  document.getElementById("organismUrlOriginal").addEventListener("click", function(){
    if (!organismUrlBoxId) return;
    organismUrlInputEl.value = defaultOrganismUrls[organismUrlBoxId];
    showOrganismUrlThumb(organismUrlInputEl.value);
    organismUrlBoxEl.classList.remove("invalid");
  });
  organismUrlInputEl.addEventListener("input", function(){ organismUrlBoxEl.classList.remove("invalid"); });
  organismUrlInputEl.addEventListener("change", function(){ showOrganismUrlThumb(organismUrlInputEl.value.trim()); });
  organismUrlInputEl.addEventListener("keydown", function(e){
    if (e.key === "Enter"){ e.preventDefault(); applyOrganismUrlBox(); }
  });

  // Which visible organism picture (if any) is under this screen point. Pictures are drawn on top
  // of the pyramid, so they win over the layer behind them.
  function pickOrganismAt(clientX, clientY){
    var rect = renderer.domElement.getBoundingClientRect();
    var n = new THREE.Vector2(((clientX-rect.left)/rect.width)*2-1, -(((clientY-rect.top)/rect.height)*2-1));
    raycaster.setFromCamera(n, camera);
    var visible = embeddedOrganisms.filter(function(sp){ return sp.visible && sp.userData.status !== "deadMatter"; });
    var hits = raycaster.intersectObjects(visible, false);
    return hits.length ? hits[0].object.userData.organismId : null;
  }

  // =========================================================
  // CONTROLLED NON-PREDATORY MORTALITY — development demo only
  //
  // This is deliberately independent from trophic energy, PAR,
  // layer geometry and layer selection. An organism remains in
  // the manifest and moves through explicit living -> dying ->
  // deadMatter states; it is never deleted or consumed.
  // =========================================================
  var MORTALITY_TRANSITION_DURATION = 1.25;
  var deadMatterSprites = [];

  function createDeadMatter(slot){
    if (slot.deadMatter) return;
    var asset = slot.asset;
    var material = new THREE.SpriteMaterial({
      map:deadMatterTexture,
      color:0x8b7659,
      transparent:true,
      opacity:0.52,
      depthTest:false,
      depthWrite:false
    });
    var fragment = new THREE.Sprite(material);
    fragment.position.copy(slot.sprite.position);
    fragment.scale.setScalar(Math.max(0.12, Math.min(0.26, slot.maxImageHeight * 0.22)));
    fragment.renderOrder = 2;
    fragment.userData = {
      organismId:asset.id,
      age:0,
      velocity:new THREE.Vector3(
        asset.x >= 0 ? 0.035 : -0.035,
        -0.055,
        asset.z >= 0.5 ? 0.012 : -0.012
      )
    };
    scene.add(fragment);
    slot.deadMatter = fragment;
    deadMatterSprites.push(fragment);
  }

  function triggerMortality(){
    if (selectedId === null) return false;
    var candidate = null;
    for (var i=0;i<ORGANISM_ASSETS.length;i++){
      var asset = ORGANISM_ASSETS[i];
      if (asset.trophicLevel === selectedId && asset.status === "living"){
        candidate = asset;
        break;
      }
    }
    if (!candidate) return false;
    candidate.status = "dying";
    candidate.mortalityStartedAt = elapsed;
    var slot = organismSlots[candidate.id];
    if (slot){
      slot.sprite.userData.status = "dying";
      // The organism stays at this exact position throughout the fade.
      slot.sprite.material.color.setRGB(1, 1, 1);
    }
    updateMortalityControl();
    if (DEV_MODE) console.log("Non-predatory mortality:", candidate.id, "TL" + candidate.trophicLevel);
    return true;
  }

  function finishMortality(asset, slot){
    asset.status = "deadMatter";
    var def = TROPHIC_DATA[asset.trophicLevel - 1];
    def.livingBiomass = Math.max(0, def.livingBiomass - asset.biomassContribution);
    slot.sprite.userData.status = "deadMatter";
    slot.sprite.visible = false;
    slot.sprite.material.opacity = 0;
    createDeadMatter(slot);
    spawnRemains(asset, slot); // the body falls to the soil and is broken down in stages
    updateBiomassUI(asset.trophicLevel);
    updateMortalityControl();
  }

  function updateMortalityAnimations(elapsedTime, delta){
    ORGANISM_ASSETS.forEach(function(asset){
      if (asset.status !== "dying") return;
      var slot = organismSlots[asset.id];
      if (!slot) return;
      var t = THREE.MathUtils.clamp(
        (elapsedTime - asset.mortalityStartedAt) / MORTALITY_TRANSITION_DURATION,
        0, 1
      );
      var eased = t*t*(3 - 2*t);
      // Fade activity without moving the living sprite. The warm neutral
      // tint is a restrained desaturation/dimming cue, not an injury cue.
      slot.sprite.material.opacity = slot.baseOpacity * (1 - eased*0.82);
      var tone = 1 - eased*0.42;
      slot.sprite.material.color.setRGB(tone, tone*0.97, tone*0.90);
      if (t >= 1) finishMortality(asset, slot);
    });

    deadMatterSprites.forEach(function(fragment){
      if (!fragment.visible) return;
      fragment.userData.age += delta;
      fragment.position.addScaledVector(fragment.userData.velocity, delta);
      fragment.material.opacity = Math.max(0.18, 0.52 - fragment.userData.age*0.045);
    });
  }

  // ---- Decomposers: fungi cluster + a few spore/bacteria marks ----
  // Not one of the four modelled trophic levels, so this lives near
  // the ground rather than on any prism layer — see placement below.
  var ICON_OUTLINE = "#241f16";
  function drawDecomposerIcon(ctx, s){
    function mushroom(x, y, scale){
      ctx.save(); ctx.translate(x,y); ctx.scale(scale, scale);
      ctx.beginPath(); ctx.rect(-s*0.025, 0, s*0.05, s*0.16);
      ctx.fillStyle = "#e8ddc4"; ctx.fill();
      ctx.lineWidth = s*0.012; ctx.strokeStyle = ICON_OUTLINE; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, s*0.13, s*0.09, 0, Math.PI, Math.PI*2);
      ctx.fillStyle = "#c9a876"; ctx.fill();
      ctx.lineWidth = s*0.014; ctx.strokeStyle = "#8a6b45"; ctx.stroke();
      ctx.restore();
    }
    mushroom(s*0.42, s*0.68, 1.0);
    mushroom(s*0.63, s*0.80, 0.62);
    ctx.fillStyle = "#c9a876";
    [[0.26,0.88],[0.78,0.58],[0.18,0.60],[0.85,0.86]].forEach(function(p){
      ctx.beginPath(); ctx.arc(s*p[0], s*p[1], s*0.012, 0, Math.PI*2); ctx.fill();
    });
  }

  // ---- Direction arrow: drawn neutral, tinted per gap instance ----
  function drawArrowIcon(ctx, s){
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(s*0.5, s*0.08); ctx.lineTo(s*0.82, s*0.42); ctx.lineTo(s*0.60, s*0.42);
    ctx.lineTo(s*0.60, s*0.92); ctx.lineTo(s*0.40, s*0.92); ctx.lineTo(s*0.40, s*0.42);
    ctx.lineTo(s*0.18, s*0.42); ctx.closePath();
    ctx.fill();
  }

  var decomposerIconTex = iconTexture(drawDecomposerIcon);
  var arrowIconTex      = iconTexture(drawArrowIcon, 64);

  // Soil + decomposers, near the ground — independent of the four
  // prism layers since decomposition isn't one of them.
  var soilTexture = (function(){
    var size = 256;
    var c = document.createElement("canvas"); c.width = c.height = size;
    var sctx = c.getContext("2d");
    var grad = sctx.createRadialGradient(size/2,size/2,0, size/2,size/2,size/2);
    grad.addColorStop(0, "rgba(70,68,56,0.55)");
    grad.addColorStop(0.7, "rgba(52,52,44,0.26)");
    grad.addColorStop(1, "rgba(30,34,32,0)");
    sctx.fillStyle = grad; sctx.fillRect(0,0,size,size);
    return new THREE.CanvasTexture(c);
  })();
  var soilMesh = new THREE.Mesh(
    new THREE.CircleGeometry(BASE_HALF_WIDTH*1.12, 40),   // fixed size: the pyramid floor is now narrow
    new THREE.MeshBasicMaterial({ map:soilTexture, transparent:true, depthWrite:false })
  );
  soilMesh.rotation.x = -Math.PI/2;
  soilMesh.position.y = 0.015;
  scene.add(soilMesh);

  var legacyFungiSprites = [];
  [-1, 1].forEach(function(side){
    var mat = new THREE.SpriteMaterial({ map:decomposerIconTex, transparent:true, opacity:0.85, depthWrite:false });
    var sprite = new THREE.Sprite(mat);
    var ang = side*0.9;
    var r = 3.69;   // the original spots in front of the pyramid (independent of the inverted envelope)
    sprite.position.set(Math.sin(ang)*r, 0.18, Math.cos(ang)*r + 1.6);
    sprite.scale.set(0.85, 0.85, 1);
    scene.add(sprite);
    legacyFungiSprites.push(sprite); // hidden by the 3D decomposer habitat below
  });

  // One direction arrow per gap (Sun->TL1 already has its own clear
  // travelling-particle motion, so it doesn't need a static arrow too).
  gaps.forEach(function(gap){
    var midY = (gap.yBottom + gap.yTop)/2;
    var col = new THREE.Color(gap.colorA).lerp(new THREE.Color(gap.colorB), 0.5);
    var mat = new THREE.SpriteMaterial({
      map:arrowIconTex, color:col, transparent:true, opacity:0.5, depthWrite:false
    });
    var sprite = new THREE.Sprite(mat);
    sprite.position.set(0, midY, halfD(midY)*0.55);
    sprite.scale.set(0.55, 0.55, 1);
    scene.add(sprite);
  });

  // =========================================================
  // SOLAR SYSTEM — Phase 2 / 2A / 2B
  //
  // Self-contained: the Sun's own visuals/state live here and
  // know nothing about layer selection, gaps, or the future
  // trophic-transfer engine. Its only export into the rest of
  // the app is solarState.energyDelivered (read-only) and the
  // two entry points activateSun() / cancelCurrentSimulation(),
  // plus one narrow hook into TL1's mesh
  // (userData.producerGlowAmount).
  //
  // Phase 2B model: every activation is a "run" with its own
  // numeric id. Exactly one run can be in flight at a time. The
  // whole thing is driven by comparing `elapsed` against times
  // stored on the CURRENT run object each frame — there are no
  // setTimeouts and no per-object closures capturing stale data,
  // so cancelling is just: null out `run`, set state to IDLE.
  // Every branch below is gated on the current `state`/`run`, so
  // a cancelled run's leftover numbers can never be acted on.
  // =========================================================
  // Aquatic fork: moved farther from the pyramid (x -6.2 -> -9.8). y = 2.6 keeps the PAR ray start heights
  // (SUN y + up to 0.5 = 3.1) below TL2's floor (y = 3.8) — see buildRayCurve.
  // Pond (upright pyramid): the Sun sits HIGH in the sky, upper left. Its rays slant down onto TL1's
  // exposed outer face, which sticks out beyond TL2-TL4, so no ray crosses a consumer tier (checked in
  // buildRayCurve). Open sea keeps the low Sun: the wider upper tiers overhang the narrow TL1 there.
  var SUN_POSITION = IS_POND ? new THREE.Vector3(-9.0, 11.5, 0) : new THREE.Vector3(-9.8, 2.6, 0);
  var SUN_INACTIVE_COLOR = new THREE.Color(0x4a4030);
  var SUN_ACTIVE_COLOR   = new THREE.Color(0xffd479);
  var SUN_INACTIVE_EMISSIVE = new THREE.Color(0x1a140a);
  var SUN_ACTIVE_EMISSIVE   = new THREE.Color(0xffae42);

  var SIM_STATE = {
    IDLE: "IDLE",
    SUN_ACTIVATING: "SUN_ACTIVATING",
    PAR_EMITTING: "PAR_EMITTING",
    WAITING_FOR_PAR_CONTACT: "WAITING_FOR_PAR_CONTACT",
    PRODUCER_ACTIVATING: "PRODUCER_ACTIVATING",
    PRODUCER_ENERGISED: "PRODUCER_ENERGISED"
  };
  var SUN_ACTIVATION_DURATION = 0.2;      // seconds — T=0..200ms, "Sun performs its activation transition"
  var PRODUCER_TRANSITION_DURATION = 0.5; // seconds — TL1 inactive -> fully energised ramp
  var RAY_VISUAL_SPEED = 4.5;             // units/second — a *visualisation* speed, not physical light speed
  var RAY_TRAVEL_MIN = 2.2, RAY_TRAVEL_MAX = 3.6; // slow enough to follow: PAR reaches TL1 about 2.2 s after the tap (step 1)

  var simulationRunId = 0;   // incremented once per activation — the "unique run" counter
  var simState = SIM_STATE.IDLE;
  var run = null;            // the single in-flight run's timing data, or null when IDLE
  // run = { id, startElapsed, parStartedAtElapsed, producerContactAtElapsed, producerActivationStartElapsed }

  var solarState = { energyDelivered: 0 }; // the one thing outside this module is allowed to read

  var sunGroup = new THREE.Group();
  sunGroup.position.copy(SUN_POSITION);
  scene.add(sunGroup);

  var sunCoreMat = new THREE.MeshPhongMaterial({
    color: SUN_INACTIVE_COLOR.clone(),
    emissive: SUN_INACTIVE_EMISSIVE.clone(),
    emissiveIntensity: 0.9,
    shininess: 18,
    specular: 0x221d16
  });
  var sunCore = new THREE.Mesh(new THREE.SphereGeometry(1.15, 28, 20), sunCoreMat);
  sunGroup.add(sunCore);

  // Larger, fully transparent sphere = the actual tap/click target
  // (bigger hit area than the visible core, friendlier on touch).
  var sunHitMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1.9, 12, 10),
    new THREE.MeshBasicMaterial({ transparent:true, opacity:0, depthWrite:false })
  );
  sunGroup.add(sunHitMesh);

  var sunCoronaInner = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: 0xffb84d, transparent:true, opacity:0.05,
    blending: THREE.AdditiveBlending, depthWrite:false
  }));
  sunCoronaInner.scale.set(3.2, 3.2, 1);
  sunGroup.add(sunCoronaInner);

  var sunCoronaOuter = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: 0xff9f3d, transparent:true, opacity:0.03,
    blending: THREE.AdditiveBlending, depthWrite:false
  }));
  sunCoronaOuter.scale.set(5.6, 5.6, 1);
  sunGroup.add(sunCoronaOuter);

  // ---------------------------------------------------------
  // Ambient sunburst — purely decorative. Straight rays radiate
  // from random points across the WHOLE sun surface in every
  // direction (uniform sphere sampling), unlike the single
  // curved PAR beam below which is the one functional pathway
  // aimed specifically at producers. The sunburst carries no
  // energy and never touches solarState.energyDelivered or any
  // layer's userData — it only reads simState to know
  // whether to be visible. One LineSegments draw call, geometry
  // built once and never recreated (same rule as the PAR pool).
  // ---------------------------------------------------------
  var N_SUNBURST = 46;
  var sunburstPositions = new Float32Array(N_SUNBURST * 2 * 3);
  var sunburstColors = new Float32Array(N_SUNBURST * 2 * 3);
  var sunburstPhase = new Float32Array(N_SUNBURST);
  var sunburstSpeed = new Float32Array(N_SUNBURST);
  // Shortens a decorative ray so its tip stays outside every trophic prism (0.15 margin).
  function clipSunburstLen(dx, dy, dz, coreR, len){
    for (var t = coreR + 0.2; t <= coreR + len; t += 0.1){
      var wx = SUN_POSITION.x + dx * t, wy = SUN_POSITION.y + dy * t, wz = SUN_POSITION.z + dz * t;
      for (var li = 0; li < layers.length; li++){
        var L = layers[li];
        if (wy < L.yBottom - 0.15 || wy > L.yTop + 0.15) continue;
        var hw = halfW(wy) + 0.15, hd = halfD(wy) + 0.15;
        var F = [0, hd], R = [0.866 * hw, -0.5 * hd], Lf = [-0.866 * hw, -0.5 * hd];
        function sd(a, b){ return (wx - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (wz - b[1]); }
        var d1 = sd(F, R), d2 = sd(R, Lf), d3 = sd(Lf, F);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return Math.max(0.3, t - coreR - 0.1);
      }
    }
    return len;
  }
  (function buildSunburst(){
    var coreR = 1.15;
    for (var i=0;i<N_SUNBURST;i++){
      // Uniform random direction on the sphere
      var u = Math.random(), v = Math.random();
      var theta = 2*Math.PI*u;
      var phi = Math.acos(2*v - 1);
      var dx = Math.sin(phi)*Math.cos(theta);
      var dy = Math.sin(phi)*Math.sin(theta);
      var dz = Math.cos(phi);
      var len = 1.3 + Math.random()*2.6;
      len = clipSunburstLen(dx, dy, dz, coreR, len); // never poke into the pyramid
      var i6 = i*6;
      sunburstPositions[i6]   = dx*coreR;
      sunburstPositions[i6+1] = dy*coreR;
      sunburstPositions[i6+2] = dz*coreR;
      sunburstPositions[i6+3] = dx*(coreR+len);
      sunburstPositions[i6+4] = dy*(coreR+len);
      sunburstPositions[i6+5] = dz*(coreR+len);
      sunburstPhase[i] = Math.random()*Math.PI*2;
      sunburstSpeed[i] = 0.8 + Math.random()*1.1;
    }
  })();
  var sunburstGeo = new THREE.BufferGeometry();
  sunburstGeo.setAttribute("position", new THREE.BufferAttribute(sunburstPositions, 3));
  sunburstGeo.setAttribute("color", new THREE.BufferAttribute(sunburstColors, 3));
  var sunburstMat = new THREE.LineBasicMaterial({
    vertexColors:true, transparent:true, opacity:1,
    blending: THREE.AdditiveBlending, depthWrite:false
  });
  var sunburstRays = new THREE.LineSegments(sunburstGeo, sunburstMat);
  sunburstRays.visible = false;
  sunGroup.add(sunburstRays);
  var SUNBURST_COLOR = new THREE.Color(0xffcf7a);

  function updateSunburst(elapsedTime, fadeIn){
    if (!sunburstRays.visible) return;
    for (var i=0;i<N_SUNBURST;i++){
      var tw = 0.4 + 0.6*(0.5+0.5*Math.sin(elapsedTime*sunburstSpeed[i] + sunburstPhase[i]));
      var b = tw*fadeIn;
      var i6 = i*6;
      // inner vertex (near the surface) slightly brighter than the tip
      sunburstColors[i6]   = SUNBURST_COLOR.r*b;
      sunburstColors[i6+1] = SUNBURST_COLOR.g*b;
      sunburstColors[i6+2] = SUNBURST_COLOR.b*b;
      sunburstColors[i6+3] = SUNBURST_COLOR.r*b*0.15;
      sunburstColors[i6+4] = SUNBURST_COLOR.g*b*0.15;
      sunburstColors[i6+5] = SUNBURST_COLOR.b*b*0.15;
    }
    sunburstGeo.attributes.color.needsUpdate = true;
  }

  // One-shot activation flash (reused each activation, never recreated)
  var activationFlash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: 0xfff2cf, transparent:true, opacity:0,
    blending: THREE.AdditiveBlending, depthWrite:false
  }));
  activationFlash.scale.set(1, 1, 1);
  activationFlash.visible = false;
  sunGroup.add(activationFlash);
  var flashStartElapsed = null;

  var sunData = { currentGlow: 0, targetGlow: 0 };

  function updateSun(elapsedTime){
    sunData.currentGlow += (sunData.targetGlow - sunData.currentGlow) * 0.06;
    var g = sunData.currentGlow;

    sunCoreMat.color.copy(SUN_INACTIVE_COLOR).lerp(SUN_ACTIVE_COLOR, g);
    sunCoreMat.emissive.copy(SUN_INACTIVE_EMISSIVE).lerp(SUN_ACTIVE_EMISSIVE, g);
    sunCoreMat.emissiveIntensity = 0.12 + g*1.3;

    var pulse = (simState !== SIM_STATE.IDLE) ? (1 + 0.05*Math.sin(elapsedTime*1.6)) : 1;
    sunCoronaInner.material.opacity = (0.05 + g*0.55) * pulse;
    sunCoronaOuter.material.opacity = (0.03 + g*0.28) * pulse;
    sunCoronaInner.scale.setScalar(3.2*pulse);
    sunCoronaOuter.scale.setScalar(5.6*pulse);

    updateSunburst(elapsedTime, g);


    if (flashStartElapsed !== null){
      var ft = (elapsedTime - flashStartElapsed) / 0.6;
      if (ft >= 1){
        activationFlash.visible = false;
        flashStartElapsed = null;
      } else {
        activationFlash.visible = true;
        activationFlash.scale.setScalar(THREE.MathUtils.lerp(1, 4.2, ft));
        activationFlash.material.opacity = THREE.MathUtils.lerp(0.55, 0, ft);
      }
    }
  }

  // =========================================================
  // PAR SYSTEM — Phase 2
  //
  // A pooled set of ray paths from the Sun to Trophic Level 1.
  // Built once at startup; activation/reset only toggle
  // visibility and reset progress — no geometry is ever created
  // or destroyed on click, per the no-duplicate-systems rule.
  // =========================================================
  var TL1_LAYER = layers[0];
  var TL1_CENTER = new THREE.Vector3(0, (TL1_LAYER.yBottom + TL1_LAYER.yTop)/2, 0);
  var TL1_MESH = layerMeshes.filter(function(m){ return m.userData.layerId === 1; })[0];
  var N_RAYS = 10;
  var RAY_COLOR = new THREE.Color(0xffd479);

  var parGroup = new THREE.Group();
  parGroup.visible = false;
  scene.add(parGroup);

  var rayCurves = [];
  var rayTubes = [];

  // True if the straight segment a->b passes inside any consumer tier (TL2-TL4), 0.12 margin.
  function rayCrossesConsumerTier(a, b){
    for (var k = 1; k < 60; k++){
      var t = k / 60, wx = a.x + (b.x - a.x) * t, wy = a.y + (b.y - a.y) * t, wz = a.z + (b.z - a.z) * t;
      for (var li = 1; li < layers.length; li++){
        var L = layers[li];
        if (wy < L.yBottom - 0.12 || wy > L.yTop + 0.12) continue;
        var hw = halfW(wy) + 0.12, hd = halfD(wy) + 0.12;
        var F = [0, hd], R = [0.866 * hw, -0.5 * hd], Lf = [-0.866 * hw, -0.5 * hd];
        var sd = function(p, q){ return (wx - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (wz - q[1]); };
        var d1 = sd(F, R), d2 = sd(R, Lf), d3 = sd(Lf, F);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
      }
    }
    return false;
  }
  // Pond: a point on TL1's sun-facing (left) outer face, picked so the ray from `start` reaches it
  // without crossing TL2-TL4. Falls back to the face's outer corner region (always clear).
  function pondRayTarget(start){
    var L1 = layers[0];
    for (var tries = 0; tries < 60; tries++){
      var y = THREE.MathUtils.lerp(L1.yBottom + 0.5, L1.yTop - 0.15, Math.random());
      var hw = halfW(y), hd = halfD(y), u = 0.5 + Math.random() * 0.45;          // along front tip -> rear-left corner
      var p = new THREE.Vector3(-0.866 * hw * u, y, hd + (-1.5 * hd) * u);
      if (!rayCrossesConsumerTier(start, p)) return p;
    }
    var yb = L1.yBottom + 0.8;
    return new THREE.Vector3(-0.866 * halfW(yb) * 0.92, yb, -0.5 * halfD(yb) * 0.92);
  }
  function buildRayCurve(seed){
    var start = SUN_POSITION.clone().add(new THREE.Vector3(
      0.35 + Math.random()*0.55,
      (Math.random()-0.5)*1.0,
      (Math.random()-0.5)*1.0
    ));
    // Open sea: TL1 is the NARROW tier of the inverted pyramid: aim inside its own width/depth.
    var target = IS_POND ? pondRayTarget(start) : TL1_CENTER.clone().add(new THREE.Vector3(
      (Math.random()-0.5)*1.0*halfW(TL1_CENTER.y),
      (Math.random()-0.5)*1.0,
      (Math.random()-0.5)*0.8*halfD(TL1_CENTER.y)
    ));
    // Straight line, Sun -> producers only. No midpoint bow: with the Sun
    // now sitting below TL2's floor (see SUN_POSITION), a straight path
    // never enters any other layer's height band regardless of camera
    // angle. "Not a laser" comes from the traveling brightness animation
    // and multiple independent rays, not from an arc.
    return new THREE.CatmullRomCurve3([start, target]);
  }

  function createRayTube(curve){
    var tubularSegments = 26, radialSegments = 5;
    var geo = new THREE.TubeGeometry(curve, tubularSegments, 0.035, radialSegments, false);
    var ringVerts = radialSegments + 1;
    var colorArr = new Float32Array((tubularSegments+1) * ringVerts * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colorArr, 3));
    var mat = new THREE.MeshBasicMaterial({
      vertexColors:true, transparent:true, opacity:0.8,
      blending: THREE.AdditiveBlending, depthWrite:false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.userData.update = function(tSincePAR){
      for (var seg=0; seg<=tubularSegments; seg++){
        var t = seg/tubularSegments;
        var wave = 0.5 + 0.5*Math.sin(t*Math.PI*2*2.6 - tSincePAR*3.1);
        var brightness = 0.28 + wave*0.85;
        for (var k=0;k<ringVerts;k++){
          var idx = (seg*ringVerts + k)*3;
          colorArr[idx]   = RAY_COLOR.r*brightness;
          colorArr[idx+1] = RAY_COLOR.g*brightness;
          colorArr[idx+2] = RAY_COLOR.b*brightness;
        }
      }
      geo.attributes.color.needsUpdate = true;
    };
    return mesh;
  }

  var rayTravelDurations = [];
  for (var ri=0; ri<N_RAYS; ri++){
    var curve = buildRayCurve(ri);
    rayCurves.push(curve);
    var tube = createRayTube(curve);
    parGroup.add(tube);
    rayTubes.push(tube);
    // Distance-derived duration (NOT hard-coded) — see Phase 2A spec point 2.
    var dist = curve.getLength();
    var dur = THREE.MathUtils.clamp(dist / RAY_VISUAL_SPEED, RAY_TRAVEL_MIN, RAY_TRAVEL_MAX);
    rayTravelDurations.push(dur);
  }
  var minRayTravelDuration = Math.min.apply(null, rayTravelDurations);

  // Shared particle pool riding along the ray curves (3 per ray)
  var PARTICLES_PER_RAY = 3;
  var rayParticleCount = N_RAYS * PARTICLES_PER_RAY;
  var rayParticleRay = new Int16Array(rayParticleCount);
  var rayParticleProgress = new Float32Array(rayParticleCount);
  var rayParticleSpeed = new Float32Array(rayParticleCount);
  var rayParticlePositions = new Float32Array(rayParticleCount*3);
  (function initRayParticles(){
    var idx = 0;
    for (var r=0; r<N_RAYS; r++){
      for (var p=0; p<PARTICLES_PER_RAY; p++){
        rayParticleRay[idx] = r;
        rayParticleProgress[idx] = p/PARTICLES_PER_RAY;
        // Cosmetic per-particle jitter only — the AUTHORITATIVE first-contact
        // time (minRayTravelDuration, above) is computed from geometry alone,
        // not from watching particles, so it never needs to guess at this jitter.
        rayParticleSpeed[idx] = (1/rayTravelDurations[r]) * (0.85 + Math.random()*0.3);
        idx++;
      }
    }
  })();
  var rayParticleGeo = new THREE.BufferGeometry();
  rayParticleGeo.setAttribute("position", new THREE.BufferAttribute(rayParticlePositions, 3));
  var rayParticleMat = new THREE.PointsMaterial({
    color: RAY_COLOR, size:0.13, map: glowTexture,
    transparent:true, opacity:0.9, blending:THREE.AdditiveBlending,
    depthWrite:false, sizeAttenuation:true
  });
  var rayParticles = new THREE.Points(rayParticleGeo, rayParticleMat);
  parGroup.add(rayParticles);

  function resetRayParticles(){
    var idx = 0;
    for (var r=0; r<N_RAYS; r++){
      for (var p=0; p<PARTICLES_PER_RAY; p++){
        rayParticleProgress[idx] = p/PARTICLES_PER_RAY;
        idx++;
      }
    }
  }

  function updateRayParticles(delta){
    var tmp = new THREE.Vector3();
    for (var i=0;i<rayParticleCount;i++){
      rayParticleProgress[i] += delta*rayParticleSpeed[i];
      if (rayParticleProgress[i] > 1) rayParticleProgress[i] -= 1;
      rayCurves[rayParticleRay[i]].getPoint(rayParticleProgress[i], tmp);
      rayParticlePositions[i*3]   = tmp.x;
      rayParticlePositions[i*3+1] = tmp.y;
      rayParticlePositions[i*3+2] = tmp.z;
    }
    rayParticleGeo.attributes.position.needsUpdate = true;
  }

  // =========================================================
  // Producer activation hook — the ONLY point where the Solar/
  // PAR system touches trophic geometry. It writes one number on
  // TL1's own mesh; it never reaches into TL2-TL4 or performs any
  // energy transfer (that's a later phase).
  // =========================================================
  var producerFlash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color: 0x9dffb0, transparent:true, opacity:0,
    blending: THREE.AdditiveBlending, depthWrite:false
  }));
  producerFlash.position.copy(TL1_CENTER);
  producerFlash.scale.set(1,1,1);
  producerFlash.visible = false;
  scene.add(producerFlash);
  var producerFlashStartElapsed = null;

  function getActiveRayCount(){
    return parGroup.visible ? N_RAYS : 0;
  }

  // Point 15 — dev-mode instrumentation: RUN / STATE / PAR / ACTIVE
  // RAYS / PRODUCER, queryable at any time and logged on every
  // state transition.
  function buildDebugLines(){
    var producerLine;
    if (simState === SIM_STATE.PRODUCER_ACTIVATING && run){
      var pt = THREE.MathUtils.clamp((elapsed - run.producerActivationStartElapsed) / PRODUCER_TRANSITION_DURATION, 0, 1);
      producerLine = "ACTIVATING " + Math.round(pt*100) + "%";
    } else if (simState === SIM_STATE.PRODUCER_ENERGISED){
      producerLine = "100%";
    } else {
      producerLine = "INACTIVE";
    }
    var parOn = (simState === SIM_STATE.PAR_EMITTING || simState === SIM_STATE.WAITING_FOR_PAR_CONTACT ||
                 simState === SIM_STATE.PRODUCER_ACTIVATING || simState === SIM_STATE.PRODUCER_ENERGISED);
    return [
      "RUN: " + (run ? run.id : 0),
      "STATE: " + simState,
      "PAR: " + (parOn ? "ACTIVE" : "OFF"),
      "ACTIVE RAYS: " + getActiveRayCount(),
      "PRODUCER: " + producerLine
    ];
  }
  function logDebugSnapshot(){
    if (DEV_MODE) console.log(buildDebugLines().join("\n"));
  }
  if (DEV_MODE) window.__ecosystemDebug = buildDebugLines; // callable any time from devtools

  function beginProducerActivation(runRef, elapsedTime){
    if (runRef !== run) return; // this run was cancelled before contact fired — Run-ID protection
    simState = SIM_STATE.PRODUCER_ACTIVATING;
    run.producerActivationStartElapsed = elapsedTime;
    producerFlashStartElapsed = elapsedTime;
    if (DEV_MODE){
      console.log("First TL1 contact:   " + (elapsedTime - run.startElapsed).toFixed(2) + " s");
    }
    logDebugSnapshot();
  }

  function updateProducerActivationTransition(elapsedTime){
    if (!run || simState !== SIM_STATE.PRODUCER_ACTIVATING) return;
    var t = (elapsedTime - run.producerActivationStartElapsed) / PRODUCER_TRANSITION_DURATION;
    if (t >= 1) t = 1;
    var eased = t*t*(3 - 2*t); // smootherstep — 0% inactive, 50% partial, 100% energised, no sudden flash
    if (TL1_MESH) TL1_MESH.userData.producerGlowAmount = eased * TL1_MESH.userData.producerBoost;

    if (t >= 1){
      simState = SIM_STATE.PRODUCER_ENERGISED;
      solarState.energyDelivered = TL1_LAYER.def.energy; // TL1's base energy becomes available internally
      updateSolarStatusUI();
      if (DEV_MODE){
        var t0 = run.startElapsed;
        console.log("Producer activation: " +
          (run.producerActivationStartElapsed - t0).toFixed(2) + "\u2013" +
          (elapsedTime - t0).toFixed(2) + " s");
        console.log("TL1 energised:       " + (elapsedTime - t0).toFixed(2) + " s");
      }
      logDebugSnapshot();
    }
  }

  function updateProducerFlash(elapsedTime){
    if (producerFlashStartElapsed === null) return;
    var t = (elapsedTime - producerFlashStartElapsed) / PRODUCER_TRANSITION_DURATION;
    if (t >= 1){
      producerFlash.visible = false;
      producerFlashStartElapsed = null;
      return;
    }
    producerFlash.visible = true;
    producerFlash.scale.setScalar(THREE.MathUtils.lerp(0.8, 3.4, t));
    producerFlash.material.opacity = THREE.MathUtils.lerp(0.5, 0, t);
  }

  // =========================================================
  // Solar entry points
  // =========================================================
  // ---- Accessible-dialog helpers (focus-trap, Escape, focus in/out) — used by
  // the profile panel and the organism editor, the app's two modal-style panels.
  var a11yLastTrigger = null;
  function a11yFocusables(panel){
    // Both dialog panels are position:fixed, and fixed-position subtrees report
    // offsetParent === null in every browser even while fully visible — so that
    // classic "is it rendered" check would wrongly treat everything as hidden here.
    // Check the hidden attribute and computed display/visibility instead.
    return Array.prototype.slice.call(panel.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function(el){
      if (el.hidden) return false;
      var cs = window.getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    });
  }
  function a11yOpen(panel, initialFocusEl){
    a11yLastTrigger = document.activeElement;
    panel.setAttribute("aria-hidden", "false");
    // Both panels are already laid out (never display:none -> block on a delay), so focusing
    // right away works in every browser and avoids fighting the page's own animation-frame loop.
    try { (initialFocusEl || panel).focus({ preventScroll: true }); } catch (e) {}
  }
  function a11yClose(panel){
    panel.setAttribute("aria-hidden", "true");
    if (a11yLastTrigger && typeof a11yLastTrigger.focus === "function") { try { a11yLastTrigger.focus({ preventScroll: true }); } catch (e) {} }
    a11yLastTrigger = null;
  }
  function a11yTrapTab(panel, e){
    var items = a11yFocusables(panel);
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }

  function activateSun(){
    dismissIntroCard();   // the first real Sun tap is the clearest "got it" for the intro card
    if (simState !== SIM_STATE.IDLE){
      // Mid-run taps are ignored (one controlled run at a time). Once the
      // ecosystem-flow sequence has finished, tapping the Sun replays it from the start.
      if (!ecosystemFlowIsDone()) return;
      cancelCurrentSimulation();
    }
    simulationRunId += 1;
    run = {
      id: simulationRunId,
      startElapsed: elapsed,
      parStartedAtElapsed: null,
      producerContactAtElapsed: null,
      producerActivationStartElapsed: null
    };
    simState = SIM_STATE.SUN_ACTIVATING;
    solarState.energyDelivered = 0;
    sunData.targetGlow = 1;
    sunburstRays.visible = true;
    flashStartElapsed = elapsed;
    startEcosystemFlow(run); // ecosystem-flow sequence shares this run's clock and cancellation
    if (DEV_MODE) console.log("Sun activated:       0.00 s");
    logDebugSnapshot();
    updateSolarStatusUI();
  }

  function cancelCurrentSimulation(){
    // Central cancellation point (Phase 2B point 8). Nulling `run`
    // and setting simState=IDLE is what actually stops the logic —
    // every per-frame branch below is gated on these two, so
    // nothing belonging to the cancelled run can execute again,
    // even mid-transition. Everything after that is visual cleanup.
    run = null;
    simState = SIM_STATE.IDLE;
    solarState.energyDelivered = 0;
    sunData.targetGlow = 0;
    parGroup.visible = false;
    sunburstRays.visible = false;
    flashStartElapsed = null;
    activationFlash.visible = false;
    producerFlashStartElapsed = null;
    producerFlash.visible = false;
    layerMeshes.forEach(function(m){ m.userData.producerGlowAmount = 0; });
    cancelEcosystemFlow(); // Reset/replay: every ecosystem-flow effect returns to idle immediately
    updateSolarStatusUI();
    logDebugSnapshot();
  }

  function updateSolarStatusUI(){
    var el = document.getElementById("solarStatus");
    var textEl = document.getElementById("solarStatusText");
    if (!el || !textEl) return;
    if (simState === SIM_STATE.IDLE){
      el.classList.remove("on");
      textEl.textContent = "Solar input off — tap the Sun";
    } else if (simState === SIM_STATE.PRODUCER_ENERGISED){
      el.classList.add("on");
      textEl.textContent = "PAR — Photosynthetically Active Radiation reaching producers";
    } else {
      el.classList.add("on");
      textEl.textContent = "PAR travelling to producers";
    }
  }

  // =========================================================
  // DECOMPOSER HABITAT — semi-realistic soil, fungi and mycelium
  //
  // Decomposers (fungi, bacteria, soil animals) are NOT one of the four
  // trophic layers, so they live in the soil in front of the pyramid.
  // This block only builds and animates that habitat:
  //   * a textured soil bed with two humus mounds,
  //   * two clusters of 3D mushrooms + thin white mycelium threads,
  //   * small crumbs of humus and a few shimmering microbes.
  // At rest the fungi are smaller and the crumbs are tiny. While the
  // ecosystem-flow animation delivers dead matter (setDecomposerGrowth,
  // driven by the flow module) the mound thickens a little, fungi swell,
  // mycelium spreads and the crumbs grow; everything eases back afterwards.
  // Built once; the old flat mushroom icons are hidden, not deleted.
  // =========================================================
  var habitatDisposables = [];
  // Aquatic fork: these two spots are now detritus ("marine snow") mounds on the sea-floor sediment,
  // worked by bacteria. Fixed radius = the original spots, in front of the narrow TL1 tier.
  var FUNGI_SPOTS = [-1, 1].map(function(side){
    var r = 3.69, ang = side * 0.9;
    return new THREE.Vector3(Math.sin(ang) * r, 0.18, Math.cos(ang) * r + 1.6);
  });
  legacyFungiSprites.forEach(function(s){ s.visible = false; });

  var SOIL_R = 6.6;
  function soilHeight(x, z){
    var h = 0.02 * Math.sin(x * 1.3 + 0.7) * Math.cos(z * 1.1 - 0.4);
    for (var i = 0; i < FUNGI_SPOTS.length; i++){
      var dx = x - FUNGI_SPOTS[i].x, dz = z - FUNGI_SPOTS[i].z;
      h += 0.30 * Math.exp(-(dx*dx + dz*dz) / (2 * 1.25 * 1.25));   // humus mound under each cluster
    }
    var r = Math.sqrt(x*x + z*z);
    return 0.02 + Math.max(0, h) * (1 - flowStep(SOIL_R * 0.72, SOIL_R, r));
  }
  function habRand(a, b){ return a + Math.random() * (b - a); }

  // procedural soil grain texture (no external images)
  var soilGrainTexture = (function(){
    var size = 256, c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    g.fillStyle = "#4b4a3e"; g.fillRect(0, 0, size, size);          // fine grey-olive marine mud / silt
    var pal = ["#35352c", "#5d5b4a", "#6c6956", "#403f35", "#7b7863", "#2f302a"];
    for (var i = 0; i < 2600; i++){
      g.fillStyle = pal[Math.floor(Math.random() * pal.length)];
      g.beginPath(); g.arc(Math.random() * size, Math.random() * size, habRand(0.6, 2.1), 0, Math.PI * 2); g.fill();
    }
    for (var p = 0; p < 46; p++){                                 // small pale pebbles
      var px = Math.random() * size, py = Math.random() * size, pr = habRand(1.6, 3.6);
      g.fillStyle = "#a7a291"; g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();          // shell fragments / sand grains
      g.fillStyle = "#cfcab8"; g.beginPath(); g.arc(px - pr * 0.25, py - pr * 0.25, pr * 0.5, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = "rgba(150,160,140,0.35)"; g.lineWidth = 0.8;   // faint burrow traces (no plant roots on the sea floor)
    for (var f = 0; f < 14; f++){
      var fx = Math.random() * size, fy = Math.random() * size;
      g.beginPath(); g.moveTo(fx, fy);
      g.quadraticCurveTo(fx + habRand(-14, 14), fy + habRand(-14, 14), fx + habRand(-26, 26), fy + habRand(-26, 26));
      g.stroke();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  })();

  var SOIL_RINGS = 28, SOIL_SEGS = 72;
  var soilBedGeo = (function(){
    var pos = [], uv = [], col = [], idx = [];
    for (var i = 0; i <= SOIL_RINGS; i++){
      var rr = SOIL_R * (i / SOIL_RINGS);
      for (var j = 0; j <= SOIL_SEGS; j++){
        var a = j / SOIL_SEGS * Math.PI * 2;
        var x = Math.cos(a) * rr, z = Math.sin(a) * rr, y = soilHeight(x, z);
        pos.push(x, y, z); uv.push(x * 0.3, z * 0.3);
        var t = Math.min(1, Math.max(0, (y - 0.05) / 0.3));                       // 0 flat soil .. 1 mound top
        var n = 0.9 + 0.1 * Math.sin(x * 7.1 + z * 5.3) * Math.sin(z * 6.7 - x * 4.1);
        var k = (0.80 - 0.32 * t) * n * (1 - 0.65 * flowStep(SOIL_R * 0.6, SOIL_R, rr)); // richer humus on mounds, dark at the rim
        col.push(k * 0.95, k * 0.95, k * 0.88);
      }
    }
    for (var ri = 0; ri < SOIL_RINGS; ri++){
      for (var si = 0; si < SOIL_SEGS; si++){
        var A = ri * (SOIL_SEGS + 1) + si, B = A + SOIL_SEGS + 1;
        idx.push(A, A + 1, B, B, A + 1, B + 1);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    var nrm = geo.attributes.normal;                       // centre point is degenerate: force its normal up
    for (var cn = 0; cn <= SOIL_SEGS; cn++) nrm.setXYZ(cn, 0, 1, 0);
    return geo;
  })();
  var soilBedMat = new THREE.MeshLambertMaterial({ map: soilGrainTexture, vertexColors: true, color: 0xffffff });
  var soilBed = new THREE.Mesh(soilBedGeo, soilBedMat);
  scene.add(soilBed);
  habitatDisposables.push(soilBedGeo, soilBedMat, soilGrainTexture);

  // scattered grains and pebbles (children of the bed so they follow its swelling)
  var GRAIN_N = 90;
  var grainGeo = new THREE.IcosahedronGeometry(1, 0);
  var grainMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var grains = new THREE.InstancedMesh(grainGeo, grainMat, GRAIN_N);
  (function(){
    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    var pal = [0x3d3c33, 0x5d5b4a, 0x77735f, 0x8f8a76, 0xb3ad98, 0x34342c];
    for (var i = 0; i < GRAIN_N; i++){
      var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * SOIL_R * 0.92;
      var x = Math.cos(a) * r, z = Math.sin(a) * r, sz = habRand(0.035, 0.09);
      p.set(x, soilHeight(x, z) + sz * 0.3, z);
      q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      s.set(sz * habRand(0.9, 1.4), sz * habRand(0.6, 0.9), sz * habRand(0.9, 1.3));
      grains.setMatrixAt(i, m.compose(p, q, s));
      grains.setColorAt(i, c.setHex(pal[Math.floor(Math.random() * pal.length)]));
    }
  })();
  grains.frustumCulled = false;
  soilBed.add(grains);
  habitatDisposables.push(grainGeo, grainMat);

  // ---- 3D mushrooms (instanced: one draw call for stems, one for caps) ----
  var stemGeo = new THREE.CylinderGeometry(0.75, 1.0, 1, 8);
  stemGeo.translate(0, 0.5, 0);
  var capProfile = [[0, 0], [0.85, 0], [1.0, 0.05], [0.94, 0.16], [0.72, 0.30], [0.40, 0.40], [0, 0.44]]
    .map(function(p){ return new THREE.Vector2(p[0], p[1]); });
  var capGeo = new THREE.LatheGeometry(capProfile, 14);
  var stemMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x1a1710 });
  var capMat  = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x160f08, side: THREE.DoubleSide });
  var fungi = [];
  FUNGI_SPOTS.forEach(function(sp){
    for (var i = 0; i < 7; i++){
      var big = (i === 0);
      var a = Math.random() * Math.PI * 2, r = big ? 0 : habRand(0.35, 1.0);
      fungi.push({
        x: sp.x + Math.cos(a) * r, z: sp.z + Math.sin(a) * r,
        size: big ? 1.0 : habRand(0.45, 0.85),
        tx: habRand(-0.12, 0.12), tz: habRand(-0.12, 0.12),
        delay: habRand(0, 0.4)
      });
    }
  });
  var stems = new THREE.InstancedMesh(stemGeo, stemMat, fungi.length);
  var caps  = new THREE.InstancedMesh(capGeo, capMat, fungi.length);
  (function(){
    var capPal = [0xc9a876, 0xa98156, 0xd8c6a0, 0x9c6b45], c = new THREE.Color();
    fungi.forEach(function(f, i){
      stems.setColorAt(i, c.setRGB(0.9 + Math.random() * 0.1, 0.87 + Math.random() * 0.1, 0.78 + Math.random() * 0.1));
      caps.setColorAt(i, c.setHex(capPal[Math.floor(Math.random() * capPal.length)]));
    });
  })();
  stems.frustumCulled = false; caps.frustumCulled = false;
  stems.visible = caps.visible = false;   // aquatic fork: no mushrooms in open water (bacteria do the decomposing)
  scene.add(stems); scene.add(caps);
  habitatDisposables.push(stemGeo, capGeo, stemMat, capMat);

  // ---- mycelium: thin branching threads on the soil, revealed outward ----
  var mycSegs = [];
  FUNGI_SPOTS.forEach(function(sp){
    var tips = [], count = 0, i;
    for (i = 0; i < 7; i++) tips.push({ x: sp.x + (Math.random() - 0.5) * 0.5, z: sp.z + (Math.random() - 0.5) * 0.5, a: Math.random() * Math.PI * 2 });
    while (tips.length && count < 46){
      var tip = tips.shift(), x = tip.x, z = tip.z, a = tip.a, steps = 3 + Math.floor(Math.random() * 3);
      for (var s = 0; s < steps && count < 46; s++){
        a += (Math.random() - 0.5) * 0.7;
        var len = habRand(0.22, 0.42), nx = x + Math.cos(a) * len, nz = z + Math.sin(a) * len;
        var d = Math.sqrt((nx - sp.x) * (nx - sp.x) + (nz - sp.z) * (nz - sp.z));
        if (d > 2.2) break;
        mycSegs.push({ ax: x, az: z, bx: nx, bz: nz, d: d });
        x = nx; z = nz; count++;
        if (Math.random() < 0.22 && tips.length < 20) tips.push({ x: x, z: z, a: a + (Math.random() < 0.5 ? 0.9 : -0.9) });
      }
    }
  });
  mycSegs.sort(function(p, q){ return p.d - q.d; });   // nearest first, so the reveal grows outward
  var mycPos = new Float32Array(mycSegs.length * 6);
  mycSegs.forEach(function(sg, i){
    mycPos[i*6]   = sg.ax; mycPos[i*6+1] = soilHeight(sg.ax, sg.az) + 0.03; mycPos[i*6+2] = sg.az;
    mycPos[i*6+3] = sg.bx; mycPos[i*6+4] = soilHeight(sg.bx, sg.bz) + 0.03; mycPos[i*6+5] = sg.bz;
  });
  var mycGeo = new THREE.BufferGeometry();
  mycGeo.setAttribute("position", new THREE.BufferAttribute(mycPos, 3));
  var mycMat = new THREE.LineBasicMaterial({ color: 0xf1e8cf, transparent: true, opacity: 0.55, depthWrite: false });
  var mycelium = new THREE.LineSegments(mycGeo, mycMat);
  mycelium.frustumCulled = false;
  mycelium.visible = false;               // aquatic fork: no fungal mycelium on the sea floor
  soilBed.add(mycelium);
  habitatDisposables.push(mycGeo, mycMat);

  // ---- humus crumbs: tiny at rest, grow as dead matter is broken down ----
  var CRUMB_N = 30;
  var crumbGeo = new THREE.IcosahedronGeometry(1, 1);
  var crumbMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var crumbs = new THREE.InstancedMesh(crumbGeo, crumbMat, CRUMB_N);
  var crumbData = [];
  (function(){
    var pal = [0x4a4232, 0x5a4f3a, 0x3e3a2e, 0x6a5e44], c = new THREE.Color();   // organic detritus flocs
    for (var i = 0; i < CRUMB_N; i++){
      var sp = FUNGI_SPOTS[i % 2], a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 1.5;
      var x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r;
      crumbData.push({ x: x, z: z, base: habRand(0.07, 0.15), rot: Math.random() * 3, delay: habRand(0, 0.5) });
      crumbs.setColorAt(i, c.setHex(pal[Math.floor(Math.random() * pal.length)]));
    }
  })();
  crumbs.frustumCulled = false;
  soilBed.add(crumbs);
  habitatDisposables.push(crumbGeo, crumbMat);

  // ---- microbes: a few faint shimmering points, brighter while active ----
  var MICROBES = 36;
  var microbes = makeHabitatPoints(MICROBES, 0xbfe3d0, 0.07);   // bacteria
  var microPhase = new Float32Array(MICROBES);
  (function(){
    for (var i = 0; i < MICROBES; i++){
      var sp = FUNGI_SPOTS[i % 2], a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 1.6;
      var x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r;
      microbes.pos[i*3] = x; microbes.pos[i*3+1] = soilHeight(x, z) * 1.5 + 0.06; microbes.pos[i*3+2] = z;
      microPhase[i] = Math.random() * 6.283;
    }
  })();
  function makeHabitatPoints(n, hex, size){
    var pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    var mat = new THREE.PointsMaterial({
      size: size, map: glowTexture, vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    habitatDisposables.push(geo, mat);
    return { pts: pts, geo: geo, pos: pos, col: col, base: new THREE.Color(hex), n: n };
  }

  var habM = new THREE.Matrix4(), habQ = new THREE.Quaternion(), habE = new THREE.Euler(), habP = new THREE.Vector3(), habS = new THREE.Vector3();
  function habEase(x){ x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }

  // G: 0 = at rest, 1 = fully active (dead matter has arrived). T: seconds, for the shimmer.
  function setDecomposerGrowth(G, T){
    var sy = 1 + 0.45 * G;                                  // organic matter accumulates: humus thickens
    soilBed.scale.y = sy;
    soilBedMat.color.setRGB(1 - 0.16 * G, 1 - 0.18 * G, 1 - 0.20 * G);   // slightly darker, richer soil
    for (var i = 0; i < fungi.length; i++){
      var f = fungi[i], s = f.size * (0.78 + 0.5 * habEase(G * 1.5 - f.delay));   // fungi swell, staggered
      var y0 = soilHeight(f.x, f.z) * sy;
      habQ.setFromEuler(habE.set(f.tx, 0, f.tz));
      habP.set(f.x, y0, f.z);
      habS.set(0.075 * s, 0.5 * s, 0.075 * s);
      stems.setMatrixAt(i, habM.compose(habP, habQ, habS));
      habP.set(f.x, y0 + 0.48 * s, f.z);
      habS.set(0.34 * s, 0.34 * s, 0.34 * s);
      caps.setMatrixAt(i, habM.compose(habP, habQ, habS));
    }
    stems.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    for (var c = 0; c < CRUMB_N; c++){
      var cd = crumbData[c], cs = cd.base * (0.25 + 0.75 * habEase(G * 1.5 - cd.delay));
      habP.set(cd.x, soilHeight(cd.x, cd.z) + cs * 0.4, cd.z);
      habQ.setFromEuler(habE.set(cd.rot, cd.rot * 1.7, cd.rot * 0.6));
      habS.set(cs, cs * 0.7, cs);
      crumbs.setMatrixAt(c, habM.compose(habP, habQ, habS));
    }
    crumbs.instanceMatrix.needsUpdate = true;
    var reveal = 0.22 + 0.78 * habEase(G);                  // mycelium spreads outward
    mycGeo.setDrawRange(0, Math.floor(mycSegs.length * reveal) * 2);
    for (var m = 0; m < MICROBES; m++){
      var b = (0.10 + 0.5 * G) * (0.5 + 0.5 * Math.sin(T * 3 + microPhase[m]));
      microbes.col[m*3] = microbes.base.r * b; microbes.col[m*3+1] = microbes.base.g * b; microbes.col[m*3+2] = microbes.base.b * b;
    }
    microbes.geo.attributes.color.needsUpdate = true;
  }
  setDecomposerGrowth(0, 0);

  // =========================================================
  // SOIL BED beneath TL1 (primary producers)
  //
  // A shallow, purely visual soil cross-section that fills the base
  // clearance under TL1. It follows TL1's base footprint and the
  // pyramid's own taper, is only slightly wider than TL1, and stops just
  // below TL1's underside so it never touches or overlaps the prism.
  //   * top surface: gently uneven, dark topsoil with grain texture
  //   * front/side walls: a thin cut-away of the soil, painted with
  //     humus -> subsoil strata, grains, pebbles, tiny organic fragments
  //     and fine roots running down from where the producers stand
  //   * a scatter of tiny particles and organic flecks on the top edge
  // Lit by the same scene lights (Lambert, no emissive => no glow).
  // NOT selectable: it is not in layerMeshes and its raycast is a no-op,
  // so picking, long-press, View profile, Reset, PAR and the energy /
  // biomass maths never see it. Organism sprites ignore depth, so the soil
  // can never cover them.
  // =========================================================
  var SLAB_MARGIN = 1.08;      // footprint vs TL1 base: only slightly wider
  var SLAB_TOP_Y = 0.335;      // surface sits 0.03-0.09 under TL1's underside (y = 0.4)
  var SLAB_BOT_Y = -0.06;      // a little below ground so it sits firmly
  var SLAB_N = 24;             // subdivisions along each edge
  var slabDisposables = [];
  function slabRand(a, b){ return a + Math.random() * (b - a); }
  function slabNoise(x, z){    // smooth, -1..1
    return 0.55 * Math.sin(x * 1.9 + 1.1) * Math.cos(z * 2.3 - 0.5) + 0.30 * Math.sin(x * 4.3 + z * 3.1) + 0.15 * Math.cos(x * 7.7 - z * 5.9);
  }
  function slabTopY(x, z){ return SLAB_TOP_Y + 0.03 * slabNoise(x, z); }   // 0.305 .. 0.365 (< 0.4)
  function slabCorners(y){
    var hw = halfW(y) * SLAB_MARGIN, hd = halfD(y) * SLAB_MARGIN;           // same taper as the pyramid
    return { F: [0, hd], R: [0.866 * hw, -0.5 * hd], L: [-0.866 * hw, -0.5 * hd] };
  }
  var slabTopC = slabCorners(SLAB_TOP_Y), slabBotC = slabCorners(SLAB_BOT_Y);

  // where TL1's producers stand, so their roots are painted right beneath them
  var slabWalls = [
    { name: "front-right", A: "F", B: "R", roots: [] },
    { name: "front-left",  A: "F", B: "L", roots: [] },
    { name: "back",        A: "R", B: "L", roots: [] }
  ];
  (function(){
    var l1 = layers[0];
    ORGANISM_ASSETS.forEach(function(a){
      if (a.trophicLevel !== 1) return;
      var y = l1.yBottom + (l1.yTop - l1.yBottom) * a.y;
      var px = a.x * halfW(y), pz = a.z * halfD(y), best = null;
      for (var w = 0; w < 2; w++){                                            // the two visible front walls
        var A = slabTopC[slabWalls[w].A], B = slabTopC[slabWalls[w].B];
        var abx = B[0] - A[0], abz = B[1] - A[1], len2 = abx * abx + abz * abz;
        var t = ((px - A[0]) * abx + (pz - A[1]) * abz) / len2;
        var dx = A[0] + abx * t - px, dz = A[1] + abz * t - pz, d = Math.sqrt(dx * dx + dz * dz);
        if (t > 0.04 && t < 0.96 && (!best || d < best.d)) best = { w: w, t: t, d: d };
      }
      if (best) slabWalls[best.w].roots.push(best.t);
    });
  })();

  function paintSlabRoot(g, H, x, y, len, width, ang, depth){
    var px = x, py = y, steps = Math.max(5, Math.floor(len / 3));
    for (var i = 0; i < steps; i++){
      var nx = px + Math.cos(ang) * 3, ny = py + Math.sin(ang) * 3;
      ang += (Math.random() - 0.5) * 0.5 + (Math.PI / 2 - ang) * 0.07;       // wander, drift downward
      g.lineWidth = Math.max(0.4, width * (1 - i / steps));
      g.beginPath(); g.moveTo(px, py); g.lineTo(nx, ny); g.stroke();
      if (depth > 0 && Math.random() < 0.11){
        paintSlabRoot(g, H, nx, ny, len * slabRand(0.25, 0.5), width * 0.55, ang + (Math.random() < 0.5 ? -1 : 1) * slabRand(0.7, 1.2), depth - 1);
      }
      px = nx; py = ny;
      if (py > H - 2) break;
    }
  }
  function paintSlabWall(rootTs){
    var W = 2048, H = 128, c = document.createElement("canvas");   // ~16:1, close to the wall's real proportions
    c.width = W; c.height = H;
    var g = c.getContext("2d"), i;
    var grad = g.createLinearGradient(0, 0, 0, H);                            // humus on top, paler subsoil below
    grad.addColorStop(0.00, "#231810"); grad.addColorStop(0.16, "#2e2015");
    grad.addColorStop(0.42, "#3e2b1b"); grad.addColorStop(0.70, "#4f3823"); grad.addColorStop(1.00, "#5c4429");
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    for (var b = 0; b < 3; b++){                                              // wavy stratum boundaries
      var y0 = H * (0.2 + 0.25 * b);
      g.strokeStyle = (b % 2) ? "rgba(15,9,4,0.28)" : "rgba(120,90,55,0.16)";
      g.lineWidth = 1 + Math.random() * 1.2;
      g.beginPath();
      for (var x = 0; x <= W; x += 8){
        var yy = y0 + Math.sin(x * 0.011 + b * 1.7) * 3.5 + Math.sin(x * 0.037 + b) * 1.5;
        if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.stroke();
    }
    var pal = ["#1d130c", "#3a2a1a", "#57402a", "#6b5233", "#7a6244", "#2c2016"];
    for (i = 0; i < 5200; i++){                                               // soil particles
      g.fillStyle = pal[Math.floor(Math.random() * pal.length)];
      g.globalAlpha = slabRand(0.45, 0.9);
      g.beginPath(); g.arc(Math.random() * W, Math.random() * H, slabRand(0.4, 1.3), 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    for (i = 0; i < 44; i++){                                                 // pebbles
      var px = Math.random() * W, py = H * slabRand(0.25, 0.95), pr = slabRand(1.6, 3.8);
      g.fillStyle = "#6f6353"; g.beginPath(); g.ellipse(px, py, pr, pr * 0.72, Math.random() * 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#8b7d68"; g.beginPath(); g.ellipse(px - pr * 0.2, py - pr * 0.2, pr * 0.5, pr * 0.34, 0, 0, Math.PI * 2); g.fill();
    }
    var org = ["#7a6a3a", "#5f5a30", "#8a7a52", "#6a5530"];
    for (i = 0; i < 60; i++){                                                 // tiny organic fragments, mostly in the humus
      g.save();
      g.translate(Math.random() * W, H * Math.pow(Math.random(), 1.6) * 0.75);
      g.rotate(Math.random() * Math.PI);
      g.fillStyle = org[Math.floor(Math.random() * org.length)];
      g.globalAlpha = slabRand(0.55, 0.85);
      g.fillRect(-slabRand(1.5, 3.5), -slabRand(0.4, 0.8), slabRand(3, 7), slabRand(0.7, 1.3));
      g.restore();
    }
    g.globalAlpha = 1;
    g.strokeStyle = "rgba(190,160,112,0.5)"; g.lineCap = "round";            // fine roots
    var starts = [];
    rootTs.forEach(function(t){ for (var k = 0; k < 3; k++) starts.push(t + (k === 0 ? 0 : slabRand(-0.03, 0.03))); });
    for (i = 0; i < 3; i++) starts.push(Math.random());                       // a few strays
    starts.forEach(function(t){
      paintSlabRoot(g, H, t * W, slabRand(0, 3), H * slabRand(0.5, 0.85), slabRand(1.1, 1.7), Math.PI / 2 + slabRand(-0.35, 0.35), 2);
    });
    var tex = new THREE.CanvasTexture(c);
    slabDisposables.push(tex);
    return tex;
  }
  function paintSlabTop(){
    var S = 512, c = document.createElement("canvas");
    c.width = c.height = S;
    var g = c.getContext("2d"), i;
    g.fillStyle = "#33251a"; g.fillRect(0, 0, S, S);
    var pal = ["#1d130c", "#3a2a1a", "#4a3623", "#5a4229", "#2c2016"];
    for (i = 0; i < 3200; i++){
      g.fillStyle = pal[Math.floor(Math.random() * pal.length)];
      g.globalAlpha = slabRand(0.5, 0.9);
      g.beginPath(); g.arc(Math.random() * S, Math.random() * S, slabRand(0.6, 2.2), 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    for (i = 0; i < 30; i++){
      var px = Math.random() * S, py = Math.random() * S, pr = slabRand(1.6, 3.4);
      g.fillStyle = "#6f6353"; g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
    }
    var org = ["#6a5a30", "#5a5230", "#7f704a"];
    for (i = 0; i < 40; i++){
      g.save(); g.translate(Math.random() * S, Math.random() * S); g.rotate(Math.random() * Math.PI);
      g.fillStyle = org[Math.floor(Math.random() * org.length)]; g.globalAlpha = 0.7;
      g.fillRect(-slabRand(3, 6), -1, slabRand(6, 12), slabRand(1.5, 2.5)); g.restore();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    slabDisposables.push(tex);
    return tex;
  }

  function noRaycast(){}   // the soil is never a pick target
  var soilSlab = new THREE.Group();
  soilSlab.name = "soil-bed-TL1";
  soilSlab.userData.nonInteractive = true;

  // ---- top surface: subdivided triangle with a gentle, uneven height ----
  var slabTopMesh = (function(){
    var F = slabTopC.F, R = slabTopC.R, L = slabTopC.L;
    var pos = [], uv = [], col = [], idx = [], id = {};
    for (var i = 0; i <= SLAB_N; i++){
      for (var j = 0; j <= SLAB_N - i; j++){
        var a = i / SLAB_N, bb = j / SLAB_N, cc = 1 - a - bb;
        var x = a * F[0] + bb * R[0] + cc * L[0], z = a * F[1] + bb * R[1] + cc * L[1];
        id[i + "," + j] = pos.length / 3;
        pos.push(x, slabTopY(x, z), z);
        uv.push(x * 0.2, z * 0.2);
        var k = 0.92 + 0.08 * slabNoise(x * 1.7 + 3, z * 1.7);
        col.push(k, k * 0.95, k * 0.9);
      }
    }
    var tris = [];
    for (var ii = 0; ii < SLAB_N; ii++){
      for (var jj = 0; jj < SLAB_N - ii; jj++){
        tris.push([id[ii + "," + jj], id[(ii + 1) + "," + jj], id[ii + "," + (jj + 1)]]);
        if (jj < SLAB_N - ii - 1) tris.push([id[(ii + 1) + "," + jj], id[(ii + 1) + "," + (jj + 1)], id[ii + "," + (jj + 1)]]);
      }
    }
    tris.forEach(function(t){                                   // make every triangle face up
      var ax = pos[t[0]*3], ay = pos[t[0]*3+1], az = pos[t[0]*3+2];
      var ux = pos[t[1]*3] - ax, uy = pos[t[1]*3+1] - ay, uz = pos[t[1]*3+2] - az;
      var vx = pos[t[2]*3] - ax, vy = pos[t[2]*3+1] - ay, vz = pos[t[2]*3+2] - az;
      var ny = uz * vx - ux * vz;
      if (ny >= 0) idx.push(t[0], t[1], t[2]); else idx.push(t[0], t[2], t[1]);
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    var mat = new THREE.MeshLambertMaterial({ map: paintSlabTop(), vertexColors: true, color: 0xffffff });
    slabDisposables.push(geo, mat);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.raycast = noRaycast;
    return mesh;
  })();
  soilSlab.add(slabTopMesh);

  // ---- walls: the cut-away faces, outward-facing, top edge follows the surface ----
  slabWalls.forEach(function(w){
    var A0 = slabTopC[w.A], B0 = slabTopC[w.B], A1 = slabBotC[w.A], B1 = slabBotC[w.B];
    var pos = [], uv = [], idx = [];
    for (var k = 0; k <= SLAB_N; k++){
      var t = k / SLAB_N;
      var tx = A0[0] + (B0[0] - A0[0]) * t, tz = A0[1] + (B0[1] - A0[1]) * t;
      var bx = A1[0] + (B1[0] - A1[0]) * t, bz = A1[1] + (B1[1] - A1[1]) * t;
      pos.push(tx, slabTopY(tx, tz), tz,  bx, SLAB_BOT_Y, bz);
      uv.push(t, 1,  t, 0);
    }
    var mx = (A0[0] + B0[0]) / 2, mz = (A0[1] + B0[1]) / 2;                   // outward = away from the centroid (0,0)
    // first quad decides the winding so every wall faces outward
    var ux = pos[6] - pos[0], uy = pos[7] - pos[1], uz = pos[8] - pos[2];      // along the edge
    var vx = pos[3] - pos[0], vy = pos[4] - pos[1], vz = pos[5] - pos[2];      // down the wall
    var nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    var flip = (nx * mx + nz * mz) < 0;
    for (var q = 0; q < SLAB_N; q++){
      var a = q * 2, b = q * 2 + 1, c = q * 2 + 2, d = q * 2 + 3;
      if (!flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    var mat = new THREE.MeshLambertMaterial({ map: paintSlabWall(w.roots), color: 0xffffff });
    slabDisposables.push(geo, mat);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = "soil-wall-" + w.name;
    mesh.raycast = noRaycast;
    soilSlab.add(mesh);
  });

  // ---- tiny soil particles and organic fragments on the visible top rim ----
  var slabFrags = (function(){
    var N = 70, geo = new THREE.IcosahedronGeometry(1, 0);
    var mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    var mesh = new THREE.InstancedMesh(geo, mat, N);
    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    var pal = [0x2c2016, 0x3a2a1a, 0x4a3623, 0x5d5a2c, 0x8b7a52, 0x6f6353];   // dark soil, olive/tan organic bits, grey grit
    var base = slabCorners(0.4), n = 0, tries = 0;                                // TL1's own base outline
    function inTri(px, pz, T, pad){
      var F = T.F, R = T.R, L = T.L;
      function sd(a, b){ return (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (pz - b[1]); }
      var d1 = sd(F, R), d2 = sd(R, L), d3 = sd(L, F);
      return !((d1 < -pad || d2 < -pad || d3 < -pad) && (d1 > pad || d2 > pad || d3 > pad));
    }
    var baseTL1 = { F: [base.F[0] / SLAB_MARGIN, base.F[1] / SLAB_MARGIN], R: [base.R[0] / SLAB_MARGIN, base.R[1] / SLAB_MARGIN], L: [base.L[0] / SLAB_MARGIN, base.L[1] / SLAB_MARGIN] };
    while (n < N && tries++ < 6000){
      var a = Math.random(), b = Math.random() * (1 - a), cc = 1 - a - b;
      var x = a * slabTopC.F[0] + b * slabTopC.R[0] + cc * slabTopC.L[0];
      var z = a * slabTopC.F[1] + b * slabTopC.R[1] + cc * slabTopC.L[1];
      if (inTri(x, z, baseTL1, 0)) continue;                                     // rim only (the rest is under TL1)
      var sz = slabRand(0.025, 0.07);
      p.set(x, slabTopY(x, z) + sz * 0.25, z);
      q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      s.set(sz * slabRand(0.9, 1.6), sz * slabRand(0.35, 0.7), sz * slabRand(0.9, 1.4));
      mesh.setMatrixAt(n, m.compose(p, q, s));
      mesh.setColorAt(n, c.setHex(pal[Math.floor(Math.random() * pal.length)]));
      n++;
    }
    mesh.count = n;
    mesh.frustumCulled = false;
    mesh.raycast = noRaycast;
    slabDisposables.push(geo, mat);
    return mesh;
  })();
  soilSlab.add(slabFrags);
  soilSlab.visible = IS_POND;  // pond: rooted plants in bottom mud; open sea: phytoplankton float, no rooted bed
  scene.add(soilSlab);
  habitatDisposables.push.apply(habitatDisposables, slabDisposables);

  // =========================================================
  // MORTALITY REMAINS — what is left in the soil
  //
  // When "Simulate mortality" finishes an organism, its body falls to the
  // soil in front of the soil bed and is broken down in stages
  // (compressed into seconds for teaching; real decay takes weeks-years):
  //   1. fresh remains       intact carcass / green plant
  //   2. soft tissue decays  muscle, skin, chlorophyll are consumed by
  //                          decomposers; the body shrinks and fades
  //   3. hard parts persist  mineralised BONE, chitin cuticle and lignified
  //                          WOOD resist decay far longer; they weather,
  //                          are stained by the soil and slowly sink in.
  // What remains, by group (drawn from real anatomy, lying as found):
  //   frog        skull with orbits, 8 presacral + 1 sacral vertebra, urostyle,
  //               long V-shaped ilia, fused radio-ulna and tibio-fibula,
  //               elongated ankle bones, 5 hind toes (4th longest); NO ribs
  //   insect      empty chitin husk: head capsule, eyes, 3 thoracic segments,
  //               6 jointed legs, segmented abdomen, wing covers, antennae
  //   caterpillar soft-bodied: almost everything decays; only the hard head
  //               capsule and a few frass pellets remain
  //   plants      leaf litter that yellows, browns and thins; wood and stems
  //               (lignin) last longest
  //   others      snake / lizard / rabbit / deer / eagle skeletons
  // Purely visual: not selectable, no effect on energy or biomass.
  // =========================================================
  var RM_TIME = { FRESH: 2.5, DECAY_END: 10, SETTLE_END: 30 };
  var RM_SLOTS = [[0.2, 4.05], [-1.2, 4.1], [1.6, 4.05], [-0.5, 5.0], [0.9, 5.0], [-1.9, 5.05],
                  [2.3, 5.0], [0.2, 5.95], [-1.2, 5.95], [1.6, 5.95], [3.0, 5.9]];   // free soil in front of the bed
  var remainsList = [];
  var remainsRoot = new THREE.Group();
  remainsRoot.name = "mortality-remains";
  remainsRoot.userData.nonInteractive = true;
  scene.add(remainsRoot);
  var remainsDisposables = [];
  function rmNoRaycast(){}
  function rmRand(a, b){ return a + Math.random() * (b - a); }
  function P3(x, y, z){ return new THREE.Vector3(x, y, z); }
  function rmSmooth(a, b, x){ var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  // ---- BoneKit: merges many small primitives (rods, ellipsoids) into ONE geometry ----
  var rmUnitCyl = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).toNonIndexed();   // open ended: joints/knobs cover the ends
  var rmUnitSph = new THREE.SphereGeometry(1, 6, 4).toNonIndexed();
  var rmM = new THREE.Matrix4(), rmQ = new THREE.Quaternion(), rmUp = new THREE.Vector3(0, 1, 0),
      rmV = new THREE.Vector3(), rmN = new THREE.Vector3(), rmNM = new THREE.Matrix3(),
      rmD = new THREE.Vector3(), rmMid = new THREE.Vector3(), rmS = new THREE.Vector3();
  var RM_DARK = new THREE.Color(0x3a2e22);
  function BoneKit(hex, jitter){ this.p = []; this.n = []; this.c = []; this.base = new THREE.Color(hex); this.jit = jitter === undefined ? 0.05 : jitter; }
  BoneKit.prototype.add = function(geo, m, col){
    var pa = geo.attributes.position.array, na = geo.attributes.normal.array;
    rmNM.getNormalMatrix(m);
    var j = 1 - this.jit + Math.random() * this.jit * 2;
    for (var i = 0; i < pa.length; i += 3){
      rmV.set(pa[i], pa[i+1], pa[i+2]).applyMatrix4(m);
      this.p.push(rmV.x, rmV.y, rmV.z);
      rmN.set(na[i], na[i+1], na[i+2]).applyMatrix3(rmNM).normalize();
      this.n.push(rmN.x, rmN.y, rmN.z);
      this.c.push(col.r * j, col.g * j, col.b * j);
    }
    return this;
  };
  BoneKit.prototype.ball = function(c, rx, ry, rz, col){
    rmS.set(rx, ry, rz);
    return this.add(rmUnitSph, rmM.compose(c, rmQ.identity(), rmS), col || this.base);
  };
  BoneKit.prototype.rod = function(a, b, r, knob, col){
    rmD.subVectors(b, a);
    var len = rmD.length();
    if (len < 1e-5) return this;
    rmQ.setFromUnitVectors(rmUp, rmD.normalize());
    rmMid.addVectors(a, b).multiplyScalar(0.5);
    rmS.set(r, len, r);
    this.add(rmUnitCyl, rmM.compose(rmMid, rmQ, rmS), col || this.base);
    if (knob){ this.ball(a, r * 1.7, r * 1.7, r * 1.7, col); this.ball(b, r * 1.7, r * 1.7, r * 1.7, col); }
    return this;
  };
  BoneKit.prototype.build = function(){
    var g = new THREE.BufferGeometry(), p = this.p, c = this.c, minY = 1e9, maxY = -1e9, i;
    for (i = 1; i < p.length; i += 3){ minY = Math.min(minY, p[i]); maxY = Math.max(maxY, p[i]); }
    for (i = 0; i < p.length / 3; i++){                        // undersides sit in the soil, so they read a little darker
      var f = 0.80 + 0.20 * ((p[i*3+1] - minY) / (maxY - minY + 1e-6));
      c[i*3] *= f; c[i*3+1] *= f; c[i*3+2] *= f;
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(c, 3));
    g.computeBoundingSphere();
    return g;
  };
  // A carcass = hard parts (bones/chitin) + optional soft tissue built from the same joints.
  function Carcass(boneHex, tissueHex){
    this.bones = new BoneKit(boneHex);
    this.tissue = tissueHex === null ? null : new BoneKit(tissueHex === undefined ? 0xffffff : tissueHex, 0.12);
  }
  Carcass.prototype.limb = function(a, b, r, tm, knob){        // one bone (+ the muscle around it)
    this.bones.rod(a, b, r, knob !== false);
    if (this.tissue) this.tissue.rod(a, b, r * (tm || 4), false);
    return this;
  };
  Carcass.prototype.flesh = function(c, rx, ry, rz){ if (this.tissue) this.tissue.ball(c, rx, ry, rz); return this; };
  function rmToe(cs, base, s, ang, total, r){ return rmToeH(cs, base, s * ang, total, r); }
  function rmToeH(cs, base, heading, total, r){                    // metatarsal + 2 phalanges, absolute heading (0 = +z)
    var dir = P3(Math.sin(heading), 0, Math.cos(heading)), a = base.clone(), lens = [0.4, 0.3, 0.3];
    for (var i = 0; i < 3; i++){
      var b = a.clone().addScaledVector(dir, total * lens[i]);
      cs.limb(a, b, r * (1 - i * 0.18), 2.4, true);
      a = b;
    }
    return a;
  }

  // ---------- FROG (Anura) ----------
  function buildFrogRemains(){
    var cs = new Carcass(0xe4dac2, 0xffffff), k = cs.bones, i;
    // skull: broad, flat, large orbits, wide gape
    k.ball(P3(0, 0.02, 0.44), 0.115, 0.032, 0.125).ball(P3(0, 0.012, 0.545), 0.07, 0.026, 0.06);
    cs.flesh(P3(0, 0.05, 0.44), 0.125, 0.055, 0.14).flesh(P3(0, 0.04, 0.55), 0.08, 0.04, 0.07);
    [-1, 1].forEach(function(s){
      k.ball(P3(s * 0.078, 0.036, 0.455), 0.036, 0.014, 0.036, RM_DARK);                  // orbit (empty socket)
      cs.flesh(P3(s * 0.078, 0.10, 0.46), 0.04, 0.035, 0.04);                             // bulging eye (tissue only)
      k.rod(P3(s * 0.105, 0.004, 0.40), P3(s * 0.035, 0.002, 0.59), 0.011);               // maxilla (upper jaw arch)
      k.rod(P3(s * 0.088, -0.012, 0.405), P3(s * 0.012, -0.012, 0.575), 0.009);           // mandible
      k.ball(P3(s * 0.125, 0.012, 0.385), 0.02, 0.008, 0.02);                             // tympanic ring
    });
    // 8 presacral vertebrae + 1 sacral (9 in all, then the urostyle), with transverse processes; frogs have NO ribs
    for (i = 0; i < 8; i++){
      var z = 0.335 - i * 0.058, tp = i === 0 ? 0.03 : (i < 3 ? 0.085 : 0.06);
      k.ball(P3(0, 0.012, z), 0.024, 0.02, 0.025);
      if (i > 0) [-1, 1].forEach(function(s){ k.rod(P3(s * 0.01, 0.012, z), P3(s * tp, 0.008, z - 0.005), 0.007); });
    }
    k.ball(P3(0, 0.01, -0.13), 0.03, 0.024, 0.03);                                        // sacrum
    [-1, 1].forEach(function(s){ k.rod(P3(s * 0.01, 0.01, -0.13), P3(s * 0.115, 0.005, -0.13), 0.014, true); });
    k.rod(P3(0, 0.008, -0.16), P3(0, 0.004, -0.44), 0.014).ball(P3(0, 0.012, -0.17), 0.02, 0.02, 0.03); // urostyle
    cs.flesh(P3(0, 0.05, -0.08), 0.18, 0.075, 0.30).flesh(P3(0, 0.045, -0.3), 0.12, 0.06, 0.16);
    [-1, 1].forEach(function(s){
      var hip = P3(s * 0.075, 0, -0.41), knee = P3(s * 0.30, 0, -0.25), ankle = P3(s * 0.44, 0, -0.50), tars = P3(s * 0.40, 0, -0.30);
      cs.limb(P3(s * 0.115, 0.005, -0.13), hip, 0.017, 3, true);                          // ilium: long rod forward to the sacrum
      k.ball(hip, 0.03, 0.03, 0.03);                                                      // acetabulum
      cs.limb(hip, knee, 0.02, 3.4, true);                                                // femur
      cs.limb(knee, ankle, 0.017, 3.4, true);                                             // tibio-fibula (fused)
      cs.limb(ankle, tars, 0.012, 3, true);                                               // elongated tarsals (astragalus + calcaneum)
      var lens = [0.15, 0.21, 0.28, 0.34, 0.22], angs = [-0.55, -0.25, 0.02, 0.28, 0.52];
      for (var t = 0; t < 5; t++) rmToe(cs, tars, s, angs[t] * 1, lens[t], 0.007);        // 5 toes, 4th longest
      // pectoral girdle and fore-limb
      var sh = P3(s * 0.13, 0.005, 0.22), el = P3(s * 0.25, 0, 0.10), wr = P3(s * 0.19, 0, 0.26);
      k.rod(sh, P3(s * 0.11, 0.02, 0.31), 0.012);                                          // scapula / suprascapula
      k.rod(sh, P3(s * 0.03, -0.005, 0.24), 0.008);                                        // clavicle
      k.rod(sh, P3(s * 0.03, -0.005, 0.15), 0.009);                                        // coracoid
      cs.limb(sh, el, 0.014, 3.4, true);                                                  // humerus
      cs.limb(el, wr, 0.012, 3.4, true);                                                  // radio-ulna (fused)
      for (var f = 0; f < 4; f++) rmToe(cs, wr, s, -0.25 + f * 0.2, 0.08 + (f === 1 || f === 2 ? 0.03 : 0), 0.006);
    });
    k.ball(P3(0, -0.005, 0.13), 0.018, 0.008, 0.03);                                      // xiphisternum
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: 0x6b7a3c, decayHex: 0x33291c, boneHex: 0xe4dac2, target: 0.85, sink: 0.012 };
  }

  // ---------- INSECT: empty chitin husk (exuvia-like remains) ----------
  function buildInsectRemains(){
    var k = new BoneKit(0xb79a63, 0.04), dark = new THREE.Color(0x5b4526), i;
    k.ball(P3(0, 0.02, 0.33), 0.05, 0.045, 0.06);                                          // head capsule
    [-1, 1].forEach(function(s){
      k.ball(P3(s * 0.045, 0.045, 0.345), 0.022, 0.02, 0.026, dark);                       // compound eyes
      k.rod(P3(s * 0.02, 0.03, 0.38), P3(s * 0.06, 0.03, 0.52), 0.004).rod(P3(s * 0.06, 0.03, 0.52), P3(s * 0.12, 0.03, 0.66), 0.003); // antenna
      k.rod(P3(s * 0.02, 0.0, 0.385), P3(s * 0.005, 0.0, 0.415), 0.006, false, dark);      // mandible
    });
    k.ball(P3(0, 0.035, 0.22), 0.062, 0.045, 0.07);                                        // prothorax
    k.ball(P3(0, 0.03, 0.11), 0.065, 0.045, 0.055);                                        // mesothorax
    k.ball(P3(0, 0.03, 0.01), 0.062, 0.045, 0.055);                                        // metathorax
    for (i = 0; i < 8; i++) k.ball(P3(0, 0.028, -0.06 - i * 0.055), 0.06 - i * 0.004, 0.042, 0.032); // 8 abdominal segments
    [-1, 1].forEach(function(s){
      k.ball(P3(s * 0.035, 0.078, -0.12), 0.032, 0.006, 0.17, new THREE.Color(0x9a8050));   // wing cover
      k.rod(P3(s * 0.03, 0.02, -0.5), P3(s * 0.05, 0.02, -0.58), 0.004);                    // cercus
      var legs = [[P3(s*0.05,0.015,0.20), P3(s*0.15,0.02,0.32), P3(s*0.26,0,0.30), P3(s*0.31,0,0.24)],
                  [P3(s*0.06,0.015,0.11), P3(s*0.19,0.02,0.15), P3(s*0.30,0,0.03), P3(s*0.36,0,-0.04)],
                  [P3(s*0.06,0.015,0.01), P3(s*0.20,0.03,-0.06), P3(s*0.34,0,-0.24), P3(s*0.36,0,-0.32)]];
      legs.forEach(function(l, li){
        k.rod(l[0], l[1], li === 2 ? 0.012 : 0.008, true);                                   // femur
        k.rod(l[1], l[2], 0.006, true);                                                      // tibia
        var d = l[3].clone().sub(l[2]);
        for (var t = 0; t < 3; t++) k.rod(l[2].clone().addScaledVector(d, t / 3), l[2].clone().addScaledVector(d, (t + 1) / 3), 0.004, true); // 3 tarsal segments
      });
    });
    return { bones: k.build(), tissue: null, boneHex: 0xb79a63, target: 0.62, sink: 0.006, husk: true };
  }
  function buildCaterpillarRemains(){
    var k = new BoneKit(0x5a4128, 0.05), t = new BoneKit(0xffffff, 0.12), i;
    k.ball(P3(0, 0.02, 0.3), 0.032, 0.03, 0.034);                                          // sclerotised head capsule (persists)
    [-1, 1].forEach(function(s){ k.rod(P3(s * 0.012, 0.005, 0.325), P3(s * 0.004, 0.005, 0.345), 0.005); });
    for (i = 0; i < 11; i++){                                                              // soft segmented body (decays away)
      var r = 0.048 - Math.abs(i - 4) * 0.004;
      t.ball(P3(Math.sin(i * 0.5) * 0.03, 0.035, 0.22 - i * 0.075), r, r * 0.9, 0.05);
    }
    for (i = 0; i < 4; i++) k.ball(P3(rmRand(-0.12, 0.12), 0.006, rmRand(-0.1, 0.1)), 0.012, 0.008, 0.016, new THREE.Color(0x2a1f14)); // frass
    return { bones: k.build(), tissue: t.build(), tissueHex: 0x7b9a3a, decayHex: 0x3a2d1a, boneHex: 0x5a4128, target: 0.3, sink: 0.004 };
  }

  // ---------- SNAKE / LIZARD / MAMMAL / BIRD ----------
  function buildSnakeRemains(){
    var cs = new Carcass(0xe0d6bd, 0xffffff), k = cs.bones, N = 48, i, prev = null;
    k.ball(P3(0, 0.02, 0.62), 0.05, 0.03, 0.075).ball(P3(0, 0.012, 0.7), 0.03, 0.02, 0.04);
    [-1, 1].forEach(function(s){
      k.ball(P3(s * 0.04, 0.035, 0.63), 0.014, 0.01, 0.014, RM_DARK);
      k.rod(P3(s * 0.05, 0.0, 0.58), P3(s * 0.02, 0.0, 0.73), 0.008);                    // quadrate-mandible (loosely hinged jaws)
    });
    for (i = 0; i < N; i++){
      var z = 0.5 - i * 0.032, x = Math.sin(i * 0.28) * 0.18 * Math.min(1, i / 8), sc = 1 - i * 0.012;
      var cur = P3(x, 0.014, z);
      k.ball(cur, 0.02 * sc, 0.016 * sc, 0.02 * sc);                                       // vertebra
      if (i > 2 && i < N - 4){                                                             // a pair of ribs on every trunk vertebra
        [-1, 1].forEach(function(s){
          var m = cur.clone().add(P3(s * 0.05 * sc, 0.008, -0.01)), e = cur.clone().add(P3(s * 0.085 * sc, -0.004, -0.028));
          k.rod(cur, m, 0.0045 * sc).rod(m, e, 0.004 * sc);
        });
      }
      if (prev) cs.tissue && cs.tissue.rod(prev, cur, 0.04 * sc, false);
      prev = cur;
    }
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: 0x6a5a3c, decayHex: 0x33291c, boneHex: 0xe0d6bd, target: 1.15, sink: 0.01 };
  }
  // shared land-vertebrate generator: lizard, rabbit, deer
  function buildTetrapodRemains(o){
    var cs = new Carcass(0xe4dac2, 0xffffff), k = cs.bones, i;
    // skull
    k.ball(P3(0, 0.03, o.skullZ), o.cran[0], o.cran[1], o.cran[2]).rod(P3(0, 0.02, o.skullZ + o.cran[2] * 0.6), P3(0, 0.012, o.skullZ + o.cran[2] + o.snout), o.cran[0] * 0.42, true);
    k.rod(P3(0, -0.008, o.skullZ + o.cran[2] * 0.4), P3(0, -0.008, o.skullZ + o.cran[2] + o.snout * 0.9), o.cran[0] * 0.3, true);   // mandible
    [-1, 1].forEach(function(s){
      k.ball(P3(s * o.cran[0] * 0.75, 0.05, o.skullZ + o.cran[2] * 0.35), o.cran[0] * 0.35, o.cran[1] * 0.3, o.cran[0] * 0.35, RM_DARK);   // orbit
      if (o.incisors) k.rod(P3(s * 0.008, 0.012, o.skullZ + o.cran[2] + o.snout), P3(s * 0.008, 0.0, o.skullZ + o.cran[2] + o.snout + 0.022), 0.005);
    });
    cs.flesh(P3(0, 0.05, o.skullZ + o.snout * 0.3), o.cran[0] * 1.25, o.cran[1] * 1.6, (o.cran[2] + o.snout) * 0.75);
    // spine: neck, trunk with ribs, lumbar, tail
    var z0 = o.skullZ - o.cran[2] * 0.7, prev = P3(0, 0.02, z0), n = o.neck + o.trunk + o.lumbar, step = (z0 - o.tailStart) / n;
    for (i = 1; i <= n; i++){
      var z = z0 - i * step, cur = P3(0, 0.02, z);
      k.rod(prev, cur, 0.014, true);
      if (i > o.neck && i <= o.neck + o.trunk){                                           // ribs (paired, curving back)
        var f = (i - o.neck) / o.trunk, rl = o.ribLen * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, f + 0.15)));
        [-1, 1].forEach(function(s){
          var a = cur.clone().add(P3(s * rl * 0.55, -0.005, -0.012)), b = cur.clone().add(P3(s * rl, -0.02, -0.04));
          k.rod(cur, a, 0.005).rod(a, b, 0.0045);
        });
      }
      prev = cur;
    }
    var tail = prev;                                                                      // tail vertebrae
    for (i = 1; i <= o.tailN; i++){
      var tz = tail.z - i * o.tailStep, tx = Math.sin(i * 0.4) * o.tailSway, nxt = P3(tx, 0.015, tz), tr = 0.013 * (1 - i / (o.tailN + 3));
      k.rod(i === 1 ? tail : P3(Math.sin((i - 1) * 0.4) * o.tailSway, 0.015, tz + o.tailStep), nxt, tr, false);
    }
    cs.flesh(P3(0, 0.06, (o.skullZ + o.tailStart) * 0.45), o.bodyW, o.bodyH, (o.skullZ - o.tailStart) * 0.42);
    // pelvis + limbs
    [-1, 1].forEach(function(s){
      k.rod(P3(s * 0.01, 0.02, o.tailStart + 0.02), P3(s * o.pelvisW, 0.01, o.tailStart - 0.09), 0.012, true);   // ilium
      o.limbs.forEach(function(l){
        var a = P3(s * l[0][0], 0.02, l[0][1]), b = P3(s * l[1][0], 0.01, l[1][1]), c = P3(s * l[2][0], 0.008, l[2][1]), d = P3(s * l[3][0], 0.006, l[3][1]);
        if (l[4]) k.rod(P3(s * 0.01, 0.02, l[0][1]), a, 0.006, false);                     // shoulder girdle / clavicle bar
        cs.limb(a, b, l[5], 3.6, true).limb(b, c, l[5] * 0.85, 3.4, true).limb(c, d, l[5] * 0.6, 3, true);
        var h0 = Math.atan2(d.x - c.x, d.z - c.z);                                          // foot continues the limb's direction
        for (var t = 0; t < o.toes; t++){                                                   // toes fan out
          rmToeH(cs, d, h0 + (t - (o.toes - 1) / 2) * 0.26, 0.055 + (t === 1 || t === 2 ? 0.02 : 0), 0.004);
        }
      });
    });
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: o.tissueHex, decayHex: 0x33291c, boneHex: 0xe4dac2, target: o.target, sink: 0.012 };
  }
  function buildLizardRemains(){
    return buildTetrapodRemains({ skullZ: 0.55, cran: [0.045, 0.028, 0.06], snout: 0.07, incisors: false, neck: 4, trunk: 14, lumbar: 4, tailStart: -0.28, tailN: 26, tailStep: 0.028, tailSway: 0.07,
      ribLen: 0.11, bodyW: 0.08, bodyH: 0.045, pelvisW: 0.12, toes: 5, tissueHex: 0x7a6a3a, target: 0.95,
      limbs: [[[0.06, 0.28], [0.19, 0.24], [0.27, 0.34], [0.30, 0.42], true, 0.011], [[0.07, -0.26], [0.20, -0.20], [0.30, -0.34], [0.32, -0.43], false, 0.012]] });
  }
  function buildRabbitRemains(){
    return buildTetrapodRemains({ skullZ: 0.62, cran: [0.06, 0.045, 0.09], snout: 0.10, incisors: true, neck: 7, trunk: 12, lumbar: 7, tailStart: -0.38, tailN: 5, tailStep: 0.022, tailSway: 0.0,
      ribLen: 0.15, bodyW: 0.13, bodyH: 0.075, pelvisW: 0.14, toes: 4, tissueHex: 0x8a7458, target: 0.95,
      limbs: [[[0.10, 0.30], [0.19, 0.24], [0.22, 0.42], [0.22, 0.52], true, 0.014], [[0.12, -0.34], [0.30, -0.18], [0.30, -0.52], [0.28, -0.66], false, 0.018]] });
  }
  function buildDeerRemains(){
    return buildTetrapodRemains({ skullZ: 0.78, cran: [0.06, 0.048, 0.11], snout: 0.16, incisors: false, neck: 7, trunk: 13, lumbar: 6, tailStart: -0.5, tailN: 6, tailStep: 0.024, tailSway: 0.0,
      ribLen: 0.19, bodyW: 0.16, bodyH: 0.085, pelvisW: 0.16, toes: 2, tissueHex: 0x8b6a45, target: 1.05,
      limbs: [[[0.12, 0.40], [0.22, 0.30], [0.26, 0.56], [0.27, 0.72], true, 0.014], [[0.13, -0.44], [0.30, -0.26], [0.32, -0.60], [0.31, -0.80], false, 0.016]] });
  }
  function buildEagleRemains(){
    var cs = new Carcass(0xe6dcc6, 0xffffff), k = cs.bones, i;
    k.ball(P3(0, 0.03, 0.5), 0.05, 0.04, 0.065);                                            // skull with very large orbits
    k.rod(P3(0, 0.02, 0.55), P3(0, 0.0, 0.70), 0.03, true).rod(P3(0, 0.0, 0.70), P3(0, -0.02, 0.73), 0.014); // hooked beak (rhamphotheca gone)
    [-1, 1].forEach(function(s){ k.ball(P3(s * 0.038, 0.05, 0.52), 0.024, 0.02, 0.024, RM_DARK); });
    var prev = P3(0, 0.02, 0.44);
    for (i = 1; i <= 12; i++){                                                              // long, S-curved neck
      var cur = P3(Math.sin(i * 0.55) * 0.04, 0.02 + Math.sin(i * 0.3) * 0.006, 0.44 - i * 0.02);
      k.rod(prev, cur, 0.013, true); prev = cur;
    }
    k.ball(P3(0, 0.02, -0.02), 0.045, 0.028, 0.2);                                          // synsacrum
    k.ball(P3(0, 0.005, 0.06), 0.09, 0.012, 0.15).ball(P3(0, -0.03, 0.06), 0.008, 0.035, 0.15); // sternum + deep keel
    k.ball(P3(0, 0.02, -0.26), 0.02, 0.03, 0.03);                                           // pygostyle
    cs.flesh(P3(0, 0.05, 0.02), 0.13, 0.075, 0.25).flesh(P3(0, 0.05, 0.36), 0.05, 0.05, 0.10).flesh(P3(0, 0.045, 0.5), 0.065, 0.055, 0.09);
    [-1, 1].forEach(function(s){
      k.rod(P3(s * 0.11, 0.005, 0.22), P3(s * 0.005, -0.012, 0.14), 0.009, true);          // furcula (wishbone)
      for (var r = 0; r < 5; r++){ var rz = 0.16 - r * 0.045; k.rod(P3(s * 0.03, 0.02, rz), P3(s * 0.09, 0.0, rz - 0.02), 0.005); }   // ribs to the sternum
      var sh = P3(s * 0.06, 0.02, 0.18), el = P3(s * 0.22, 0.02, 0.05), wr = P3(s * 0.19, 0.02, -0.30), hd = P3(s * 0.21, 0.02, -0.46);
      cs.limb(sh, el, 0.012, 4, true).limb(el, wr, 0.010, 4, true).limb(wr, hd, 0.008, 4, true);   // humerus, ulna, carpometacarpus (folded wing)
      k.rod(P3(s * 0.212, 0.02, 0.05), P3(s * 0.185, 0.02, -0.30), 0.005);                  // radius (thin, beside the ulna)
      var hip = P3(s * 0.07, 0.02, -0.08), kn = P3(s * 0.15, 0.02, 0.06), an = P3(s * 0.17, 0.01, -0.30), ft = P3(s * 0.16, 0.008, -0.50);
      cs.limb(hip, kn, 0.014, 4, true).limb(kn, an, 0.013, 4, true).limb(an, ft, 0.011, 4, true); // femur, tibiotarsus, tarsometatarsus
      [[-0.45, 0.09], [-0.1, 0.11], [0.35, 0.09]].forEach(function(td){ rmToe(cs, ft, s, td[0], td[1], 0.005); });   // 3 forward toes
      k.rod(ft, P3(s * 0.16, 0.006, -0.58), 0.005, true);                                    // hallux (backward toe)
    });
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: 0x5a4a38, decayHex: 0x33291c, boneHex: 0xe6dcc6, target: 0.9, sink: 0.012 };
  }

  // ---------- PLANT LITTER ----------
  function rmLeafTexture(kind){
    var W = kind === "blade" ? 48 : 128, H = 256, c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#d8dcc4";
    g.beginPath();
    if (kind === "blade"){                                       // long narrow blade with parallel veins
      g.moveTo(W * 0.5, 2); g.quadraticCurveTo(W * 0.95, H * 0.5, W * 0.62, H - 2); g.lineTo(W * 0.38, H - 2); g.quadraticCurveTo(W * 0.05, H * 0.5, W * 0.5, 2);
    } else {                                                     // ovate leaf, pointed tip, toothed-free margin
      g.moveTo(W * 0.5, 2); g.bezierCurveTo(W * 1.02, H * 0.28, W * 0.95, H * 0.78, W * 0.5, H - 4);
      g.bezierCurveTo(W * 0.05, H * 0.78, W * -0.02, H * 0.28, W * 0.5, 2);
    }
    g.fill();
    g.strokeStyle = "rgba(90,96,60,0.75)"; g.lineWidth = kind === "blade" ? 1.2 : 2.2;   // midrib
    g.beginPath(); g.moveTo(W * 0.5, 4); g.lineTo(W * 0.5, H - 4); g.stroke();
    g.lineWidth = kind === "blade" ? 0.7 : 1.2; g.strokeStyle = "rgba(90,96,60,0.5)";
    if (kind === "blade"){ [0.34, 0.66].forEach(function(f){ g.beginPath(); g.moveTo(W * f, 8); g.lineTo(W * f, H - 8); g.stroke(); }); }
    else for (var i = 1; i < 8; i++){                             // secondary veins, angled toward the tip
      var y = H * (0.1 + i * 0.105);
      [-1, 1].forEach(function(s){ g.beginPath(); g.moveTo(W * 0.5, y); g.quadraticCurveTo(W * (0.5 + s * 0.2), y - 8, W * (0.5 + s * 0.42), y - 30); g.stroke(); });
    }
    var tex = new THREE.CanvasTexture(c);
    remainsDisposables.push(tex);
    return tex;
  }
  var rmTexBroad = rmLeafTexture("broad"), rmTexBlade = rmLeafTexture("blade");
  function rmLeaf(tex, w, l, curl, tint){                         // slightly curled leaf lying on the ground
    var geo = new THREE.PlaneGeometry(w, l, 3, 8);
    geo.rotateX(-Math.PI / 2);
    var p = geo.attributes.position;
    for (var i = 0; i < p.count; i++){
      var x = p.getX(i) / (w * 0.5), z = p.getZ(i) / (l * 0.5);
      p.setY(i, 0.012 + curl * (x * x) * 0.5 + curl * 0.35 * z * z * 0.3);
    }
    geo.computeVertexNormals();
    var mat = new THREE.MeshLambertMaterial({ map: tex, color: tint, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide });
    remainsDisposables.push(geo, mat);
    var m = new THREE.Mesh(geo, mat);
    m.raycast = rmNoRaycast;
    return m;
  }
  function rmWoodKit(hex){ return new BoneKit(hex, 0.10); }
  function buildPlantRemains(kind){
    var soft = [], wood = new BoneKit(0x8a6d48, 0.10), i;
    function addLeaf(tex, w, l, x, z, yaw, curl){
      var m = rmLeaf(tex, w, l, curl, new THREE.Color(0x6f9a3c));
      m.position.set(x, 0, z); m.rotation.y = yaw;
      soft.push({ mesh: m, freshHex: 0x6f9a3c, midHex: 0xa5843f, decayHex: 0x3f2d1c, keep: 0.62 });
    }
    if (kind === "grass"){
      for (i = 0; i < 11; i++){                                     // dead blades radiating from the crown
        var a = -0.5 + i * 0.6 + rmRand(-0.15, 0.15), len = rmRand(0.5, 0.85);
        addLeaf(rmTexBlade, 0.06, len, Math.sin(a) * len * 0.5, Math.cos(a) * len * 0.5, a, rmRand(-0.03, 0.03));
      }
      wood.ball(P3(0, 0.02, 0), 0.06, 0.03, 0.06).ball(P3(0.03, 0.015, 0.02), 0.03, 0.02, 0.03);   // crown + root bases
      return { bones: wood.build(), soft: soft, boneHex: 0x7a6248, woody: true, scale: 0.7, sink: 0.01 };
    }
    if (kind === "flower"){
      wood.rod(P3(0, 0.02, -0.35), P3(0.05, 0.02, -0.05), 0.011, true).rod(P3(0.05, 0.02, -0.05), P3(-0.02, 0.02, 0.3), 0.009, true).rod(P3(-0.02, 0.02, 0.3), P3(-0.08, 0.022, 0.5), 0.007);
      wood.ball(P3(-0.09, 0.024, 0.52), 0.04, 0.018, 0.04).ball(P3(0, 0.02, -0.36), 0.03, 0.02, 0.03);   // seed head remnant + root crown
      for (i = 0; i < 6; i++){ var pa = i * 1.05; addLeaf(rmTexBroad, 0.09, 0.14, -0.09 + Math.sin(pa) * 0.11, 0.52 + Math.cos(pa) * 0.11, pa, 0.05); }   // dried petals
      addLeaf(rmTexBroad, 0.17, 0.32, 0.2, -0.12, 1.2, 0.06);
      addLeaf(rmTexBroad, 0.15, 0.28, -0.2, 0.08, -1.3, 0.06);
      return { bones: wood.build(), soft: soft, boneHex: 0x8a6d48, woody: true, scale: 0.95, sink: 0.01 };
    }
    // young tree: fallen woody stem (lignin persists) with side twigs, and scattered leaf litter
    wood.rod(P3(0, 0.03, -0.55), P3(0.04, 0.03, 0.5), 0.028, true).rod(P3(0.04, 0.03, 0.5), P3(0.02, 0.028, 0.75), 0.016);
    wood.rod(P3(0.02, 0.03, -0.1), P3(0.32, 0.03, 0.12), 0.012, true).rod(P3(0.03, 0.03, 0.2), P3(-0.28, 0.03, 0.42), 0.011, true).rod(P3(0.04, 0.03, 0.48), P3(0.26, 0.03, 0.66), 0.009, true);
    wood.ball(P3(0, 0.03, -0.58), 0.05, 0.035, 0.05);
    for (i = 0; i < 9; i++) addLeaf(rmTexBroad, rmRand(0.14, 0.2), rmRand(0.24, 0.34), rmRand(-0.5, 0.5), rmRand(-0.4, 0.75), rmRand(0, 6.28), 0.07);
    return { bones: wood.build(), soft: soft, boneHex: 0x7a6248, woody: true, scale: 0.8, sink: 0.012 };
  }

  // ---------- AQUATIC REMAINS (aquatic fork) ----------
  // What sinks to the sea floor and persists, by group:
  //   diatoms      silica frustule: two ribbed valves (epitheca + hypotheca) that come
  //                apart; the golden-brown cell contents decay first
  //   copepod      empty chitin exoskeleton: prosome, narrow urosome, long 1st antennae,
  //                caudal rami, single median (naupliar) eye
  //   krill        empty chitin exoskeleton: carapace + rostrum, stalked eyes, long antennae,
  //                thoracic feeding legs, 6 abdominal segments, swimmerets, tail fan
  //   pteropod     coiled aragonite shell; the soft "wings" (parapodia) decay
  //   arrow worm   soft transparent body decays; only the chitinous grasping spines remain
  //   blue shark   CARTILAGINOUS skeleton: skull, jaws and fin supports decay with the flesh; only the
  //                mineralised parts persist — rows of serrated teeth and calcified vertebral centra
  //                (why shark teeth are such common fossils). Body: slender, long pectoral fins,
  //                heterocercal tail (upper lobe longer). Lying on its belly here.
  //   bony fish    skull + jaws + gill cover, vertebral column with neural spines, ribs and
  //                haemal spines, fin rays, forked tail; flesh decays first.
  //                A dead fish usually lies on its side, so dorsal/ventral run along x here.
  //   dinoflagellates, green microalgae, ciliates: single cells that simply lyse — no remains.
  function buildDiatomRemains(){
    var cs = new Carcass(0xe2ebe3, 0xffffff), k = cs.bones, rib = new THREE.Color(0xaebdb2), i;
    [[-0.13, 0.0, 0.115], [0.14, 0.04, 0.105]].forEach(function(v){        // the two valves, side by side
      k.ball(P3(v[0], 0.015, v[1]), v[2], 0.018, v[2]);
      for (i = 0; i < 14; i++){                                               // radial striae (silica ribs)
        var a = i / 14 * Math.PI * 2;
        k.rod(P3(v[0], 0.034, v[1]), P3(v[0] + Math.cos(a) * v[2] * 0.95, 0.03, v[1] + Math.sin(a) * v[2] * 0.95), 0.0035, false, rib);
      }
      k.ball(P3(v[0], 0.036, v[1]), 0.016, 0.004, 0.016, rib);               // central area
    });
    cs.flesh(P3(-0.13, 0.04, 0.0), 0.085, 0.03, 0.085);                      // chloroplasts / cytoplasm (decays)
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: 0x9a7b2e, decayHex: 0x4a4434, boneHex: 0xe2ebe3, target: 0.42, sink: 0.006 };
  }

  function buildCopepodRemains(){
    var k = new BoneKit(0xcdb88e, 0.04), eye = new THREE.Color(0x8a2a1a), i;
    k.ball(P3(0, 0.03, 0.18), 0.07, 0.055, 0.13);                                          // cephalosome
    for (i = 0; i < 4; i++) k.ball(P3(0, 0.03, 0.04 - i * 0.05), 0.065 - i * 0.008, 0.05 - i * 0.005, 0.035);   // thoracic segments (prosome)
    for (i = 0; i < 4; i++) k.ball(P3(0, 0.025, -0.17 - i * 0.045), 0.022, 0.02, 0.026);   // urosome
    k.ball(P3(0, 0.07, 0.27), 0.013, 0.012, 0.013, eye);                                   // single median (naupliar) eye
    [-1, 1].forEach(function(s){
      k.rod(P3(s * 0.01, 0.025, -0.33), P3(s * 0.03, 0.025, -0.41), 0.004, true);          // caudal ramus
      k.rod(P3(s * 0.03, 0.025, -0.41), P3(s * 0.06, 0.025, -0.53), 0.0018);               // caudal seta
      var a1 = [P3(s * 0.04, 0.03, 0.29), P3(s * 0.18, 0.03, 0.31), P3(s * 0.34, 0.03, 0.25), P3(s * 0.47, 0.03, 0.14)];
      for (i = 0; i < 3; i++) k.rod(a1[i], a1[i + 1], 0.005 - i * 0.001, true);           // long 1st antenna
      for (i = 0; i < 4; i++) k.rod(P3(s * 0.04, 0.0, 0.06 - i * 0.05), P3(s * 0.10, 0.0, 0.03 - i * 0.05), 0.003);   // swimming legs
    });
    return { bones: k.build(), tissue: null, boneHex: 0xcdb88e, target: 0.5, sink: 0.005, husk: true };
  }

  function buildKrillRemains(){
    var k = new BoneKit(0xdba387, 0.04), dark = new THREE.Color(0x2a1d16), i;
    k.ball(P3(0, 0.03, 0.22), 0.06, 0.05, 0.16);                                           // carapace (cephalothorax)
    k.rod(P3(0, 0.05, 0.37), P3(0, 0.045, 0.45), 0.006);                                   // rostrum
    for (i = 0; i < 6; i++) k.ball(P3(0, 0.03, 0.04 - i * 0.07), 0.05 - i * 0.005, 0.042 - i * 0.003, 0.04);   // 6 abdominal segments
    k.ball(P3(0, 0.025, -0.42), 0.012, 0.008, 0.06);                                       // telson
    [-1, 1].forEach(function(s){
      k.ball(P3(s * 0.045, 0.05, 0.36), 0.022, 0.022, 0.022, dark);                        // stalked compound eye
      k.rod(P3(s * 0.02, 0.03, 0.38), P3(s * 0.08, 0.03, 0.62), 0.004).rod(P3(s * 0.08, 0.03, 0.62), P3(s * 0.12, 0.03, 0.86), 0.003);   // antenna
      k.rod(P3(s * 0.015, 0.03, 0.39), P3(s * 0.05, 0.03, 0.52), 0.003);                   // antennule
      for (i = 0; i < 6; i++){                                                             // thoracic feeding legs ("feeding basket")
        var z = 0.28 - i * 0.04;
        k.rod(P3(s * 0.04, 0.0, z), P3(s * 0.11, 0.0, z - 0.02), 0.004, true).rod(P3(s * 0.11, 0.0, z - 0.02), P3(s * 0.15, 0.0, z - 0.06), 0.003);
      }
      for (i = 0; i < 5; i++) k.rod(P3(s * 0.03, 0.0, 0.03 - i * 0.07), P3(s * 0.08, 0.0, 0.0 - i * 0.07), 0.003);   // swimmerets (pleopods)
      k.ball(P3(s * 0.035, 0.025, -0.43), 0.025, 0.006, 0.055);                            // uropod (tail fan)
    });
    return { bones: k.build(), tissue: null, boneHex: 0xdba387, target: 0.62, sink: 0.006, husk: true };
  }

  function buildPteropodRemains(){
    var cs = new Carcass(0xeae5d7, 0xffffff), k = cs.bones, i;
    for (i = 0; i < 26; i++){                                                              // coiled aragonite shell
      var a = -i * 0.42, r = 0.02 + i * 0.0042, sz = 0.012 + i * 0.0016;
      k.ball(P3(Math.cos(a) * r, 0.02 + (26 - i) * 0.0012, Math.sin(a) * r), sz, sz, sz);
    }
    cs.flesh(P3(0.02, 0.04, 0.09), 0.05, 0.035, 0.05);
    [-1, 1].forEach(function(s){ cs.flesh(P3(s * 0.15, 0.03, 0.10), 0.11, 0.008, 0.06); });   // parapodia ("wings")
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: 0x9fb7c9, decayHex: 0x4a463a, boneHex: 0xeae5d7, target: 0.3, sink: 0.008 };
  }

  function buildArrowWormRemains(){
    var k = new BoneKit(0xd8c9a0, 0.04), t = new BoneKit(0xffffff, 0.12), i;
    for (i = 0; i < 9; i++) t.ball(P3(0, 0.02, 0.30 - i * 0.08), 0.028, 0.02, 0.055);     // slender transparent body
    [-1, 1].forEach(function(s){
      t.ball(P3(s * 0.05, 0.012, -0.14), 0.03, 0.006, 0.08);                               // posterior lateral fin
      t.ball(P3(s * 0.045, 0.012, 0.06), 0.025, 0.006, 0.06);                              // anterior lateral fin
      for (i = 0; i < 6; i++){                                                             // chitinous grasping spines (persist)
        var b = P3(s * (0.015 + i * 0.004), 0.025, 0.36 + i * 0.006);
        k.rod(b, P3(s * (0.05 + i * 0.012), 0.025, 0.44 + i * 0.012), 0.0035, false);
      }
    });
    t.ball(P3(0, 0.012, -0.42), 0.05, 0.006, 0.05);                                        // tail fin
    return { bones: k.build(), tissue: t.build(), tissueHex: 0xcfd8d6, decayHex: 0x4a463a, boneHex: 0xd8c9a0, scale: 0.7, sink: 0.004 };
  }

  function buildFishRemains(tissueHex, target){
    var cs = new Carcass(0xe6dcc4, 0xffffff), k = cs.bones, N = 34, i;
    // skull: neurocranium, orbit, jaws, gill cover (operculum)
    k.ball(P3(0.0, 0.025, 0.47), 0.085, 0.03, 0.10);
    k.ball(P3(0.03, 0.05, 0.52), 0.028, 0.01, 0.028, RM_DARK);                             // orbit (empty socket)
    k.rod(P3(0.01, 0.02, 0.61), P3(-0.04, 0.02, 0.45), 0.008, true);                       // upper jaw
    k.rod(P3(-0.03, 0.015, 0.59), P3(-0.08, 0.015, 0.42), 0.008, true);                    // lower jaw
    k.ball(P3(-0.02, 0.02, 0.38), 0.085, 0.01, 0.05);                                      // operculum
    cs.flesh(P3(0, 0.04, 0.47), 0.10, 0.05, 0.13);
    // vertebral column with neural spines (dorsal, +x), ribs (abdominal) and haemal spines (caudal)
    for (i = 0; i < N; i++){
      var f = i / N, z = 0.33 - f * 0.78, r = 0.016 * (1 - f * 0.5), taper = 1 - f * 0.55;
      k.ball(P3(0, 0.02, z), r, r, r * 1.2);
      k.rod(P3(0.01, 0.02, z), P3(0.10 * taper, 0.02, z - 0.04), 0.0035);                  // neural spine
      if (f < 0.45) k.rod(P3(-0.01, 0.02, z), P3(-0.14 * taper, 0.018, z - 0.05), 0.0035); // rib
      else k.rod(P3(-0.01, 0.02, z), P3(-0.09 * taper, 0.02, z - 0.04), 0.0035);           // haemal spine
      if (i > 7 && i < 18) k.rod(P3(0.11 * taper, 0.02, z), P3(0.19 * taper, 0.02, z - 0.05), 0.0022);   // dorsal-fin rays
      if (i > 20 && i < 26) k.rod(P3(-0.10 * taper, 0.02, z), P3(-0.16 * taper, 0.02, z - 0.05), 0.0022); // anal-fin rays
    }
    for (i = -5; i <= 5; i++){                                                             // forked caudal fin
      var a = i * 0.13, len = 0.10 + 0.09 * Math.abs(i) / 5;
      k.rod(P3(0, 0.02, -0.46), P3(Math.sin(a) * len * 1.3, 0.02, -0.46 - Math.cos(a) * len), 0.0025);
    }
    for (i = 0; i < 5; i++) k.rod(P3(-0.05, 0.022, 0.33), P3(-0.09 - i * 0.012, 0.022, 0.20 - i * 0.008), 0.002);   // pectoral-fin rays
    cs.flesh(P3(0, 0.045, 0.12), 0.16, 0.055, 0.32).flesh(P3(0, 0.035, -0.32), 0.07, 0.035, 0.14);
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: tissueHex, decayHex: 0x3a3226, boneHex: 0xe6dcc4, target: target, sink: 0.01 };
  }

  function buildSharkRemains(){
    var cs = new Carcass(0xece6d6, 0xffffff), k = cs.bones, i, row;
    var centrum = new THREE.Color(0xdcd2bc);
    for (i = 0; i < 40; i++){                                                              // calcified vertebral centra (disc-shaped)
      var f = i / 39, z = 0.40 - f * 0.92, r = 0.024 * (1 - f * 0.55);
      var jx = (Math.random() - 0.5) * 0.012 * (1 + f), x = (f > 0.82 ? (f - 0.82) * 0.35 : 0) + jx;   // tail end bends upward into the upper lobe
      k.ball(P3(x, 0.02, z), r, r, r * 0.45, centrum);
    }
    for (row = 0; row < 2; row++){                                                         // two jaw rows of serrated teeth, slightly scattered
      for (i = 0; i < 13; i++){
        var a = (i / 12 - 0.5) * 2.3, R = row ? 0.085 : 0.11;
        var tx = Math.sin(a) * R + (Math.random() - 0.5) * 0.02, tz = 0.50 + Math.cos(a) * R * 0.75 + (row ? -0.04 : 0) + (Math.random() - 0.5) * 0.02;
        var rot = a + (Math.random() - 0.5) * 0.6, sz = 0.016 - Math.abs(a) * 0.003;
        k.ball(P3(tx, 0.012, tz), sz * 0.8, 0.004, sz * 1.25);                             // flat triangular crown
        k.ball(P3(tx + Math.sin(rot) * sz * 0.9, 0.012, tz + Math.cos(rot) * sz * 0.9), sz * 0.35, 0.004, sz * 0.6);   // curved tip
      }
    }
    // flesh + cartilage (all decays): head and snout, body, long pectoral fins, dorsal fin, heterocercal tail
    cs.flesh(P3(0, 0.05, 0.52), 0.10, 0.05, 0.16).flesh(P3(0, 0.06, 0.18), 0.13, 0.075, 0.30).flesh(P3(0, 0.045, -0.20), 0.08, 0.05, 0.22);
    [-1, 1].forEach(function(s){ cs.flesh(P3(s * 0.22, 0.03, 0.18), 0.17, 0.012, 0.06); });   // long, narrow pectoral fins
    cs.flesh(P3(0, 0.12, 0.08), 0.012, 0.06, 0.06);                                       // first dorsal fin
    cs.flesh(P3(0.06, 0.03, -0.62), 0.03, 0.012, 0.16).flesh(P3(-0.03, 0.03, -0.50), 0.025, 0.012, 0.07);   // tail: long upper lobe, short lower lobe
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: 0x3e6696, decayHex: 0x3a3226, boneHex: 0xece6d6, target: 1.1, sink: 0.008 };
  }

  var RM_BUILDERS = {
    "tl1-diatoms": buildDiatomRemains,
    "tl2-copepod": buildCopepodRemains, "tl2-krill": buildKrillRemains, "tl2-pteropod": buildPteropodRemains,
    "tl3-herring": function(){ return buildFishRemains(0x8f9ca3, 0.85); },
    "tl3-anchovy": function(){ return buildFishRemains(0x9aa9a6, 0.72); },
    "tl3-arrow-worm": buildArrowWormRemains,
    "tl4-blue-shark": buildSharkRemains
    // tl1-dinoflagellates, tl1-green-microalgae, tl2-ciliate: single cells lyse — nothing persists
  };
  // ---------- POND REMAINS (habitat switch: Pond) ----------
  //   Hydrilla      soft stem with whorls of small leaves; almost all of it decays (no wood)
  //   lotus         the large round leaf decays; the fibrous dried seed pod (receptacle) persists
  //   Daphnia       moulted/empty carapace: bivalved shell, head, single compound eye,
  //                 large branched (biramous) second antennae, tail spine
  //   pond snail    tall, pointed spiral shell (calcium carbonate) persists; the foot decays
  //   tadpole       soft body + tail decay; only the keratinised jaw sheaths remain briefly
  //   insects (mayfly / dragonfly nymphs) -> empty chitin husk; small fish, frog, water snake -> skeletons
  //   Spirogyra     filamentous alga: cells decay quickly, nothing persists
  function rmSoftLeaf(soft, tex, w, l, x, z, yaw, fresh, keep){
    var m = rmLeaf(tex, w, l, 0.02, new THREE.Color(fresh));
    m.position.set(x, 0, z); m.rotation.y = yaw;
    soft.push({ mesh: m, freshHex: fresh, midHex: 0x9a8a42, decayHex: 0x3a2f1e, keep: keep });
  }
  function buildHydrillaRemains(){
    var soft = [], stem = new BoneKit(0x8f8a5a, 0.08), i, j;
    stem.rod(P3(0, 0.02, -0.5), P3(0.03, 0.02, 0.0), 0.008).rod(P3(0.03, 0.02, 0.0), P3(-0.02, 0.02, 0.5), 0.007)
        .rod(P3(0.03, 0.02, 0.0), P3(0.25, 0.02, 0.3), 0.006);                               // branching soft stem
    for (i = 0; i < 7; i++){                                                                 // whorls of small leaves at each node
      var z = -0.45 + i * 0.15, x = z < 0 ? 0.03 * (z + 0.5) / 0.5 : 0.03 - 0.05 * z / 0.5;
      for (j = 0; j < 4; j++){
        var a = j * 1.57 + i * 0.4;
        rmSoftLeaf(soft, rmTexBlade, 0.035, 0.11, x + Math.sin(a) * 0.05, z + Math.cos(a) * 0.05, a, 0x5f8f3a, 0.35);
      }
    }
    return { bones: stem.build(), soft: soft, boneHex: 0x8f8a5a, woody: true, scale: 0.85, sink: 0.01 };
  }
  function buildLotusRemains(){
    var soft = [], wood = new BoneKit(0x7d6a48, 0.08), i;
    rmSoftLeaf(soft, rmTexBroad, 0.55, 0.55, -0.18, 0.1, 0.3, 0x5e9441, 0.55);               // large round leaf (decays)
    wood.rod(P3(-0.18, 0.02, 0.1), P3(0.25, 0.02, -0.38), 0.011);                            // leaf stalk (petiole)
    wood.ball(P3(0.32, 0.05, 0.22), 0.12, 0.06, 0.12);                                       // dried seed pod (receptacle)
    for (i = 0; i < 9; i++){ var a = i * 0.785, r = i ? 0.07 : 0; wood.ball(P3(0.32 + Math.cos(a) * r, 0.105, 0.22 + Math.sin(a) * r), 0.018, 0.008, 0.018, RM_DARK); }   // seed pits
    wood.rod(P3(0.32, 0.03, 0.1), P3(0.45, 0.02, -0.32), 0.01);                              // pod stalk
    return { bones: wood.build(), soft: soft, boneHex: 0x7d6a48, woody: true, scale: 0.85, sink: 0.01 };
  }
  function buildDaphniaRemains(){
    var k = new BoneKit(0xd7c9a0, 0.04), eye = new THREE.Color(0x1d1a16), i;
    k.ball(P3(0, 0.035, -0.02), 0.06, 0.05, 0.2);                                            // bivalved carapace
    k.ball(P3(0, 0.03, 0.22), 0.05, 0.045, 0.07);                                            // head
    k.ball(P3(0, 0.06, 0.25), 0.022, 0.02, 0.022, eye);                                      // single compound eye
    k.rod(P3(0, 0.03, -0.22), P3(0, 0.03, -0.36), 0.005);                                    // tail spine
    [-1, 1].forEach(function(s){
      var b = P3(s * 0.04, 0.035, 0.17), m = P3(s * 0.16, 0.035, 0.20), r1 = P3(s * 0.28, 0.035, 0.27), r2 = P3(s * 0.29, 0.035, 0.13);
      k.rod(b, m, 0.009, true);                                                              // 2nd antenna: base
      k.rod(m, r1, 0.004, true).rod(m, r2, 0.004, true);                                     // ...and its two branches
      for (i = 0; i < 3; i++){
        k.rod(r1, P3(s * (0.33 + i * 0.01), 0.035, 0.30 - i * 0.04), 0.0015);                // swimming setae
        k.rod(r2, P3(s * (0.34 + i * 0.01), 0.035, 0.15 - i * 0.04), 0.0015);
      }
    });
    return { bones: k.build(), tissue: null, boneHex: 0xd7c9a0, target: 0.5, sink: 0.005, husk: true };
  }
  function buildPondSnailRemains(){
    var cs = new Carcass(0xc9b48e, 0xffffff), k = cs.bones, i;
    for (i = 0; i < 44; i++){                                                                // tall pointed spire, lying on its side
      var f = i / 43, a = i * 0.5, r = 0.008 + f * 0.06, sz = 0.014 + f * 0.045;          // overlapping whorls read as a solid cone
      k.ball(P3(Math.cos(a) * r, 0.06 + Math.sin(a) * r * 0.6, -0.25 + f * 0.36), sz, sz * 0.9, sz);
    }
    k.ball(P3(0.0, 0.05, 0.15), 0.035, 0.025, 0.015, RM_DARK);                               // aperture
    cs.flesh(P3(0, 0.03, 0.22), 0.06, 0.025, 0.1);                                           // muscular foot (decays)
    return { bones: k.build(), tissue: cs.tissue.build(), tissueHex: 0x5d5545, decayHex: 0x3a3226, boneHex: 0xc9b48e, target: 0.38, sink: 0.008 };
  }
  function buildTadpoleRemains(){
    var k = new BoneKit(0x2a241c, 0.05), t = new BoneKit(0xffffff, 0.12), i;
    k.ball(P3(0, 0.02, 0.24), 0.02, 0.008, 0.012);                                           // keratinised jaw sheaths
    t.ball(P3(0, 0.04, 0.12), 0.11, 0.08, 0.14);                                             // rounded body
    for (i = 0; i < 8; i++) t.ball(P3(Math.sin(i * 0.6) * 0.02, 0.03, -0.04 - i * 0.05), 0.05 * (1 - i / 9), 0.025, 0.035);   // tail
    return { bones: k.build(), tissue: t.build(), tissueHex: 0x4b4a36, decayHex: 0x2f2a20, boneHex: 0x2a241c, scale: 0.8, sink: 0.004 };
  }
  RM_BUILDERS["pond-tl1-hydrilla"] = buildHydrillaRemains;
  RM_BUILDERS["pond-tl1-lotus"] = buildLotusRemains;
  RM_BUILDERS["pond-tl2-daphnia"] = buildDaphniaRemains;
  RM_BUILDERS["pond-tl2-snail"] = buildPondSnailRemains;
  RM_BUILDERS["pond-tl2-tadpole"] = buildTadpoleRemains;
  RM_BUILDERS["pond-tl2-mayfly-nymph"] = buildInsectRemains;
  RM_BUILDERS["pond-tl3-small-fish"] = function(){ return buildFishRemains(0x8d9a8a, 0.6); };
  RM_BUILDERS["pond-tl3-frog"] = buildFrogRemains;
  RM_BUILDERS["pond-tl3-dragonfly-nymph"] = buildInsectRemains;
  RM_BUILDERS["pond-tl4-water-snake"] = buildSnakeRemains;
  // pond-tl1-spirogyra: filamentous alga decays quickly — nothing persists



  // ---- spawn: body falls from the organism's position to a free spot on the soil ----
  function spawnRemains(asset, slot){
    var build = RM_BUILDERS[asset.id];
    if (!build || !slot) return null;
    var def = build();
    var scale = def.scale || 1;
    if (def.target){
      def.bones.computeBoundingBox();
      var bb = def.bones.boundingBox;
      scale = def.target / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 0.01);   // every model gets a similar footprint
    }
    var slotXZ = RM_SLOTS[remainsList.length % RM_SLOTS.length];
    var gx = slotXZ[0] + rmRand(-0.08, 0.08), gz = slotXZ[1] + rmRand(-0.08, 0.08);
    var gy = soilHeight(gx, gz) + 0.012;
    var e = 0.15, slopeN = new THREE.Vector3(-(soilHeight(gx + e, gz) - soilHeight(gx - e, gz)) / (2 * e), 1, -(soilHeight(gx, gz + e) - soilHeight(gx, gz - e)) / (2 * e)).normalize();
    var yaw = Math.random() * 6.28;
    var qLand = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), slopeN).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));   // lie flat on the slope
    var group = new THREE.Group();
    group.name = "remains-" + asset.id;
    var boneMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xffffff });
    var bones = new THREE.Mesh(def.bones, boneMat);
    bones.raycast = rmNoRaycast;
    group.add(bones);
    remainsDisposables.push(def.bones, boneMat);
    var r = { asset: asset, group: group, def: def, scale: scale, boneMat: boneMat, tissueMat: null, tissue: null, softs: [], gx: gx, gy: gy, gz: gz, yaw: yaw, qLand: qLand,
              start: new THREE.Vector3().copy(slot.sprite.position), spawnAt: elapsed, fall: 0.8 + Math.min(0.9, Math.max(0, slot.sprite.position.y - gy) * 0.09), finished: false };
    if (def.tissue){
      r.tissueMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: def.tissueHex, transparent: true, opacity: 1 });
      r.tissue = new THREE.Mesh(def.tissue, r.tissueMat);
      r.tissue.raycast = rmNoRaycast;
      group.add(r.tissue);
      remainsDisposables.push(def.tissue, r.tissueMat);
    }
    if (def.soft){ def.soft.forEach(function(s){ group.add(s.mesh); r.softs.push(s); }); }
    group.scale.setScalar(0.3);
    group.position.copy(r.start);
    group.rotation.y = r.yaw;
    remainsRoot.add(group);
    remainsList.push(r);
    if (DEV_MODE) console.log("Remains spawned:", asset.id);
    return r;
  }

  function updateRemains(elapsedTime, delta){
    for (var i = 0; i < remainsList.length; i++){
      var r = remainsList[i];
      if (r.finished) continue;
      var t = elapsedTime - r.spawnAt, def = r.def, g = r.group;
      if (t < r.fall){                                             // 1) falling: tumbling, small
        var f = t / r.fall, fe = f * f;
        g.position.set(r.start.x + (r.gx - r.start.x) * (f * (2 - f)), r.start.y + (r.gy - r.start.y) * fe, r.start.z + (r.gz - r.start.z) * (f * (2 - f)));
        g.rotation.set(Math.sin(t * 5) * 0.5 * (1 - f), r.yaw + t * 3 * (1 - f), Math.cos(t * 4) * 0.4 * (1 - f));
        g.scale.setScalar(0.3);
        continue;
      }
      var age = t - r.fall;
      var settle = rmSmooth(0, 0.45, age);                          // 2) lands: rotation settles, grows to true size
      g.quaternion.copy(r.qLand);
      g.scale.setScalar((0.3 + 0.7 * settle) * r.scale);
      var decay = rmSmooth(RM_TIME.FRESH, RM_TIME.DECAY_END, age);   // 3) soft tissue is consumed
      var weather = rmSmooth(RM_TIME.DECAY_END, RM_TIME.SETTLE_END, age);   // 4) hard parts weather and sink
      var sink = def.sink * weather;
      g.position.set(r.gx, r.gy - sink, r.gz);
      // hard parts: vertex colours carry the hue; the material colour is a multiplier (ageing + soil stain)
      if (def.husk){
        r.boneMat.color.setRGB(0.55, 0.50, 0.42).lerp(tmpRmColor.setRGB(1, 1, 1), decay).multiplyScalar(1 - 0.15 * weather);   // fresh dead insect is dark; the husk pales
        r.boneMat.transparent = true; r.boneMat.opacity = 1 - 0.22 * decay;                                                       // ...and turns translucent
      } else if (def.woody){
        r.boneMat.color.setRGB(1, 1, 1).lerp(tmpRmColor.setRGB(0.72, 0.70, 0.66), weather);                                       // wood weathers grey-brown
      } else {
        r.boneMat.color.setRGB(1, 1, 1).lerp(tmpRmColor.setRGB(0.78, 0.75, 0.68), weather);                                      // bone yellows and is stained by soil
      }
      if (r.tissue){                                               // carcass: fades and collapses, revealing the skeleton
        r.tissueMat.color.setHex(def.tissueHex).lerp(tmpRmColor.setHex(def.decayHex), Math.min(1, decay * 1.4));
        r.tissueMat.opacity = 1 - decay;
        r.tissueMat.depthWrite = decay < 0.15;
        r.tissue.scale.set(1 - 0.35 * decay, 1 - 0.75 * decay, 1 - 0.35 * decay);
        r.tissue.visible = r.tissueMat.opacity > 0.01;
      }
      r.softs.forEach(function(s){                                 // leaves: green -> yellow-brown -> dark, thinner, partly buried
        var c = s.mesh.material.color;
        if (decay < 0.5) c.setHex(s.freshHex).lerp(tmpRmColor.setHex(s.midHex), decay * 2);
        else c.setHex(s.midHex).lerp(tmpRmColor.setHex(s.decayHex), Math.min(1, (decay - 0.5) * 2 + weather * 0.3));
        var k = 1 - (1 - s.keep) * weather;
        s.mesh.scale.set(k, 1, k);
        s.mesh.material.opacity = 1 - 0.35 * weather;
      });
      if (age > RM_TIME.SETTLE_END + 0.5){ r.finished = true; if (r.tissue) r.tissue.visible = false; }
    }
  }
  var tmpRmColor = new THREE.Color();
  window.addEventListener("pagehide", function(){ remainsDisposables.forEach(function(o){ if (o && o.dispose) o.dispose(); }); });

  // =========================================================
  // ECOSYSTEM FLOW — slow, user-controlled learning sequence
  //
  // Tap the Sun to begin. Nothing advances by itself: the RIGHT arrow plays
  // the next biological step (one slow, one-shot animation that then holds
  // as a stable picture), the LEFT arrow returns to the previous stable
  // picture, and Reset returns the whole ecosystem to its resting state.
  //
  //   1 PAR          Sun -> PAR reaches the producers      (existing Sun/PAR)
  //   2 Producers    PAR is captured: chemical energy stored (TL1 = 100)
  //   3 TL1 -> TL2   ~10 % passes on (TL2 = 10); heat is lost
  //   4 TL2 -> TL3   ~10 % again (TL3 = 1); heat is lost
  //   5 TL3 -> TL4   ~10 % again (TL4 = 0.1); heat is lost
  //   6 Decomposers  dead matter, litter and waste from ALL levels fall to
  //                  the decomposers (fungi, bacteria, soil animals)
  //   7 Mineralisation  decomposers release inorganic nutrients that return
  //                  to PRODUCERS ONLY
  //
  // The science it shows (illustrative teaching values, not measurements):
  //   ENERGY flows one way and is lost as heat at every level; it never
  //   cycles. MATTER cycles: nutrients return from the decomposers to the
  //   producers only; nothing flows from decomposers to consumers.
  //
  // How it works: `ecosystemStep` is the single source of truth. The persistent
  // visuals of a step are a pure function of one step clock T (FLOW_B[k] is the
  // clock value of stable step k), so Back never plays anything in reverse: it
  // clears the transient effects (streams, heat, falling bits, nutrient
  // particles) and simply draws the previous completed step. Right plays the
  // next step forward in real time, then holds. Everything shares the Sun run
  // (`run`), so Reset cancels it with the Sun. No timers; objects are pooled.
  // =========================================================
  var FLOW_TOTAL = 7;
  var FLOW_STEP_LABELS = [null, "PAR", "Producers", "TL1 \u2192 TL2", "TL2 \u2192 TL3", "TL3 \u2192 TL4", "Decomposers", "Mineralisation"];
  var FLOW_B = [0, 0, 2.8, 6.8, 10.8, 14.8, 21.0, 26.0];   // stable step-clock value of each step (index = step)
  var FLOW_T = {
    TRANSFER: [[3.0, 6.0], [7.0, 10.0], [11.0, 14.0]],     // streams, one per gap, ~3 s each (slow)
    DETRITUS_START: 15.0,
    NUTRIENT_START: 21.0
  };

  // Receiver highlight per trophic level. `band` is the moving highlight,
  // `amb` a soft steady tint, `glow` a small emissive lift. Every value
  // shrinks with level so TL1 is strongest and TL4 weakest.
  var FLOW_LEVEL = {
    1: { colA: 0xffd479, colB: 0x8fe3c7, band: 0.50, amb: 0.16, glow: 0.10, win: [0.2, 2.0] },  // gold + mint
    2: { colA: 0xc6ea5a, colB: 0xfacc15, band: 0.28, amb: 0.09, glow: 0.07, win: [4.3, 6.0] },  // green-yellow / yellow
    3: { colA: 0xffb347, colB: 0xfb923c, band: 0.16, amb: 0.05, glow: 0.04, win: [8.3, 10.0] }, // amber-orange
    4: { colA: 0xe88b86, colB: 0xf4b0a6, band: 0.09, amb: 0.03, glow: 0.02, win: [12.3, 14.0] } // muted coral-pink
  };

  function flowStep(a, b, x){
    var t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  var flow = { phase: "IDLE", runId: 0, grown: false, mode: "IDLE", T: 0 };
  var flowRoot = new THREE.Group();
  flowRoot.visible = false;
  scene.add(flowRoot);
  var flowDisposables = [];
  var flowTmp = new THREE.Vector3();

  function makeFlowPoints(n, hex, size){
    var pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    var mat = new THREE.PointsMaterial({
      size: size, map: glowTexture, vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;   // positions are rewritten every frame
    pts.visible = false;
    flowRoot.add(pts);
    flowDisposables.push(geo, mat);
    return { pts: pts, geo: geo, pos: pos, col: col, base: new THREE.Color(hex), n: n };
  }
  function hideFlowPoints(o){
    o.pts.visible = false;
    for (var i = 0; i < o.col.length; i++) o.col[i] = 0;
    o.geo.attributes.color.needsUpdate = true;
  }
  function setFlowPoint(o, i, x, y, z, b){
    o.pos[i*3] = x; o.pos[i*3+1] = y; o.pos[i*3+2] = z;
    o.col[i*3] = o.base.r * b; o.col[i*3+1] = o.base.g * b; o.col[i*3+2] = o.base.b * b;
  }
  function flushFlowPoints(o){
    o.geo.attributes.position.needsUpdate = true;
    o.geo.attributes.color.needsUpdate = true;
  }

  // ---- 1. Receiver highlights: a soft gradient that sweeps across each
  //         prism. Child of the layer mesh (shares its geometry, follows its
  //         selection scale) and drawn additively, so the layer keeps its
  //         own colour and transparency underneath. -------------------------
  var flowOverlays = {};
  layerMeshes.forEach(function(layerMesh){
    var id = layerMesh.userData.layerId, layer = layers[id - 1], st = FLOW_LEVEL[id];
    if (!layer || !st) return;
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uColA: { value: new THREE.Color(st.colA) }, uColB: { value: new THREE.Color(st.colB) },
        uBandPos: { value: -1 }, uBand: { value: 0 }, uAmb: { value: 0 },
        uY0: { value: layer.yBottom }, uY1: { value: layer.yTop },
        uXR: { value: Math.max(layer.wBottom, layer.wTop) * 0.5 * 0.866 }
      },
      vertexShader:
        "varying vec3 vPos;\n" +
        "void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "uniform vec3 uColA; uniform vec3 uColB;\n" +
        "uniform float uBandPos; uniform float uBand; uniform float uAmb;\n" +
        "uniform float uY0; uniform float uY1; uniform float uXR;\n" +
        "varying vec3 vPos;\n" +
        "void main(){\n" +
        "  float ty = clamp((vPos.y - uY0) / (uY1 - uY0), 0.0, 1.0);\n" +
        "  float tx = clamp(vPos.x / uXR * 0.5 + 0.5, 0.0, 1.0);\n" +
        "  float s = 0.55 * ty + 0.45 * tx;\n" +               // diagonal sweep coordinate
        "  float d = (s - uBandPos) / 0.22;\n" +
        "  float band = exp(-d * d);\n" +
        "  vec3 col = mix(uColA, uColB, smoothstep(0.0, 1.0, s));\n" +
        "  gl_FragColor = vec4(col, uAmb + uBand * band);\n" +
        "}",
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    var mesh = new THREE.Mesh(layerMesh.geometry, mat); // geometry is shared — never disposed here
    mesh.renderOrder = 1;
    mesh.visible = false;
    mesh.frustumCulled = false;
    layerMesh.add(mesh);
    flowDisposables.push(mat);
    flowOverlays[id] = { mesh: mesh, mat: mat, layerMesh: layerMesh };
  });

  // ---- 2. Energy transfer streams (bright, upward, fast) through the
  //         existing gaps. Reuses buildGapCurve + the shared glow texture.
  //         Colour = the RECEIVING level; gain shrinks up the pyramid. ----
  var STREAM_N = 12;
  var STREAM_COLORS = [0xcfee5f, 0xffb04a, 0xe8908c];
  var STREAM_GAIN = [1.0, 0.68, 0.42];
  var STREAM_SIZE = [0.22, 0.19, 0.16];
  var flowStreams = gaps.map(function(gap, gi){
    var s = makeFlowPoints(STREAM_N, STREAM_COLORS[gi], STREAM_SIZE[gi]);
    s.curves = [
      buildGapCurve(gap, GAP_LANES_Z[1], gi * 1.7 + 1.0),
      buildGapCurve(gap, GAP_LANES_Z[2], gi * 1.7 + 2.7)
    ];
    return s;
  });

  // ---- 3. Heat loss (tiny, orange, sideways/outward, fast fade). Energy
  //         leaves as heat from respiration/metabolism; arrows never point
  //         back into the pyramid. Every level loses heat: TL1..TL3 as the
  //         source of a transfer, TL2..TL4 as its receiver. ----------------
  var HEAT_POOL = 16, HEAT_LIFE = 2.6;
  var flowHeat = makeFlowPoints(HEAT_POOL, 0xff9b54, 0.11);
  var heatAge = new Float32Array(HEAT_POOL);
  var heatVel = new Float32Array(HEAT_POOL * 3);
  var HEAT_EVENTS = [];
  FLOW_T.TRANSFER.forEach(function(w, ti){
    HEAT_EVENTS.push({ t: w[0] + 0.15, id: ti + 1, n: 2, done: false });  // source layer
    HEAT_EVENTS.push({ t: w[0] + 1.30, id: ti + 2, n: 2, done: false });  // receiving layer
  });
  HEAT_EVENTS.push({ t: 1.4,  id: 1, n: 4, done: false });   // step 2: producers respire (R, about half of GPP), releasing heat
  HEAT_EVENTS.push({ t: 17.6, id: 0, n: 3, done: false });   // step 6: decomposers respire, releasing heat from the soil
  HEAT_EVENTS.push({ t: 19.2, id: 0, n: 2, done: false });
  function resetHeat(){
    for (var i = 0; i < HEAT_POOL; i++) heatAge[i] = -1;
    hideFlowPoints(flowHeat);
  }
  // Events at or before the clock value `Tref` count as already played (never re-emitted late).
  function syncHeatEvents(Tref){ HEAT_EVENTS.forEach(function(e){ e.done = e.t <= Tref; }); }
  function emitHeat(id, n){
    if (id === 0){                                        // decomposers (fungi, bacteria): heat leaves from the soil, outward
      for (var d = 0; d < n; d++){
        var slot0 = -1;
        for (var s0 = 0; s0 < HEAT_POOL; s0++){ if (heatAge[s0] < 0){ slot0 = s0; break; } }
        if (slot0 < 0) return;
        var sp0 = FUNGI_SPOTS[Math.random() < 0.5 ? 0 : 1], a0 = Math.random() * 6.283, r0 = Math.random() * 0.7;
        var hx = sp0.x + Math.cos(a0) * r0, hz = sp0.z + Math.sin(a0) * r0, v0 = 0.3 + Math.random() * 0.2;
        flowHeat.pos[slot0*3] = hx; flowHeat.pos[slot0*3+1] = soilHeight(hx, hz) + 0.3; flowHeat.pos[slot0*3+2] = hz;
        heatVel[slot0*3] = Math.cos(a0) * v0; heatVel[slot0*3+1] = 0.03 + Math.random() * 0.05; heatVel[slot0*3+2] = Math.sin(a0) * v0;
        heatAge[slot0] = 0;
      }
      return;
    }
    var L = layers[id - 1];
    for (var k = 0; k < n; k++){
      var slot = -1;
      for (var s = 0; s < HEAT_POOL; s++){ if (heatAge[s] < 0){ slot = s; break; } }
      if (slot < 0) return;
      var y = L.yBottom + (L.yTop - L.yBottom) * (0.3 + Math.random() * 0.4);
      var hw = halfW(y), hd = halfD(y);
      // random point on one of the two front/side faces of the triangular prism
      var side = Math.random() < 0.5 ? 1 : -1;
      var u = 0.25 + Math.random() * 0.5;
      var px = side * 0.866 * hw * u, pz = hd - 1.5 * hd * u;
      var len = Math.sqrt(px*px + pz*pz) || 1;
      var sp = 0.35 + Math.random() * 0.25;
      flowHeat.pos[slot*3]   = px * 1.03;
      flowHeat.pos[slot*3+1] = y;
      flowHeat.pos[slot*3+2] = pz * 1.03;
      heatVel[slot*3]   = px / len * sp;
      heatVel[slot*3+1] = 0.03 + Math.random() * 0.05;
      heatVel[slot*3+2] = pz / len * sp;
      heatAge[slot] = 0;
    }
  }

  // ---- 4. Detritus / waste / dead matter (muted, slow, dashed/intermittent,
  //         curving DOWN to the decomposers). One path per level, starting
  //         on that level's flank and ending at a fungi cluster. These carry
  //         matter, not reusable energy. -----------------------------------
  function buildDetritusCurve(id){
    var side = (id % 2 === 1) ? -1 : 1;
    var L = layers[id - 1], yc = (L.yBottom + L.yTop) / 2, hw = halfW(yc), hd = halfD(yc);
    var S = new THREE.Vector3(side * 0.866 * hw * 0.6 * 1.03, yc, hd * 0.1);
    var sp = FUNGI_SPOTS[side < 0 ? 0 : 1];
    var E = new THREE.Vector3(sp.x * 0.92, 0, sp.z - 0.3);
    E.y = soilHeight(E.x, E.z) + 0.06;                     // lands on the humus mound
    var drop = S.y - E.y;
    var P1 = new THREE.Vector3(S.x + side * 1.2, S.y - 0.15 * drop, S.z + 1.5);           // leaves the flank outward
    var P2 = new THREE.Vector3(E.x + side * 0.7, E.y + 0.32 * drop + 0.3, E.z + 0.3);     // then falls toward the soil
    return new THREE.CubicBezierCurve3(S, P1, P2, E);
  }
  var DET_ORDER = [4, 3, 2, 1];   // top predator's litter starts first; every level takes part
  var DET_DASHES = 22, DET_PARTS = 8, DET_TRAVEL = 3.2;   // slow, gravity-like fall
  var flowDetritus = DET_ORDER.map(function(id, order){
    return { id: id, curve: buildDetritusCurve(id), start: FLOW_T.DETRITUS_START + order * 0.4 };
  });
  var detDashPos = new Float32Array(DET_ORDER.length * DET_DASHES * 6);
  var detDashCol = new Float32Array(DET_ORDER.length * DET_DASHES * 6);
  flowDetritus.forEach(function(path, j){
    for (var k = 0; k < DET_DASHES; k++){
      var a = path.curve.getPoint(k / DET_DASHES), b = path.curve.getPoint((k + 0.55) / DET_DASHES);
      var o = (j * DET_DASHES + k) * 6;
      detDashPos[o] = a.x; detDashPos[o+1] = a.y; detDashPos[o+2] = a.z;
      detDashPos[o+3] = b.x; detDashPos[o+4] = b.y; detDashPos[o+5] = b.z;
    }
  });
  var detDashGeo = new THREE.BufferGeometry();
  detDashGeo.setAttribute("position", new THREE.BufferAttribute(detDashPos, 3));
  detDashGeo.setAttribute("color", new THREE.BufferAttribute(detDashCol, 3));
  var detDashMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  var detDashes = new THREE.LineSegments(detDashGeo, detDashMat);
  detDashes.frustumCulled = false;
  detDashes.visible = false;
  flowRoot.add(detDashes);
  flowDisposables.push(detDashGeo, detDashMat);
  var DET_COLOR = new THREE.Color(0xc9a876);
  var flowDetParts = makeFlowPoints(DET_ORDER.length * DET_PARTS, 0xc9a876, 0.13); // soft trail glow only

  // Falling dead matter as small tumbling 3D bits, coloured by the level they
  // came from (TL1 leaf litter -> TL4 top-predator waste). They sink into the
  // soil and shrink while turning mint: decomposed into inorganic nutrients.
  var BIT_LEVEL = {
    1: { col: 0x8a9a3a, s: [0.17, 0.05, 0.12] },   // dead phytoplankton cells / marine-snow flakes
    2: { col: 0xb59a45, s: [0.12, 0.09, 0.10] },   // herbivore waste / dead matter
    3: { col: 0xa8683a, s: [0.13, 0.10, 0.11] },   // predator waste / dead matter
    4: { col: 0x8f4a43, s: [0.16, 0.13, 0.14] }    // top-predator waste / dead matter
  };
  var BIT_N = DET_ORDER.length * DET_PARTS;
  var bitGeo = new THREE.IcosahedronGeometry(1, 0);
  var bitMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x120d06 });
  var bitMesh = new THREE.InstancedMesh(bitGeo, bitMat, BIT_N);
  var bitBase = [], bitSpin = [];
  (function(){
    var c = new THREE.Color();
    for (var j = 0; j < DET_ORDER.length; j++){
      for (var q = 0; q < DET_PARTS; q++){
        bitBase.push(new THREE.Color(BIT_LEVEL[DET_ORDER[j]].col).multiplyScalar(0.9 + Math.random() * 0.2));
        bitSpin.push([Math.random() * 6, 1.5 + Math.random() * 2.5, 1 + Math.random() * 2]);
        bitMesh.setColorAt(j * DET_PARTS + q, bitBase[bitBase.length - 1]);
      }
    }
    bitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  })();
  bitMesh.frustumCulled = false;
  bitMesh.visible = false;
  flowRoot.add(bitMesh);
  flowDisposables.push(bitGeo, bitMat);
  var bitM = new THREE.Matrix4(), bitQ = new THREE.Quaternion(), bitE = new THREE.Euler(),
      bitP = new THREE.Vector3(), bitS = new THREE.Vector3(), bitC = new THREE.Color();

  // Small temporary fungi/soil glow where the detritus arrives.
  var decompGlows = [];
  [[FUNGI_SPOTS[0], 2.4, 0.20], [FUNGI_SPOTS[1], 2.4, 0.20], [new THREE.Vector3(0, 0.2, 3.4), 4.6, 0.07]].forEach(function(g){
    var mat = new THREE.SpriteMaterial({
      map: glowTexture, color: 0xd9b878, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var spr = new THREE.Sprite(mat);
    spr.position.set(g[0].x, 0.45, g[0].z);
    spr.scale.set(g[1], g[1], 1);
    spr.visible = false;
    flowRoot.add(spr);
    flowDisposables.push(mat);
    decompGlows.push({ spr: spr, max: g[2] });
  });

  // ---- 5. Nutrient return: soil/decomposers -> TL1 ONLY (inorganic
  //         nutrients taken up by producers). Thin mint curve + a few
  //         particles. Deliberately NOT drawn toward TL2-TL4 and not coloured
  //         like the energy streams: this is matter, not energy. ------------
  var NUT_COLOR = new THREE.Color(0x8fe3c7);
  // Ends INSIDE the narrow TL1 tier (inverted pyramid): sediment -> dissolved nutrients -> phytoplankton.
  var nutCurve = new THREE.CatmullRomCurve3(IS_POND ? [
    new THREE.Vector3(0.0, 0.2, 4.0),          // pond: the original path into the wide producer base
    new THREE.Vector3(0.7, 0.4, 3.5),
    new THREE.Vector3(-0.2, 0.75, 2.8),
    new THREE.Vector3(0.15, 1.15, 1.9)
  ] : [
    new THREE.Vector3(0.0, 0.2, 4.0),
    new THREE.Vector3(0.6, 0.45, 3.2),
    new THREE.Vector3(-0.2, 0.85, 1.8),
    new THREE.Vector3(0.1, 1.25, 0.5)
  ]);
  var NUT_TUBE_SEG = 48, NUT_TUBE_RAD = 5, NUT_PARTS = 8;
  var nutGeo = new THREE.TubeGeometry(nutCurve, NUT_TUBE_SEG, 0.03, NUT_TUBE_RAD, false);
  var nutMat = new THREE.MeshBasicMaterial({
    color: NUT_COLOR, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  var nutTube = new THREE.Mesh(nutGeo, nutMat);
  nutTube.frustumCulled = false;
  nutTube.visible = false;
  flowRoot.add(nutTube);
  flowDisposables.push(nutGeo, nutMat);
  var flowNutParts = makeFlowPoints(NUT_PARTS, 0x8fe3c7, 0.12);   // legacy nutrient line: kept hidden (replaced below)

  // ---- 5b. MINERALISATION (step 7) — its own animation, a pure function of the step clock ----
  // NCERT: humus is further degraded by microbes and inorganic nutrients are released (mineralisation).
  //   A  bacteria at the detritus mounds flare up; brown organic specks turn into small bright
  //      mint IONS — inorganic nutrients released into the water            nT 0.0 - 1.6
  //   B  the ions DIFFUSE up through the water in a loose zig-zag (no pipe, no arrow) and are
  //      taken up by TL1 ONLY, which glows mint as they arrive            nT 0.9 - 4.6
  //   C  stable picture: the absorbed ions rest dimly inside TL1 (ion names: step-7 readout card)
  var MIN_N = 30;
  var minIons = makeFlowPoints(MIN_N, 0xffffff, 0.55);
  var MIN_ORGANIC = new THREE.Color(0x8a6a44), MIN_IONIC = new THREE.Color(0x9ff0d4);
  var minData = [], minTmpA = new THREE.Vector3(), minTmpC = new THREE.Color();
  (function(){
    var L1 = layers[0], sources = [FUNGI_SPOTS[0], FUNGI_SPOTS[1], new THREE.Vector3(0, 0.2, 3.4)];
    for (var i = 0; i < MIN_N; i++){
      var src = sources[i % 3], a = Math.random() * 6.2832, r = Math.sqrt(Math.random()) * (i % 3 === 2 ? 1.1 : 0.8);
      var sx = src.x + Math.cos(a) * r, sz = src.z + Math.sin(a) * r;
      var sy = soilHeight(sx, sz) * 1.45 + 0.07;                       // humus mounds are swollen (x1.45) by step 6
      // target inside TL1: pond = lower part (roots in the mud, algal mats); sea = anywhere in the narrow tier
      var ty = IS_POND ? THREE.MathUtils.lerp(L1.yBottom + 0.25, L1.yBottom + 1.3, Math.random())
                       : THREE.MathUtils.lerp(L1.yBottom + 0.3, L1.yTop - 0.3, Math.random());
      var hw = halfW(ty) * 0.55, hd = halfD(ty) * 0.55, u = Math.random(), v = Math.random();
      if (u + v > 1){ u = 1 - u; v = 1 - v; }
      var tx = 0.866 * hw * u - 0.866 * hw * v, tz = hd * (1 - u - v) - 0.5 * hd * (u + v);
      var dx = tx - sx, dz = tz - sz, dl = Math.sqrt(dx * dx + dz * dz) || 1;
      minData.push({
        s: new THREE.Vector3(sx, sy, sz), e: new THREE.Vector3(tx, ty, tz),
        px: -dz / dl, pz: dx / dl,                                     // sideways direction for the zig-zag
        form: 0.1 + (i % 10) * 0.06,                                   // when this speck turns from organic to ionic
        delay: 0.9 + (i / MIN_N) * 1.1 + Math.random() * 0.2,          // leaves the mound
        dur: 1.9 + Math.random() * 0.5,                                // all arrive by nT = 4.6 (< 5 s step)
        ph: Math.random() * 6.2832, amp: 0.12 + Math.random() * 0.14, tw: Math.random() * 6.2832
      });
    }
  })();
  function minIonPos(d, nT, out){
    var pr = THREE.MathUtils.clamp((nT - d.delay) / d.dur, 0, 1), pe = pr * pr * (3 - 2 * pr), arc = Math.sin(Math.PI * pr);
    out.copy(d.s).lerp(d.e, pe);
    out.y += arc * 0.55 + (pr === 0 ? Math.sin(nT * 4 + d.ph) * 0.02 : 0);       // rises through the water; a slight bob while still in the mound
    var w = Math.sin(pr * Math.PI * 3 + d.ph) * d.amp * arc;                      // diffusion: a loose zig-zag, not a straight pipe
    out.x += d.px * w; out.z += d.pz * w;
    return pr;
  }
  // The ion names (NH4+, NO3-, PO4 3-) are shown in the step-7 readout card, not as 3D labels:
  // floating labels crowded the narrow producer tier and covered the organism pictures.
  var minLabels = [];
  function hideMineralisation(){
    hideFlowPoints(minIons);
    minLabels.forEach(function(l){ l.spr.visible = false; l.spr.material.opacity = 0; });
  }
  // Draws step 7 for clock T; returns how far TL1's uptake glow has built up (0..1).
  function drawMineralisation(T, elapsedTime, live){
    var nT = T - FLOW_T.NUTRIENT_START;
    if (nT <= 0){ if (minIons.pts.visible) hideMineralisation(); return 0; }
    minIons.pts.visible = true;
    for (var i = 0; i < MIN_N; i++){
      var d = minData[i], pr = minIonPos(d, nT, minTmpA);
      var appear = flowStep(0, 0.5, nT - (i % 10) * 0.05);
      var b = appear * (1 - 0.62 * flowStep(0.88, 1, pr)) * (live ? 0.85 + 0.15 * Math.sin(elapsedTime * 5 + d.tw) : 1);
      minTmpC.copy(MIN_ORGANIC).lerp(MIN_IONIC, flowStep(d.form, d.form + 0.8, nT)).multiplyScalar(b);
      minIons.pos[i*3] = minTmpA.x; minIons.pos[i*3+1] = minTmpA.y; minIons.pos[i*3+2] = minTmpA.z;
      minIons.col[i*3] = minTmpC.r; minIons.col[i*3+1] = minTmpC.g; minIons.col[i*3+2] = minTmpC.b;
    }
    flushFlowPoints(minIons);
    var labelEnv = flowStep(1.1, 1.8, nT);
    minLabels.forEach(function(l){
      var ld = minData[l.ion];
      minIonPos(ld, Math.min(nT, ld.delay + 0.7 * ld.dur), minTmpA);   // rides its ion, then stays in the water just outside TL1 (keeps the producer tier uncluttered)
      l.spr.position.set(minTmpA.x, minTmpA.y + 0.55, minTmpA.z);
      l.spr.material.opacity = 0.95 * labelEnv;
      l.spr.visible = labelEnv > 0.01;
    });
    return flowStep(2.8, 4.3, nT);
  }

  // ---- step controller (single source of truth: ecosystemStep) ----------
  // ecosystemStep : 0 = resting ecosystem, 1..7 = the step shown in the indicator
  // flow.mode     : IDLE | PLAYING (the step's slow animation is running) | STABLE (holding the finished picture)
  // Persistent visuals (tints, dashed paths, decomposer growth, nutrient line) are a pure
  // function of the step clock T, so a stable step is always drawn the same way. Transient
  // effects (streams, heat, falling bits, nutrient particles) exist only while a step plays.
  var ecosystemStep = 0;

  function hideFlowOverlay(id){
    var ov = flowOverlays[id];
    if (!ov) return;
    ov.mesh.visible = false;
    ov.mat.uniforms.uBand.value = 0;
    ov.mat.uniforms.uAmb.value = 0;
  }
  // Hides/clears every short-lived effect. Pooled objects are only hidden, never re-created.
  function clearTransientStepEffects(){
    resetHeat();
    flowStreams.forEach(hideFlowPoints);
    hideFlowPoints(flowDetParts);
    hideFlowPoints(flowNutParts);
    bitMesh.visible = false;
  }
  // Everything back to the resting ecosystem (Reset, replay, page teardown).
  function hideFlowTemporaries(){
    clearTransientStepEffects();
    detDashes.visible = false;
    setDecomposerGrowth(0, 0);             // soil, fungi and crumbs return to their resting look
    nutTube.visible = false;
    nutTube.geometry.setDrawRange(0, 0);
    nutMat.opacity = 0;
    hideMineralisation();
    decompGlows.forEach(function(g){ g.spr.visible = false; g.spr.material.opacity = 0; });
    flowRoot.visible = false;
  }

  // ---- the two minimal navigation buttons + status text (markup lives in the page) ----
  var flowNavEls = { root: null, prev: null, next: null, status: null };
  var STEP_LEVEL = { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 7: 1 }, stepSyncedTo = 0;
  function updateStepNavigationUI(){
    if (!flowNavEls.root) return;
    var active = flow.phase !== "IDLE", step = active ? ecosystemStep : 0;
    if (active){ flowNavEls.status.innerHTML = '<span class="fn-count">' + step + " / " + FLOW_TOTAL + '</span><span class="fn-sep" aria-hidden="true">\u00b7</span><span class="fn-label">' + FLOW_STEP_LABELS[step] + "</span>"; }
    else { flowNavEls.status.textContent = "0 / " + FLOW_TOTAL; }
    flowNavEls.status.classList.toggle("on", active);
    // Step -> trophic level: 2 Producers=TL1, 3 TL1->TL2 = TL2, 4 = TL3, 5 = TL4, 7 Mineralisation = TL1; 1 (PAR) and 6 (Decomposers) keep the current level.
    if (active && step !== stepSyncedTo){
      stepSyncedTo = step;
      var stepLevel = STEP_LEVEL[step];
      if (stepLevel && stepLevel !== selectedId) selectLayer(stepLevel);       // pyramid highlight + graph focus follow together
    } else if (!active){ stepSyncedTo = 0; }
    flowNavEls.prev.disabled = !(active && step > 1);
    flowNavEls.next.disabled = !(active &&
                                 !(flow.mode === "PLAYING" && step === 1) &&      // let the PAR arrive first
                                 !(flow.mode === "STABLE" && step >= FLOW_TOTAL));  // last step: nothing further
  }
  function initFlowNav(){
    flowNavEls.root = document.getElementById("flowNav");
    flowNavEls.prev = document.getElementById("flowPrevBtn");
    flowNavEls.next = document.getElementById("flowNextBtn");
    flowNavEls.status = document.getElementById("flowNavStatus");
    if (!flowNavEls.root) return;
    function wire(btn, fn){
      btn.addEventListener("click", function(e){
        e.preventDefault(); e.stopPropagation();
        btn.classList.remove("flash"); void btn.offsetWidth; btn.classList.add("flash");   // CSS-only mint flash, no timers
        fn();
      });
      // Keep every gesture that starts on a button away from the 3D scene's orbit/zoom handlers.
      ["pointerdown", "pointermove", "touchstart", "touchmove", "mousedown", "wheel"].forEach(function(type){
        btn.addEventListener(type, function(e){ e.stopPropagation(); }, { passive: true });
      });
    }
    wire(flowNavEls.prev, function(){ goToPreviousStep(); });
    wire(flowNavEls.next, function(){ goToNextStep(); });
    flowNavEls.root.addEventListener("touchmove", function(e){ e.stopPropagation(); }, { passive: true });
    updateStepNavigationUI();
  }

  // Draws the persistent part of a stable step (no time is replayed): step 0 = resting ecosystem.
  function renderEcosystemStep(step){
    clearTransientStepEffects();
    if (step <= 0){ for (var id = 1; id <= 4; id++) hideFlowOverlay(id); hideFlowTemporaries(); flow.grown = false; flow.T = 0; return; }
    flow.T = FLOW_B[step];
    syncHeatEvents(flow.T);                 // events up to this step count as played; later ones stay pending
    applyPersistentVisuals(flow.T, elapsed, false);
  }

  function startEcosystemFlow(runRef){
    cancelEcosystemFlow();                 // defensive: never two concurrent runs
    flow.runId = runRef.id;
    flow.phase = "ACTIVE";
    ecosystemStep = 1; flow.mode = "PLAYING"; flow.T = 0;
    resetHeat(); syncHeatEvents(0);
    flowRoot.visible = true;
    updateStepNavigationUI();
    if (DEV_MODE) console.log("Ecosystem flow start (run " + flow.runId + ") — step 1 / " + FLOW_TOTAL);
  }

  // Hard stop: Reset, replay, or the safety check in the update loop. No timers involved.
  function cancelEcosystemFlow(){
    flow.phase = "IDLE"; flow.runId = 0; flow.mode = "IDLE"; flow.T = 0; flow.grown = false;
    ecosystemStep = 0;
    for (var id = 1; id <= 4; id++) hideFlowOverlay(id);
    hideFlowTemporaries();
    updateStepNavigationUI();
    if (typeof updateProductivityReadout === "function") updateProductivityReadout();
  }
  function ecosystemFlowIsDone(){ return flow.phase !== "IDLE" && ecosystemStep === FLOW_TOTAL && flow.mode === "STABLE"; }

  function settleFlowStep(){              // the step's animation finished: hold this stable picture
    flow.mode = "STABLE"; flow.T = FLOW_B[ecosystemStep];
    updateStepNavigationUI();
    if (DEV_MODE) console.log("Ecosystem flow: step " + ecosystemStep + " / " + FLOW_TOTAL + " stable (" + FLOW_STEP_LABELS[ecosystemStep] + ")");
  }
  function goToNextStep(){
    if (flow.phase === "IDLE") return;
    if (flow.mode === "PLAYING"){
      if (ecosystemStep === 1) return;                      // PAR still travelling: let it arrive
      renderEcosystemStep(ecosystemStep);                   // impatient learner: jump to this step's finished picture
      settleFlowStep();
      return;
    }
    if (ecosystemStep >= FLOW_TOTAL) return;
    ecosystemStep++; flow.mode = "PLAYING";
    clearTransientStepEffects();
    syncHeatEvents(FLOW_B[ecosystemStep - 1]);              // this step's heat events are still to come
    updateStepNavigationUI();
    if (DEV_MODE) console.log("Ecosystem flow: playing step " + ecosystemStep + " (" + FLOW_STEP_LABELS[ecosystemStep] + ")");
  }
  // Back = restore the nearest previous COMPLETED step. Nothing is played in reverse:
  // transient effects are cleared and the earlier stable picture is simply drawn.
  function goToPreviousStep(){
    if (flow.phase === "IDLE") return;
    var dest = ecosystemStep - 1;
    if (dest < 1) return;
    ecosystemStep = dest;
    renderEcosystemStep(dest);
    settleFlowStep();
  }

  function ageHeatParticles(delta){
    var heatLive = false;
    for (var h = 0; h < HEAT_POOL; h++){
      if (heatAge[h] < 0){ flowHeat.col[h*3] = flowHeat.col[h*3+1] = flowHeat.col[h*3+2] = 0; continue; }
      heatAge[h] += delta;
      if (heatAge[h] >= HEAT_LIFE){ heatAge[h] = -1; flowHeat.col[h*3] = flowHeat.col[h*3+1] = flowHeat.col[h*3+2] = 0; continue; }
      heatLive = true;
      flowHeat.pos[h*3]   += heatVel[h*3]   * delta;
      flowHeat.pos[h*3+1] += heatVel[h*3+1] * delta;
      flowHeat.pos[h*3+2] += heatVel[h*3+2] * delta;
      var hb = Math.pow(1 - heatAge[h] / HEAT_LIFE, 1.4) * 0.8;
      flowHeat.col[h*3] = flowHeat.base.r * hb; flowHeat.col[h*3+1] = flowHeat.base.g * hb; flowHeat.col[h*3+2] = flowHeat.base.b * hb;
    }
    flowHeat.pts.visible = heatLive;
    if (heatLive) flushFlowPoints(flowHeat);
  }

  // Persistent visuals as a pure function of the step clock T.
  function applyPersistentVisuals(T, elapsedTime, live){
    var tint = 1 - 0.55 * flowStep(FLOW_B[5], FLOW_B[5] + 2.0, T);   // matter steps (6-7): dim the energy tints a little

    // receiver tints: TL1 strongest, weaker at each level up (energy declines)
    for (var id = 1; id <= 4; id++){
      var st = FLOW_LEVEL[id], ov = flowOverlays[id];
      if (!ov) continue;
      var w = st.win, rise = flowStep(w[0], w[0] + 0.6, T);
      var bandEnv = live ? rise * (1 - flowStep(w[1], w[1] + 0.8, T)) : 0;     // moving highlight only while the step plays
      var ambEnv = rise * tint;
      var u = ov.mat.uniforms;
      u.uBandPos.value = -0.3 + (T - w[0]) * 1.05;
      u.uBand.value = st.band * bandEnv;
      u.uAmb.value = st.amb * ambEnv;
      ov.mesh.visible = (u.uBand.value > 0.002 || u.uAmb.value > 0.002);
      // small emissive lift on top of whatever the layer loop already set this frame
      ov.layerMesh.material.emissiveIntensity += st.glow * Math.max(bandEnv, ambEnv);
    }

    // detritus paths (earthy, dashed, curving DOWN from every level to the decomposers)
    var dashGain = 0.45 * (1 - 0.5 * flowStep(FLOW_B[6], FLOW_B[6] + 1.5, T));
    if (T >= FLOW_T.DETRITUS_START){
      detDashes.visible = true;
      for (var j = 0; j < flowDetritus.length; j++){
        var pr = THREE.MathUtils.clamp((T - flowDetritus[j].start) / 2.0, 0, 1);
        for (var k = 0; k < DET_DASHES; k++){
          var rev = THREE.MathUtils.clamp(pr * DET_DASHES - k, 0, 1) * dashGain, o = (j * DET_DASHES + k) * 6;
          detDashCol[o]   = detDashCol[o+3] = DET_COLOR.r * rev;
          detDashCol[o+1] = detDashCol[o+4] = DET_COLOR.g * rev;
          detDashCol[o+2] = detDashCol[o+5] = DET_COLOR.b * rev;
        }
      }
      detDashGeo.attributes.color.needsUpdate = true;
    } else if (detDashes.visible){ detDashes.visible = false; }

    // decomposer habitat: soil thickens, fungi swell, mycelium spreads, crumbs grow
    var growth = flowStep(16.5, 20.5, T);
    if (growth > 0.001 || flow.grown){ setDecomposerGrowth(growth, elapsedTime); flow.grown = growth > 0.001; }
    var glowEnv = flowStep(17.0, 20.0, T);
    for (var g = 0; g < decompGlows.length; g++){
      var dg = decompGlows[g];
      dg.spr.visible = glowEnv > 0.002;
      var minFlare = flowStep(0, 0.5, T - FLOW_T.NUTRIENT_START) * (1 - flowStep(1.6, 2.4, T - FLOW_T.NUTRIENT_START));   // bacteria flare up at the start of step 7
      dg.spr.material.opacity = dg.max * glowEnv * (1 + 1.4 * minFlare) * (live ? 1 + 0.08 * Math.sin(elapsedTime * 2 + g) : 1);   // stable pictures are exactly repeatable
    }

    // mineralisation (step 7): humus -> inorganic ions -> taken up by TL1 ONLY (matter cycling, not energy)
    var uptake = drawMineralisation(T, elapsedTime, live);
    if (uptake > 0.001 && flowOverlays[1]){                              // producers glow mint as they take the ions up
      var uo = flowOverlays[1], uu = uo.mat.uniforms;
      uu.uAmb.value = Math.max(uu.uAmb.value, 0.2 * uptake * (1 - 0.45 * flowStep(4.3, 5.0, T - FLOW_T.NUTRIENT_START)));
      uo.mesh.visible = true;
      uo.layerMesh.material.emissiveIntensity += 0.06 * uptake;
    }
  }

  // Transient effects: exist only while the current step is playing.
  function applyTransientVisuals(T, delta){
    // energy streams (bright, upward, green -> yellow -> orange -> coral, weaker each level)
    for (var gi = 0; gi < flowStreams.length; gi++){
      var s = flowStreams[gi], win = FLOW_T.TRANSFER[gi], D = win[1] - win[0], tt = T - win[0];
      if (!(tt > -0.02 && tt < D + 0.02)){ if (s.pts.visible) hideFlowPoints(s); continue; }
      s.pts.visible = true;
      for (var i = 0; i < s.n; i++){
        var off = ((i * 0.618034) % 1) * 0.45 * D, p = (tt - off) / (0.5 * D);
        if (p <= 0 || p >= 1){ setFlowPoint(s, i, s.pos[i*3], s.pos[i*3+1], s.pos[i*3+2], 0); continue; }
        s.curves[i % 2].getPoint(p, flowTmp);
        setFlowPoint(s, i, flowTmp.x, flowTmp.y, flowTmp.z, Math.pow(Math.sin(Math.PI * p), 0.7) * STREAM_GAIN[gi]);
      }
      flushFlowPoints(s);
    }
    // heat loss: tiny warm particles drift sideways/outward and fade; never toward the pyramid
    for (var e = 0; e < HEAT_EVENTS.length; e++){
      var ev = HEAT_EVENTS[e];
      if (!ev.done && T >= ev.t){ ev.done = true; emitHeat(ev.id, ev.n); }
    }
    // dead matter: earthy bits fall from every level, sink into the soil and turn mint (decomposed)
    if (T >= FLOW_T.DETRITUS_START){
      flowDetParts.pts.visible = true;
      for (var j = 0; j < flowDetritus.length; j++){
        var path = flowDetritus[j];
        for (var q = 0; q < DET_PARTS; q++){
          var idx = j * DET_PARTS + q, pp = (T - (path.start + q * 0.18)) / DET_TRAVEL;
          if (pp <= 0 || pp >= 1){
            setFlowPoint(flowDetParts, idx, flowDetParts.pos[idx*3], flowDetParts.pos[idx*3+1], flowDetParts.pos[idx*3+2], 0);
            bitM.makeScale(0, 0, 0); bitMesh.setMatrixAt(idx, bitM);
            continue;
          }
          path.curve.getPoint(pp * pp * (3 - 2 * pp), flowTmp);            // slow start, settles into the soil
          var blink = 0.5 + 0.5 * Math.sin(6.2832 * (pp * 3 + q * 0.31));  // intermittent, not a solid beam
          setFlowPoint(flowDetParts, idx, flowTmp.x, flowTmp.y, flowTmp.z, (0.25 + 0.6 * blink) * flowStep(0, 0.12, pp) * (1 - flowStep(0.85, 1, pp)) * 0.4);
          var sink = flowStep(0.85, 1, pp), ls = BIT_LEVEL[path.id].s, sp2 = bitSpin[idx];
          bitP.set(flowTmp.x, flowTmp.y - sink * 0.10, flowTmp.z);
          bitQ.setFromEuler(bitE.set(sp2[0] + T * sp2[1] * 0.5, sp2[0] * 0.7 + T * sp2[2] * 0.5, sp2[0] * 1.3));
          var shrink = (1 - sink) * flowStep(0, 0.08, pp);
          bitS.set(ls[0] * shrink, ls[1] * shrink, ls[2] * shrink);
          bitMesh.setMatrixAt(idx, bitM.compose(bitP, bitQ, bitS));
          bitC.copy(bitBase[idx]).lerp(NUT_COLOR, sink * 0.85);
          bitMesh.setColorAt(idx, bitC);
        }
      }
      flushFlowPoints(flowDetParts);
      bitMesh.visible = true; bitMesh.instanceMatrix.needsUpdate = true; bitMesh.instanceColor.needsUpdate = true;
    }
    // (step 7 mineralisation is drawn by drawMineralisation() in the persistent pass)
  }

  // Called once per frame from the existing animation loop.
  function updateEcosystemFlow(elapsedTime, delta){
    if (flow.phase === "IDLE") return;
    // Safety: if the run this belongs to is gone (Reset) or replaced, stop.
    if (!run || run.id !== flow.runId){ cancelEcosystemFlow(); return; }
    if (flow.mode === "PLAYING"){
      if (ecosystemStep === 1){ if (simState === SIM_STATE.PRODUCER_ENERGISED) settleFlowStep(); }   // Sun/PAR run finished
      else { flow.T = Math.min(FLOW_B[ecosystemStep], flow.T + delta); if (flow.T >= FLOW_B[ecosystemStep]) settleFlowStep(); }
    }
    var live = (flow.mode === "PLAYING");
    updateProductivityReadout();
    applyPersistentVisuals(flow.T, elapsedTime, live);
    if (live) applyTransientVisuals(flow.T, delta);
    ageHeatParticles(delta);                                 // leftover heat finishes fading on its own
  }

  // ---- Step 2 readout: GPP -> R -> NPP (illustrative teaching values in rel. J, matching TL1 = 100).
  //      GPP = all energy producers fix in photosynthesis; R = their own respiration, lost as heat
  //      (commonly about half of GPP); NPP = GPP - R, the biomass left for herbivores and decomposers.
  //      Each part appears with the step clock: GPP as PAR is captured, R with the heat puff at T = 1.4,
  //      NPP once the step settles. Shown only while step 2 is on screen; Back/Next simply redraw it.
  //      Step 3 (TL1 -> TL2) follows on: NPP 50 -> TL2 receives 10 as the stream arrives (T = 4.3, when
  //      TL2 lights up), then the uneaten 40 is named as litter for the decomposers near the end of the step.
  var PROD_STAGE_T = { 2: [0.2, 1.3, 2.1], 3: [3.0, 4.3, 5.8], 7: [21.2, 22.3, 24.4] };   // step 7 follows the mineralisation animation   // step-clock times at which stages 1, 2, 3 appear
  var prodReadoutEl = document.getElementById("prodReadout");
  var prodSets = prodReadoutEl ? Array.prototype.slice.call(prodReadoutEl.querySelectorAll(".prod-set")) : [];
  var prodShownKey = "";
  // Collapse / expand the step card (steps 2, 3 and 7). The choice is kept for the rest of the visit
  // (and across a Pond / Open sea switch), so a collapsed card stays out of the way at every step.
  function setProdCollapsed(on){
    var btn = document.getElementById("prodToggle");
    if (!prodReadoutEl || !btn) return;
    prodReadoutEl.classList.toggle("collapsed", !!on);
    btn.setAttribute("aria-expanded", on ? "false" : "true");
    btn.setAttribute("aria-label", on ? "Show explanation" : "Hide explanation");
    btn.title = on ? "Show explanation" : "Hide explanation";
  }
  (function(){
    var btn = document.getElementById("prodToggle");
    if (btn) btn.addEventListener("click", function(){ setProdCollapsed(!prodReadoutEl.classList.contains("collapsed")); });
  })();
  (function(){                                                  // habitat-specific mineralisation wording
    var chip = document.getElementById("minSourceChip"), n1 = document.getElementById("minNote1"), n3 = document.getElementById("minNote3");
    if (chip) chip.textContent = IS_POND ? "Humus" : "Detritus";
    if (n1) n1.textContent = IS_POND ? "Mineralisation: microbes (bacteria) in the pond mud break humus down further\u2026"
                                     : "Mineralisation: bacteria break dead organic matter (detritus) down further \u2014 in the water and on the sea floor\u2026";
    if (n3) n3.textContent = IS_POND ? "Producers take them up \u2014 rooted plants through their roots, algae straight from the water. Matter cycles; energy does not."
                                     : "Phytoplankton take them up from the water; currents and upwelling carry them back to the sunlit layer. Matter cycles; energy does not.";
  })();
  function updateProductivityReadout(){
    if (!prodReadoutEl) return;
    var step = (flow.phase !== "IDLE") ? ecosystemStep : 0, times = PROD_STAGE_T[step], stage = 0;
    if (times){
      stage = 1;
      if (flow.T >= times[1]) stage = 2;
      if (flow.T >= times[2]) stage = 3;
    }
    var key = stage ? step + ":" + stage : "";
    if (key === prodShownKey) return;                       // only touch the DOM when something changes
    prodShownKey = key;
    prodReadoutEl.hidden = stage === 0;
    prodSets.forEach(function(set){
      var on = +set.getAttribute("data-step") === step;
      set.hidden = !on;
      if (!on) return;
      Array.prototype.forEach.call(set.querySelectorAll("[data-stage]"), function(el){
        el.classList.toggle("pending", +el.getAttribute("data-stage") > stage);
      });
    });
  }

  function disposeEcosystemFlow(){
    cancelEcosystemFlow();
    flowDisposables.concat(habitatDisposables).forEach(function(o){ if (o && o.dispose) o.dispose(); });
  }
  window.addEventListener("pagehide", disposeEcosystemFlow);
  if (DEV_MODE) window.__ecosystemFlowDebug = function(){ return { phase: flow.phase, step: ecosystemStep, mode: flow.mode, T: flow.T, runId: flow.runId }; };
  initFlowNav();

  // ---- first-run intro card (shown once per page load) + reopenable legend popover ----
  // Deliberately no localStorage here: some Android in-app browsers intercept any storage
  // write on a content:// page and pop a "save this file" dialog. In-memory only, so the
  // card reappears on a fresh open/reload of the file, which is a fine trade-off.
  var introOverlayEl = null, dismissIntroCard = function(){};
  (function initIntro(){
    var overlay = document.getElementById("introOverlay");
    introOverlayEl = overlay;
    var dismissBtn = document.getElementById("introDismissBtn");
    var legendBtn = document.getElementById("legendToggleBtn");
    var legendPop = document.getElementById("legendPopover");
    if (!overlay) return;
    var introAutoCloseTimer = null;
    function closeIntro(){
      if (overlay.hidden) return;
      clearTimeout(introAutoCloseTimer);
      introAutoCloseTimer = null;
      overlay.classList.add("closing");
      window.setTimeout(function(){ overlay.hidden = true; }, 260);   // matches the CSS fade-out duration
    }
    dismissIntroCard = closeIntro;
    if (!ECO_SWITCHED){                     // not shown again after a Pond / Open sea switch
      overlay.hidden = false;
      try { dismissBtn.focus({ preventScroll: true }); } catch (e) {}
      clearTimeout(introAutoCloseTimer);
      introAutoCloseTimer = window.setTimeout(function(){ closeIntro(); }, 9000);   // auto-dismiss if left untouched
    }
    dismissBtn.addEventListener("click", closeIntro);
    overlay.addEventListener("click", function(e){ if (e.target === overlay) closeIntro(); });   // tap outside the card
    if (legendBtn && legendPop){
      legendBtn.addEventListener("click", function(e){
        e.stopPropagation();
        var open = legendPop.hidden;
        legendPop.hidden = !open;
        legendBtn.classList.toggle("active", open);
        legendBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });
      // Capture phase: fires before a button's own click handler can stopPropagation() on the bubble phase.
      document.addEventListener("click", function(e){
        if (!legendPop.hidden && !legendPop.contains(e.target) && e.target !== legendBtn){
          legendPop.hidden = true; legendBtn.classList.remove("active"); legendBtn.setAttribute("aria-expanded", "false");
        }
      }, true);
    }
  })();

  // ---- mobile "?" controls popover: same open/close/outside-click pattern as the legend ----
  (function initHintToggle(){
    var btn = document.getElementById("hintToggleBtn"), pop = document.getElementById("hintPopover");
    if (!btn || !pop) return;
    function setOpen(open){
      pop.classList.toggle("open", open);
      btn.classList.toggle("active", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    btn.addEventListener("click", function(e){ e.stopPropagation(); setOpen(!pop.classList.contains("open")); });
    document.addEventListener("click", function(e){                 // capture phase: fires before a target's own stopPropagation()
      if (pop.classList.contains("open") && !pop.contains(e.target) && e.target !== btn) setOpen(false);
    }, true);
  })();

  // ---- Escape closes whichever panel/popover is currently open, topmost first ----
  document.addEventListener("keydown", function(e){
    if (e.key !== "Escape") return;
    if (organismUrlBoxOpen()){ closeOrganismUrlBox(); return; }
    var mediaBar = document.getElementById("mediaUrlBar");
    if (mediaBar && !mediaBar.hidden){ closeMediaUrlBar(); return; }
    if (organismEditorOpen){ setOrganismEditorOpen(false); return; }
    if (profileUI.state !== PROFILE_STATE.CLOSED){ closeProfile(); return; }
    var legendPop = document.getElementById("legendPopover"), legendBtn = document.getElementById("legendToggleBtn");
    if (legendPop && !legendPop.hidden){ legendPop.hidden = true; if (legendBtn) legendBtn.classList.remove("active"); return; }
    var hintPop = document.getElementById("hintPopover"), hintBtn = document.getElementById("hintToggleBtn");
    if (hintPop && hintPop.classList.contains("open")){ hintPop.classList.remove("open"); if (hintBtn) hintBtn.classList.remove("active"); return; }
    if (introOverlayEl && !introOverlayEl.hidden){ dismissIntroCard(); return; }
  });

  // ---- Tab focus-trap for whichever modal-style panel is open (organism editor takes priority: higher z-index) ----
  document.addEventListener("keydown", function(e){
    if (e.key !== "Tab") return;
    if (introOverlayEl && !introOverlayEl.hidden){ a11yTrapTab(introOverlayEl, e); return; }
    if (organismEditorOpen){ a11yTrapTab(document.getElementById("organismEditorPanel"), e); return; }
    if (profileUI.state !== PROFILE_STATE.CLOSED){ a11yTrapTab(profileEl, e); return; }
  });

  // ---- Keyboard controls for the 3D view: arrow keys rotate, +/- zoom. Disabled while typing in a
  // field or while a modal panel holds focus, so it never fights the organism editor or URL inputs. ----
  document.addEventListener("keydown", function(e){
    var el = document.activeElement, tag = el && el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (el && el.isContentEditable)) return;
    if (organismEditorOpen || profileUI.state !== PROFILE_STATE.CLOSED) return;
    if (introOverlayEl && !introOverlayEl.hidden) return;
    var ROT_STEP = 0.12, TILT_STEP = 0.07, ZOOM_STEP = 2.4;
    switch (e.key){
      case "ArrowLeft":  controls.targetTheta -= ROT_STEP; break;
      case "ArrowRight": controls.targetTheta += ROT_STEP; break;
      case "ArrowUp":    controls.targetPhi -= TILT_STEP; controls.clampPhi(); break;
      case "ArrowDown":  controls.targetPhi += TILT_STEP; controls.clampPhi(); break;
      case "+": case "=": controls.targetRadius -= ZOOM_STEP; controls.clampRadius(); break;
      case "-": case "_": controls.targetRadius += ZOOM_STEP; controls.clampRadius(); break;
      default: return;
    }
    e.preventDefault();
  });

  // Pre-compile the new shaders/materials once so the first Sun tap doesn't hitch.
  try { renderer.compile(scene, camera); } catch (err) { /* non-fatal */ }

  // =========================================================
  // Interaction — click/tap to select a layer, drag to orbit
  // =========================================================
  var raycaster = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var selectedId = null;

  var selBiomassEl = document.getElementById("selBiomass");
  var mortalityButtonEl = document.getElementById("simulateMortalityBtn");

  function formatEnergy(v){
    return (v >= 1 ? v.toString() : v.toFixed(1)) + " energy units";
  }

  function formatBiomass(v){
    return (Math.round(v*10)/10).toString();
  }

  function updateBiomassUI(id){
    var def = TROPHIC_DATA.filter(function(d){ return d.id === id; })[0];
    if (selBiomassEl) selBiomassEl.textContent = def ?
      ("Living biomass: " + formatBiomass(def.livingBiomass) + "% of start") : "Living biomass: —";
    updateEcoGraph();
  }

  // =========================================================
  // ECOLOGICAL DYNAMICS GRAPH — compact, single-variable
  //
  // ONE small SVG spanning TL1..TL4. Only the currently-selected
  // variable (energy / heat / biomass) is plotted — switched via
  // the three tab buttons below the graph — never all three at
  // once, and never three separate graphs. Kept short on purpose:
  // it's meant to read as a small analytical readout beside the
  // pyramid, not a second visualization competing with it.
  //
  // Every value comes from the simulation's own state:
  //   - ENERGY: TROPHIC_DATA[i].energy — the fixed 100/10/1/0.1
  //     ecological-efficiency curve already driving the pyramid and
  //     the energy-level meter. Shown on a log scale (this data is
  //     already an exact power-of-ten decline) so the "generally
  //     declines" story reads as one smooth trend, not a cliff
  //     followed by three flat points.
  //   - BIOMASS: TROPHIC_DATA[i].livingBiomass — the same 0-100%
  //     value the (now-removed) biomass line used to show; it drops
  //     as mortality events remove organisms.
  //   - HEAT: the level's own respiration (R) only — see
  //     RESPIRATION_SHARE at ecoGraphHeatValues(). The rest of the
  //     energy not passed up becomes detritus for the decomposers,
  //     not heat at that level.
  //
  // updateEcoGraph() redraws the active trace/markers and moves the
  // selection guide; it is called from updateBiomassUI() above,
  // which already runs on every selection change, mortality event,
  // and imported-state change — so this graph and the rest of the
  // UI never drift out of sync. It animates only in response to a
  // change (selection, metric or data) and stops its frame loop when settled.
  // =========================================================
  var ECO_GRAPH_X0 = 10, ECO_GRAPH_X1 = 296;
  var ECO_GRAPH_LANE = { yTop: 19, yBase: 46 };
  function ecoFmtValue(v){ return v <= 0 ? "0" : v >= 10 ? String(Math.round(v)) : v >= 1 ? String(+v.toFixed(1)) : String(+v.toFixed(2)); }
  var ECO_GRAPH_VARS = {
    energy: {
      label: "ENERGY", color: "#c6ea5a",
      // Graph shows energy AVAILABLE at each level: the reference value (d.energy, untouched) scaled by the share of
      // that level still alive, so "Simulate mortality" lowers it. The axis stays fixed to the reference range.
      values: function(){ return TROPHIC_DATA.map(function(d){ return d.energy * d.livingBiomass / 100; }); },
      ref: function(){ return TROPHIC_DATA.map(function(d){ return d.energy; }); },
      unit: "rel. J",           // shown small beside the number; edit here (values are relative units)
      log: true,
      format: ecoFmtValue
    },
    heat: {
      label: "HEAT", color: "#ff9b54",
      // Heat lost at a level = its reference heat scaled by the share of that level still alive (dead organisms
      // no longer respire). Fixed reference axis, like ENERGY.
      values: function(){ return ecoGraphHeatValues().map(function(h, i){ return h * TROPHIC_DATA[i].livingBiomass / 100; }); },
      ref: function(){ return ecoGraphHeatValues(); },
      unit: "rel. J",
      log: true,
      format: ecoFmtValue
    },
    biomass: {
      // Standing crop (biomass) per level in relative units (TL1 = 100): the level's reference value (biomassRef, set in
      // TROPHIC_DATA) scaled by how much of that level is still alive (livingBiomass, %). It is NOT derived from
      // ENERGY, and it is not a fixed 10 % rule: edit biomassRef to use measured values.
      label: "BIOMASS", color: "#4ade80",
      illustrative: BIOMASS_ILLUSTRATIVE[ECO_MODE],   // drawn as hollow points, value tagged "illustrative"
      values: function(){ return TROPHIC_DATA.map(function(d){ return d.biomassRef * d.livingBiomass / 100; }); },
      ref: function(){ return TROPHIC_DATA.map(function(d){ return d.biomassRef; }); },
      unit: "g/m\u00b2",       // dry weight; TL1/TL2 after Odum (English Channel), TL3/TL4 illustrative
      log: false, sqrt: true,   // display scale only (like ENERGY's log scale): keeps the small upper-level values distinguishable
      format: function(v){ return v >= 10 ? Math.round(v).toString() : v.toFixed(1); }
    }
  };
  var ecoActiveVar = "energy";
  var ecoGraphEls = null;
  (function initEcoGraphEls(){
    var svg = document.getElementById("ecoGraphSvg");
    if (!svg) return; // graph markup not present — updateEcoGraph() becomes a no-op below
    ecoGraphEls = {
      varLabel: document.getElementById("ecoVarLabel"),
      valueLabel: document.getElementById("ecoValueLabel"),
      underline: document.getElementById("ecoVarUnderline"),
      guide: document.getElementById("ecoGuideLine"),
      path: document.getElementById("ecoTrace"),
      markers: Array.prototype.slice.call(document.querySelectorAll("#ecoMarkers .eco-marker")),
      buttons: Array.prototype.slice.call(document.querySelectorAll(".eco-var-btn"))
    };
    ecoGraphEls.buttons.forEach(function(btn){
      btn.addEventListener("click", function(){ setEcoActiveVar(btn.getAttribute("data-var")); });
    });
  })();

  function setEcoActiveVar(key){
    if (!ECO_GRAPH_VARS[key]) return;
    ecoActiveVar = key;
    if (ecoGraphEls){
      ecoGraphEls.buttons.forEach(function(btn){
        var isActive = btn.getAttribute("data-var") === key;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }
    updateEcoGraph();
  }

  function ecoGraphXAt(i){ // i = 0..3, one per trophic level TL1..TL4
    return ECO_GRAPH_X0 + (ECO_GRAPH_X1 - ECO_GRAPH_X0) * (i / 3);
  }

  // Heat lost AT each level = only the energy that level burns in its OWN RESPIRATION (R).
  // The energy a level does not pass on is NOT all heat: it splits three ways —
  //   passed to the next level  +  respiration heat (R)  +  detritus (dead bodies, litter, faeces)
  // and the detritus goes to the decomposers, whose respiration releases that energy as heat in the soil.
  // Illustrative teaching shares of the energy entering each level:
  //   TL1  R = 50 % of GPP (so NPP = 50, matching the step-2 readout); of NPP, 10 is eaten by TL2, 40 -> detritus
  //   TL2-TL4  R = 60 % of what they take in; ~10 % passes up; the rest (~30 %, ~40 % at TL4) -> detritus
  // With TL1 = 100: heat 50 · 6 · 0.6 · 0.06 rel. J (was 90 · 9 · 0.9 · 0.1 when ALL non-transferred energy counted as heat).
  var RESPIRATION_SHARE = [0.5, 0.6, 0.6, 0.6];
  function ecoGraphHeatValues(){
    return TROPHIC_DATA.map(function(def, i){ return def.energy * RESPIRATION_SHARE[i]; });
  }

  // Normalizes a 4-value series to 0..1 against a FIXED reference range (the level values at full life), never
  // against another variable's scale. With no mortality this equals the series' own range, so the curve is
  // unchanged; as a level loses organisms its point sinks instead of the whole axis silently rescaling.
  function ecoGraphNormalize(values, useLog, ref){
    var f = useLog ? function(v){ return Math.log10(Math.max(v, 1e-6)); } : function(v){ return v; };
    var xformed = values.map(f), base = (ref || values).map(f);
    var lo = Math.min.apply(null, base), hi = Math.max.apply(null, base);
    if (hi - lo < 1e-9) return values.map(function(){ return 0.5; });
    return xformed.map(function(v){ return Math.max(0, Math.min(1, (v - lo) / (hi - lo))); });
  }

  // ---- Progressive trace. The line is DRAWN segment by segment (TL1→TL2→TL3→TL4) up to the selected
  // trophic level, and retracts when moving back. One scalar, `reveal` (0..3 = segments drawn), drives the
  // visible path, the tip-following guide, the point highlight and the value readout, so they can never disagree.
  // Purely visual: every y/value comes from the real datasets (ECO_GRAPH_VARS / TROPHIC_DATA / selectedId).
  var ECO_SEG_MS = 600;                       // drawing time per segment (constant speed along the trace)
  var ecoAnim = { cur: null, from: null, to: null, cfg: null, key: null, tE: 0, tR: 0, durR: 0, raf: 0, durE: 420 };
  var ecoReduceMotionMQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function ecoEase(t){ return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; }
  function ecoLerp(a, b, k){ return a + (b - a) * k; }
  function ecoClamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function ecoSnap(st){ return { ys: st.ys.slice(), fo: st.fo, rv: st.rv }; }

  // Monotone cubic segment i as Bezier control points: a smooth curve THROUGH each real data point that never
  // overshoots or dips below a point (visual interpolation only — no extra data is created).
  function ecoSegBez(pts, i){
    var n = pts.length, h = pts[1].x - pts[0].x, d = [], m = [], k;
    for (k = 0; k < n - 1; k++) d.push((pts[k+1].y - pts[k].y) / h);
    m[0] = d[0]; m[n-1] = d[n-2];
    for (k = 1; k < n - 1; k++) m[k] = (d[k-1] * d[k] <= 0) ? 0 : 2 * d[k-1] * d[k] / (d[k-1] + d[k]);
    var p1 = pts[i], p2 = pts[i + 1];
    return [p1, { x: p1.x + h / 3, y: p1.y + m[i] * h / 3 }, { x: p2.x - h / 3, y: p2.y - m[i+1] * h / 3 }, p2];
  }
  function ecoBezAt(b, t){
    var u = 1 - t;
    return { x: u*u*u*b[0].x + 3*u*u*t*b[1].x + 3*u*t*t*b[2].x + t*t*t*b[3].x,
             y: u*u*u*b[0].y + 3*u*u*t*b[1].y + 3*u*t*t*b[2].y + t*t*t*b[3].y };
  }
  // parameter t at which a fraction f of the segment's ARC LENGTH has been drawn (keeps the pen speed even)
  function ecoTAtLength(b, f){
    var N = 14, cum = [0], prev = b[0], k, q;
    for (k = 1; k <= N; k++){ q = ecoBezAt(b, k / N); cum.push(cum[k-1] + Math.hypot(q.x - prev.x, q.y - prev.y)); prev = q; }
    var want = f * cum[N];
    for (k = 1; k <= N; k++){ if (cum[k] >= want) return ((k - 1) + (want - cum[k-1]) / Math.max(cum[k] - cum[k-1], 1e-9)) / N; }
    return 1;
  }
  function ecoPartialPath(pts, reveal){
    var n = Math.min(3, Math.floor(reveal + 1e-9)), f = reveal - n, d = "M " + pts[0].x.toFixed(2) + " " + pts[0].y.toFixed(2), i, b;
    for (i = 0; i < n; i++){
      b = ecoSegBez(pts, i);
      d += " C " + b[1].x.toFixed(2) + " " + b[1].y.toFixed(2) + ", " + b[2].x.toFixed(2) + " " + b[2].y.toFixed(2) + ", " + b[3].x.toFixed(2) + " " + b[3].y.toFixed(2);
    }
    if (n < 3 && f > 1e-4){                                 // newest segment: split the Bezier (De Casteljau) at the drawn length
      b = ecoSegBez(pts, n);
      var t = ecoTAtLength(b, f), L = function(a, c){ return { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t }; };
      var a01 = L(b[0], b[1]), a12 = L(b[1], b[2]), a23 = L(b[2], b[3]), a012 = L(a01, a12), a123 = L(a12, a23), tip = L(a012, a123);
      d += " C " + a01.x.toFixed(2) + " " + a01.y.toFixed(2) + ", " + a012.x.toFixed(2) + " " + a012.y.toFixed(2) + ", " + tip.x.toFixed(2) + " " + tip.y.toFixed(2);
    }
    return d;
  }

  function ecoIsIllustrative(cfg, i){ return !!(cfg.illustrative && cfg.illustrative.indexOf(i) !== -1); }
  function ecoSetValue(els, cfg, text, suffix){    // number + small unit, one right-aligned <text>
    if (!els.valueNum){
      var ns = "http://www.w3.org/2000/svg";
      els.valueLabel.textContent = "";
      els.valueNum = document.createElementNS(ns, "tspan");
      els.valueUnit = document.createElementNS(ns, "tspan");
      els.valueUnit.setAttribute("class", "eco-value-unit"); els.valueUnit.setAttribute("dx", "2.5");
      els.valueLabel.appendChild(els.valueNum); els.valueLabel.appendChild(els.valueUnit);
    }
    els.valueNum.textContent = text; els.valueUnit.textContent = (cfg.unit || "") + (suffix || "");
  }
  function ecoDraw(st, cfg, raw, exact){
    var els = ecoGraphEls, rv = st.rv, pts = st.ys.map(function(y, i){ return { x: ecoGraphXAt(i), y: y }; });
    els.path.setAttribute("d", ecoPartialPath(pts, rv));
    els.markers.forEach(function(m, i){
      if (!m) return;
      var vis = i === 0 ? 1 : ecoClamp01((rv - i + 0.08) / 0.08);          // a point appears as the pen reaches it
      var w = ecoClamp01(1 - Math.abs(rv - i) / 0.35) * st.fo;              // "focus" = how close the pen tip is to this point
      m.setAttribute("cy", st.ys[i].toFixed(2));
      m.setAttribute("r", (2.2 + 0.9 * w).toFixed(2));
      m.style.opacity = (vis * (1 - 0.35 * st.fo * (1 - w))).toFixed(2);   // neighbours stay visible but subdued
      m.classList.toggle("sel", w > 0.6);
      var ill = ecoIsIllustrative(cfg, i);                                  // illustrative value: hollow ring
      m.style.fill = ill ? "var(--bg)" : cfg.color;
      m.style.stroke = ill ? cfg.color : "";
    });
    var gx = ECO_GRAPH_X0 + (ECO_GRAPH_X1 - ECO_GRAPH_X0) * (rv / 3);      // guide travels with the pen tip
    els.guide.setAttribute("x1", gx.toFixed(2)); els.guide.setAttribute("x2", gx.toFixed(2)); els.guide.style.opacity = st.fo.toFixed(2);
    if (st.fo > 0.01){
      var i0 = Math.min(3, Math.floor(rv + 1e-9)), fr = rv - i0, v = (fr < 1e-6 || i0 >= 3) ? raw[i0] : ecoLerp(raw[i0], raw[i0 + 1], fr);
      ecoSetValue(els, cfg, cfg.format(exact ? raw[Math.round(rv)] : Math.round(v * 10) / 10), ecoIsIllustrative(cfg, Math.round(rv)) ? " \u00b7 illustrative" : "");
    }
    els.valueLabel.style.opacity = st.fo.toFixed(2);
  }
  function ecoFrame(now){
    var a = ecoAnim, f = a.from, t = a.to;
    var ke = ecoClamp01((now - a.tE) / a.durE), kr = a.durR > 0 ? ecoClamp01((now - a.tR) / a.durR) : 1, e = ecoEase(ke);
    if (ke >= 1 && kr >= 1){ a.cur = ecoSnap(t); a.raf = 0; ecoDraw(t, a.cfg, a.raw, true); return; }   // settle exactly on the real values
    a.cur = { ys: t.ys.map(function(y, i){ return ecoLerp(f.ys[i], y, e); }), fo: ecoLerp(f.fo, t.fo, e), rv: ecoLerp(f.rv, t.rv, kr) };
    ecoDraw(a.cur, a.cfg, a.raw, false);
    a.raf = requestAnimationFrame(ecoFrame);
  }

  // The OTHER habitat's biomass shape (reference values, same square-root scale, each normalised to its own
  // largest level) so the upright pond pyramid and the inverted open-sea pyramid can be compared on one graph.
  var ECO_OTHER_MODE = IS_POND ? "sea" : "pond";
  var ECO_OTHER_LABEL = IS_POND ? "Open sea" : "Pond";
  function updateEcoGhost(){
    var path = document.getElementById("ecoGhost"), leg = document.getElementById("ecoGhostLegend"), txt = document.getElementById("ecoGhostText");
    if (!path) return;
    var on = ecoActiveVar === "biomass";
    path.style.opacity = on ? "0.75" : "0";
    if (leg) leg.style.opacity = on ? "1" : "0";
    if (txt) txt.textContent = "vs " + ECO_OTHER_LABEL + " (shape)";   // each line is scaled to its own largest level: compare shapes, not heights
    if (!on) return;
    var ref = BIOMASS_REF[ECO_OTHER_MODE], mx = Math.max.apply(null, ref);
    var pts = ref.map(function(v, i){ return { x: ecoGraphXAt(i), y: ECO_GRAPH_LANE.yBase - Math.sqrt(v / mx) * (ECO_GRAPH_LANE.yBase - ECO_GRAPH_LANE.yTop) }; });
    path.setAttribute("d", ecoPartialPath(pts, 3));
  }

  function updateEcoGraph(){
    if (!ecoGraphEls) return;
    var cfg = ECO_GRAPH_VARS[ecoActiveVar];
    updateEcoGhost();
    var rawValues = cfg.values();
    var norm = cfg.log ? ecoGraphNormalize(rawValues, true, cfg.ref ? cfg.ref() : undefined) : rawValues.map(function(v){ var mx = cfg.ref ? Math.max.apply(null, cfg.ref()) : 100; var r = Math.max(0, Math.min(1, v / mx)); return cfg.sqrt ? Math.sqrt(r) : r; });
    var ys = norm.map(function(n){ return ECO_GRAPH_LANE.yBase - n * (ECO_GRAPH_LANE.yBase - ECO_GRAPH_LANE.yTop); });
    // selectedId (tap a layer, or the step arrows) is the ONLY input: the trace is drawn up to that level.
    // Nothing selected -> the whole trace is shown without focus.
    var idx = (selectedId !== null) ? (selectedId - 1) : -1;
    var svgEl = document.getElementById("ecoGraphSvg");
    if (svgEl) svgEl.setAttribute("aria-label", cfg.label + " across trophic levels TL1 to TL4" + (idx >= 0 ? ". Selected TL" + (idx + 1) + ": " + cfg.format(rawValues[idx]) + (cfg.unit ? " " + cfg.unit : "") + (ecoIsIllustrative(cfg, idx) ? " (illustrative value)" : "") : "") + (ecoActiveVar === "biomass" ? ". Dashed line: " + ECO_OTHER_LABEL + " for comparison" : ""));
    var cur = ecoAnim.cur, metricChanged = ecoAnim.key !== null && ecoAnim.key !== ecoActiveVar;
    ecoAnim.key = ecoActiveVar;

    ecoGraphEls.path.style.stroke = cfg.color;
    ecoGraphEls.varLabel.textContent = cfg.label;
    var scaleNote = document.getElementById("ecoScaleNote");
    if (scaleNote) scaleNote.textContent = cfg.log ? "log scale" : (cfg.sqrt ? "\u221a scale" : "");
    ecoGraphEls.varLabel.style.fill = cfg.color;
    ecoGraphEls.markers.forEach(function(m){ if (m){ m.style.fill = cfg.color; m.style.color = cfg.color; } });

    var to = { ys: ys, fo: idx >= 0 ? 1 : 0, rv: idx >= 0 ? idx : 3 };
    ecoAnim.cfg = cfg; ecoAnim.raw = rawValues;

    if (!cur || (ecoReduceMotionMQ && ecoReduceMotionMQ.matches)){          // first draw / reduced motion: no interpolation
      if (ecoAnim.raf){ cancelAnimationFrame(ecoAnim.raf); ecoAnim.raf = 0; }
      ecoAnim.cur = ecoSnap(to); ecoDraw(to, cfg, rawValues, true);
      return;
    }
    var from = ecoSnap(cur);                                                   // always start from what is on screen right now
    if (metricChanged){ from.ys = ys.slice(); from.rv = 0; }                   // new metric: rebuild its own curve from TL1
    var now = performance.now();
    var same = from.ys.every(function(v, i){ return Math.abs(v - ys[i]) < 1e-6; }) && Math.abs(from.fo - to.fo) < 1e-6 && Math.abs(from.rv - to.rv) < 1e-6;
    if (!ecoAnim.raf && same){ ecoDraw(to, cfg, rawValues, true); return; }   // nothing changed: no loop
    if (ecoAnim.raf) cancelAnimationFrame(ecoAnim.raf);
    ecoAnim.from = from; ecoAnim.to = to; ecoAnim.tE = ecoAnim.tR = now;
    ecoAnim.durR = Math.min(2400, Math.abs(to.rv - from.rv) * ECO_SEG_MS);
    ecoAnim.raf = requestAnimationFrame(ecoFrame);
  }

  function updateMortalityControl(){
    if (!mortalityButtonEl) return;
    var hasLiving = ORGANISM_ASSETS.some(function(asset){
      return asset.trophicLevel === selectedId && asset.status === "living";
    });
    mortalityButtonEl.classList.toggle("dimmed", !hasLiving);          // looks disabled but stays holdable, so reviving still works
    mortalityButtonEl.setAttribute("aria-disabled", hasLiving ? "false" : "true");
    mortalityButtonEl.title = (hasLiving ? "Remove one living organism without predation" : "No living organisms remain at this trophic level") + " \u00b7 hold 10s to restore placeholders";
  }

  function selectLayer(id){
    selectedId = id;
    layerMeshes.forEach(function(mesh){
      var isSel = mesh.userData.layerId === id;
      mesh.userData.targetScale = isSel ? mesh.userData.selectedScale : mesh.userData.baseScale;
    });
    updateBiomassUI(id);
    updateMortalityControl();
  }

  if (DEV_MODE && mortalityButtonEl){
    mortalityButtonEl.style.display = "grid";
    var mortalityHold = bindHoldGesture(mortalityButtonEl, function(){
      organismLockStatusEl.textContent = reviveDeadOrganisms() ? "Placeholders restored" : "Nothing to restore";
    }, 10000, function(msLeft){
      if (msLeft < 0){ organismLockStatusEl.textContent = ""; return; }   // same: clear a cancelled hold's stale countdown
      var secLeft = Math.ceil(msLeft / 1000);
      if (secLeft % 2 === 0) organismLockStatusEl.textContent = "Hold " + secLeft + " more seconds to restore placeholders";
    });
    mortalityButtonEl.addEventListener("click", function(e){
      if (mortalityHold.fired){ mortalityHold.fired = false; return; }   // the hold already restored the placeholders
      if (e.detail === 0 && e.shiftKey){ reviveDeadOrganisms(); return; }   // keyboard equivalent of the hold: Shift+Enter/Space, since Enter/Space alone must keep doing the plain action
      triggerMortality();
    });
  }

  function handlePick(clientX, clientY){
    var rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left)/rect.width)*2 - 1;
    ndc.y = -(((clientY - rect.top)/rect.height)*2 - 1);
    raycaster.setFromCamera(ndc, camera);

    var sunHits = raycaster.intersectObject(sunHitMesh, false);
    if (sunHits.length){ activateSun(); return; }

    // Organism picking exists only inside the editor. In normal mode the
    // existing trophic-layer selection remains the only canvas pick path.
    if (organismEditorOpen){
      var organismHits = raycaster.intersectObjects(embeddedOrganisms, false);
      if (organismHits.length){
        focusOrganismEditor(organismHits[0].object.userData.organismId);
        return;
      }
    }

    var hits = raycaster.intersectObjects(layerMeshes, false);
    if (hits.length) selectLayer(hits[0].object.userData.layerId);
  }

  // =========================================================
  // TROPHIC PROFILE SYSTEM — Phase 3
  //
  // Fully separate from selection/energy-flow/geometry (point 18):
  // it only READS layerMeshes (to know what was pressed) and
  // TROPHIC_DATA (for the energy figure shown), and the only thing
  // it writes back is pressGlowAmount — a cosmetic cue, unrelated
  // to selectedId/solarState/simState. Opening, switching, collapsing
  // or closing a profile never touches any of those.
  // =========================================================
  var SEA_PROFILES = {
    producers: {
      layerId: 1,
      icon: "🦠",
      title: "Producers · Phytoplankton",
      description: "Phytoplankton (diatoms, dinoflagellates, green microalgae) capture solar energy by photosynthesis in the sunlit surface water. Their standing crop (biomass present at any moment) is SMALL, but they divide very quickly and are grazed almost as fast as they grow — high productivity, small standing crop. That is why this pyramid of biomass is inverted. Beyond NCERT: the inversion is typical of the nutrient-poor open ocean; in productive coastal and upwelling waters, and during a phytoplankton bloom, the pyramid can be upright.",
      media: [
        { type:"image", url:"", title:"Diatoms under the microscope", caption:"Diatoms — silica-walled phytoplankton" },
        { type:"image", url:"", title:"Dinoflagellates", caption:"Dinoflagellates — two flagella, many photosynthetic" },
        { type:"image", url:"", title:"Phytoplankton bloom", caption:"A phytoplankton bloom seen from above" }
      ]
    },
    primaryConsumers: {
      layerId: 2,
      icon: "🦐",
      title: "Primary Consumers · Zooplankton",
      description: "Grazing zooplankton such as copepods, krill, ciliates and pteropods feed directly on phytoplankton. They live longer and turn over more slowly than their food, so their standing crop can EXCEED that of the phytoplankton supporting them (Odum, English Channel: about 21 g/m² of zooplankton and bottom fauna on 4 g/m² of phytoplankton).",
      media: [
        { type:"image", url:"", title:"Copepod grazing on diatoms", caption:"Copepod grazing on diatoms" },
        { type:"image", url:"", title:"Krill filter-feeding", caption:"Krill filter-feeding on phytoplankton" },
        { type:"image", url:"", title:"Ciliate feeding on microalgae", caption:"Ciliate feeding on microalgae" },
        { type:"image", url:"", title:"Pteropod (sea butterfly)", caption:"Pteropod — a swimming snail that grazes phytoplankton" }
      ]
    },
    secondaryConsumers: {
      layerId: 3,
      icon: "🐟",
      title: "Secondary Consumers · Planktivores",
      description: "Secondary consumers obtain energy by feeding on zooplankton: plankton-eating fish such as herring and anchovy, and predatory zooplankton such as arrow worms (chaetognaths).",
      media: [
        { type:"image", url:"", title:"Herring feeding on copepods", caption:"Herring feeding on copepods" },
        { type:"image", url:"", title:"Anchovy feeding on krill", caption:"Anchovy feeding on krill" },
        { type:"image", url:"", title:"Arrow worm catching a copepod", caption:"Arrow worm catching a copepod" }
      ]
    },
    tertiaryConsumers: {
      layerId: 4,
      icon: "🦈",
      title: "Tertiary Consumers · Blue shark",
      description: "Tertiary consumers such as the blue shark feed on plankton-eating fish like herring, and on squid (FishBase trophic level \u2248 4.4). Not every shark sits this high: whale sharks and basking sharks filter zooplankton, so they feed much lower in the chain. Energy still DECREASES about ten-fold at every step \u2014 the pyramid of energy is always upright \u2014 even though the pyramid of biomass (standing crop) can be inverted. The TL3/TL4 biomass values here are illustrative; this simulation uses four levels as its teaching model.",
      media: [
        { type:"image", url:"", title:"Blue shark feeding on herring", caption:"Blue shark feeding on herring" },
        { type:"image", url:"", title:"Blue shark hunting a school of fish", caption:"Blue shark hunting a school of small fish" }
      ]
    }
  };
  var POND_PROFILES = {
    producers: {
      layerId: 1,
      icon: "🌿",
      title: "Producers · Pond plants & algae",
      description: "In a plant-rich pond the producers are rooted submerged plants (Hydrilla, Vallisneria), floating-leaved plants (lotus, water lily), filamentous algae (Spirogyra) and phytoplankton. Plants and algal mats hold a LARGE standing crop, so the pyramid of biomass is upright (Odum, Silver Springs: about 809 g/m² of producers). A pond where only phytoplankton produce can show an inverted pyramid instead.",
      media: [
        { type:"image", url:"", title:"Hydrilla, a submerged plant", caption:"Hydrilla — rooted, submerged" },
        { type:"image", url:"", title:"Spirogyra filaments", caption:"Spirogyra — filamentous green alga" },
        { type:"image", url:"", title:"Lotus leaves and flower", caption:"Lotus — rooted, floating leaves" }
      ]
    },
    primaryConsumers: {
      layerId: 2,
      icon: "🐌",
      title: "Primary Consumers · Grazers",
      description: "Primary consumers feed on pond plants, algae and phytoplankton: water fleas (Daphnia), pond snails scraping algae, tadpoles grazing on algae and mayfly nymphs. Their combined biomass is much smaller than the producers' (Silver Springs: about 37 g/m²).",
      media: [
        { type:"image", url:"", title:"Daphnia filtering phytoplankton", caption:"Daphnia filtering phytoplankton" },
        { type:"image", url:"", title:"Pond snail grazing on algae", caption:"Pond snail grazing on algae" },
        { type:"image", url:"", title:"Tadpoles grazing on algae", caption:"Tadpoles grazing on algae" },
        { type:"image", url:"", title:"Mayfly nymph on a submerged leaf", caption:"Mayfly nymph feeding on algae" }
      ]
    },
    secondaryConsumers: {
      layerId: 3,
      icon: "🐸",
      title: "Secondary Consumers · Small predators",
      description: "Secondary consumers eat the grazers: small fish eating Daphnia, frogs eating insects, and dragonfly nymphs catching tadpoles and water fleas (Silver Springs carnivores: about 11 g/m²).",
      media: [
        { type:"image", url:"", title:"Small fish eating Daphnia", caption:"Small fish eating Daphnia" },
        { type:"image", url:"", title:"Frog catching an insect", caption:"Frog catching an insect" },
        { type:"image", url:"", title:"Dragonfly nymph catching a tadpole", caption:"Dragonfly nymph catching a tadpole" }
      ]
    },
    tertiaryConsumers: {
      layerId: 4,
      icon: "🐍",
      title: "Tertiary Consumers · Top predators",
      description: "Tertiary consumers such as a water snake eat frogs and fish. Here both energy AND biomass shrink at every step (Silver Springs top carnivores: about 1.5 g/m²). Compare with the Open sea view, where the same upright energy pyramid sits beside an inverted biomass pyramid.",
      media: [
        { type:"image", url:"", title:"Water snake catching a frog", caption:"Water snake catching a frog" },
        { type:"image", url:"", title:"Water snake catching a fish", caption:"Water snake catching a fish" }
      ]
    }
  };
  var trophicProfiles = IS_POND ? POND_PROFILES : SEA_PROFILES;
  var profileByLayerId = {};
  var layerIdToProfileKey = {};
  Object.keys(trophicProfiles).forEach(function(key){
    profileByLayerId[trophicProfiles[key].layerId] = trophicProfiles[key];
    layerIdToProfileKey[trophicProfiles[key].layerId] = key;
  });

  var profileEl = document.getElementById("profilePanel");
  var profileIconEl = document.getElementById("profileIcon");
  var profileTitleEl = document.getElementById("profileTitle");
  var profileDescEl = document.getElementById("profileDesc");
  var profileEnergyEl = document.getElementById("profileEnergy");
  var mediaIconEl = document.getElementById("mediaIcon");
  var mediaLabelEl = document.getElementById("mediaLabel");
  var mediaCaptionEl = document.getElementById("mediaCaption");
  var mediaDotsEl = document.getElementById("mediaDots");
  var mediaImgEl = document.getElementById("mediaImg");
  var mediaOverlayEl = document.getElementById("mediaCaptionOverlay");
  var mediaEditBtnEl = document.getElementById("mediaEditBtn");
  var mediaUrlBarEl = document.getElementById("mediaUrlBar");
  var mediaUrlInputEl = document.getElementById("mediaUrlInput");

  // ---- Profile images: every example is an image placeholder with an optional URL ----
  // Keys are "<layerId>:<example index>". Saved in localStorage, exported in the project
  // JSON, and baked into HTML snapshots through PROFILE_IMAGE_DEFAULTS.
  var PROFILE_IMAGE_STORAGE_KEY = "aquatic-profile-image-urls-v1";
  var PROFILE_IMAGE_DEFAULTS = (BAKED.profileImages && typeof BAKED.profileImages === "object") ? BAKED.profileImages : {};   // baked by "Save HTML Snapshot"
  var profileImageUrls = {};
  Object.keys(PROFILE_IMAGE_DEFAULTS).forEach(function(k){ profileImageUrls[k] = PROFILE_IMAGE_DEFAULTS[k]; });
  try {
    var savedProfileImages = JSON.parse(window.localStorage.getItem(PROFILE_IMAGE_STORAGE_KEY) || "{}");
    Object.keys(savedProfileImages).forEach(function(k){ if (typeof savedProfileImages[k] === "string" && savedProfileImages[k].indexOf("supabase.co") === -1) profileImageUrls[k] = savedProfileImages[k]; });   // dead Supabase links are skipped
  } catch (e) { /* localStorage can be unavailable for some file:// contexts */ }
  function saveProfileImageUrls(){
    var changed = {};                                        // built-in images live in the file itself; store only what the user changed
    Object.keys(profileImageUrls).forEach(function(k){ if (profileImageUrls[k] !== PROFILE_IMAGE_DEFAULTS[k]) changed[k] = profileImageUrls[k]; });
    try { window.localStorage.setItem(PROFILE_IMAGE_STORAGE_KEY, JSON.stringify(changed)); } catch (e) {}
  }
  // Empty clears the image. Scripts and non-image data URLs are refused (returns null).
  var BUILTIN_IMAGE_LABEL = "Built-in image (paste a link to replace)";
  function cleanProfileImageUrl(v){
    v = (v || "").trim();
    if (!v) return "";
    if (/^(javascript|vbscript):/i.test(v) || /^data:(?!image\/)/i.test(v)) return null;
    return v;
  }
  var mediaRenderToken = 0;

  // Explicit state model (point 11) — never inferred from CSS classes.
  var PROFILE_STATE = { CLOSED:"closed", EXPANDED:"expanded", COLLAPSED:"collapsed" };
  var EXPAND_DURATION_MS = 220, COLLAPSE_DURATION_MS = 180, CLOSE_DURATION_MS = 180;
  var profileUI = { state: PROFILE_STATE.CLOSED, activeProfile: null, layerId: null, mediaIndex: 0 };

  function setPanelTransitionDuration(ms){
    profileEl.style.setProperty("--panel-dur", ms + "ms");
  }

  function showMediaPlaceholder(on, label){
    mediaIconEl.style.display = mediaLabelEl.style.display = mediaCaptionEl.style.display = on ? "" : "none";
    mediaOverlayEl.hidden = on;
    if (label) mediaLabelEl.textContent = label;
  }
  var PROFILE_KEY_PREFIX = IS_POND ? "pond:" : "";   // keeps Pond and Open-sea pictures apart
  function currentMediaKey(){ return PROFILE_KEY_PREFIX + profileUI.layerId + ":" + profileUI.mediaIndex; }
  function renderMedia(profile){
    var idx = Math.min(profileUI.mediaIndex, profile.media.length - 1);
    var item = profile.media[idx] || profile.media[0];
    var caption = item.caption || item.title || "";
    var url = profileImageUrls[PROFILE_KEY_PREFIX + profile.layerId + ":" + idx];
    if (url === undefined) url = item.url || "";
    mediaCaptionEl.textContent = caption;
    mediaOverlayEl.textContent = caption;
    mediaIconEl.textContent = "\ud83d\uddbc\ufe0f";
    closeMediaUrlBar();
    var token = ++mediaRenderToken;                       // ignore late loads from a previous example
    showMediaPlaceholder(true, "Hold here to add an image link");
    mediaImgEl.hidden = true;
    if (url){
      mediaImgEl.onload = function(){ if (token !== mediaRenderToken) return; mediaImgEl.hidden = false; showMediaPlaceholder(false); };
      mediaImgEl.onerror = function(){ if (token !== mediaRenderToken) return; mediaImgEl.hidden = true; showMediaPlaceholder(true, "Image could not load \u2014 hold to change link"); };
      mediaImgEl.alt = caption;
      mediaImgEl.src = url;
    } else {
      mediaImgEl.removeAttribute("src");
    }
    var hasMultiple = profile.media.length > 1;               // Producers has one example; the consumer levels have several
    mediaPrevBtnEl.hidden = mediaNextBtnEl.hidden = !hasMultiple;
    mediaDotsEl.innerHTML = "";
    if (hasMultiple){
      profile.media.forEach(function(m, i){
        var dot = document.createElement("span");
        dot.className = "media-dot" + (i === profileUI.mediaIndex ? " active" : "");
        mediaDotsEl.appendChild(dot);
      });
    }
  }

  function renderProfile(layerId){
    var profile = profileByLayerId[layerId];
    if (!profile) return;
    profileIconEl.textContent = profile.icon;
    profileTitleEl.textContent = profile.title;
    profileDescEl.textContent = profile.description;
    var def = TROPHIC_DATA.filter(function(d){ return d.id === layerId; })[0];
    profileEnergyEl.textContent = def ? ("Energy available: " + formatEnergy(def.energy) + " \u00b7 Standing crop: " + def.biomassRef + " g/m\u00b2" + (BIOMASS_ILLUSTRATIVE[ECO_MODE].indexOf(def.id - 1) !== -1 ? " (illustrative)" : "")) : "";
    renderMedia(profile);
  }

  // CLOSED|COLLAPSED -> EXPANDED (new profile), or EXPANDED -> EXPANDED
  // (profile switch, same container) — long press always ends EXPANDED,
  // per points 7-9.
  // Cancellation token: guards the delayed `apply()` below so a fast double-switch
  // can't let an earlier, still-pending timeout overwrite a newer selection — and so
  // closeProfile() (which also bumps this token) can't be reopened by a stale timeout.
  var profileSwitchToken = 0;
  function openTrophicProfile(layerId){
    if (!profileByLayerId[layerId]) return;
    var switching = (profileUI.state !== PROFILE_STATE.CLOSED) && profileUI.layerId !== layerId;
    var token = ++profileSwitchToken;
    function apply(){
      if (token !== profileSwitchToken) return;   // superseded by a newer switch, or the panel was closed
      profileUI.layerId = layerId;
      profileUI.activeProfile = layerIdToProfileKey[layerId];
      profileUI.mediaIndex = 0;
      profileUI.state = PROFILE_STATE.EXPANDED;
      renderProfile(layerId);
      setPanelTransitionDuration(EXPAND_DURATION_MS);
      profileEl.classList.add("open");
      profileEl.classList.remove("collapsed");
      profileEl.classList.remove("switching");
      if (!switching) a11yOpen(profileEl, document.getElementById("profileCloseBtn"));
    }
    if (switching){
      profileEl.classList.add("switching"); // brief cross-fade of content only — the panel itself stays put
      window.setTimeout(apply, 150);
    } else {
      apply();
    }
  }

  // EXPANDED -> COLLAPSED. Does NOT touch activeProfile/layerId — the
  // profile stays "stored" (point 2) so reopening needs no re-fetch.
  function collapseProfile(){
    if (profileUI.state !== PROFILE_STATE.EXPANDED) return;
    profileUI.state = PROFILE_STATE.COLLAPSED;
    setPanelTransitionDuration(COLLAPSE_DURATION_MS);
    profileEl.classList.add("collapsed");
  }

  // COLLAPSED -> EXPANDED, same stored profile (point 3).
  function expandProfile(){
    if (profileUI.state !== PROFILE_STATE.COLLAPSED) return;
    profileUI.state = PROFILE_STATE.EXPANDED;
    setPanelTransitionDuration(EXPAND_DURATION_MS);
    profileEl.classList.remove("collapsed");
  }

  function toggleCollapseProfile(){
    if (profileUI.state === PROFILE_STATE.EXPANDED) collapseProfile();
    else if (profileUI.state === PROFILE_STATE.COLLAPSED) expandProfile();
  }

  // EXPANDED|COLLAPSED -> CLOSED (point 4). Only ever touches profileUI
  // and the panel's own classes — never solarState/simState/selectedId.
  function closeProfile(){
    if (profileUI.state === PROFILE_STATE.CLOSED) return;
    profileSwitchToken++;   // invalidate any pending switch's delayed apply()
    profileUI.state = PROFILE_STATE.CLOSED;
    profileUI.activeProfile = null;
    profileUI.layerId = null;
    setPanelTransitionDuration(CLOSE_DURATION_MS);
    profileEl.classList.remove("open");
    profileEl.classList.remove("collapsed");
    a11yClose(profileEl);
  }

  function openMediaUrlBar(){
    mediaUrlBarEl.hidden = false; mediaUrlBarEl.classList.remove("invalid"); mediaEditBtnEl.classList.add("active");
    var stored = profileImageUrls[currentMediaKey()];
    mediaUrlInputEl.value = (stored && /^data:image\//i.test(stored)) ? BUILTIN_IMAGE_LABEL : (stored !== undefined ? stored : "");
    mediaUrlInputEl.focus();
  }
  function closeMediaUrlBar(){ mediaUrlBarEl.hidden = true; mediaEditBtnEl.classList.remove("active"); }
  function applyMediaUrl(){
    var profile = profileByLayerId[profileUI.layerId];
    if (!profile) return;
    if (mediaUrlInputEl.value === BUILTIN_IMAGE_LABEL){ closeMediaUrlBar(); return; }   // untouched built-in image
    var clean = cleanProfileImageUrl(mediaUrlInputEl.value);
    if (clean === null){ mediaUrlBarEl.classList.add("invalid"); return; }
    profileImageUrls[currentMediaKey()] = clean;
    saveProfileImageUrls();
    renderMedia(profile);                                 // also closes the bar
  }
  // Locked by default: a plain tap on the pencil does nothing while closed, so a stray tap can never
  // overwrite an image. Holding it (or activating it from the keyboard, where a hold isn't possible —
  // e.detail is 0 for a key-triggered click, >0 for a real pointer click) unlocks and opens the editor.
  // It always relocks: closing the bar (tap again, Enter/Apply, switching example/level) leaves nothing
  // unlocked to carry into the next reload, since the open/closed state itself is never persisted.
  // Long-press the picture (or its placeholder) itself -> same link box as holding the pencil.
  (function(){
    var mediaBoxEl = document.getElementById("profileMedia");
    if (!mediaBoxEl) return;
    var hold = { timer:0, x:0, y:0 };
    function cancel(){ if (hold.timer){ clearTimeout(hold.timer); hold.timer = 0; } }
    mediaBoxEl.addEventListener("pointerdown", function(e){
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest("button, input, .media-url-bar")) return;   // arrows, pencil and the box itself keep their own behaviour
      cancel();
      hold.x = e.clientX; hold.y = e.clientY;
      hold.timer = setTimeout(function(){ hold.timer = 0; if (mediaUrlBarEl.hidden) openMediaUrlBar(); }, 600);
    });
    mediaBoxEl.addEventListener("pointermove", function(e){
      if (hold.timer && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) cancel();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function(t){ mediaBoxEl.addEventListener(t, cancel); });
    mediaBoxEl.addEventListener("contextmenu", function(e){ if (!e.target.closest("input")) e.preventDefault(); });   // no "save image" menu on long-press
  })();
  var mediaEditHold = bindHoldGesture(mediaEditBtnEl, openMediaUrlBar, 600);   // explicit 600 ms — LONG_PRESS_MS isn't assigned until later in the script, so the implicit default was undefined here
  mediaEditBtnEl.addEventListener("click", function(e){
    if (mediaEditHold.fired){ mediaEditHold.fired = false; return; }
    if (e.detail === 0){ if (mediaUrlBarEl.hidden) openMediaUrlBar(); else closeMediaUrlBar(); return; }
    if (mediaUrlBarEl.hidden){
      mediaEditBtnEl.classList.remove("locked-nudge"); void mediaEditBtnEl.offsetWidth; mediaEditBtnEl.classList.add("locked-nudge");
      return;
    }
    closeMediaUrlBar();
  });
  document.getElementById("mediaUrlSetBtn").addEventListener("click", applyMediaUrl);
  mediaUrlInputEl.addEventListener("keydown", function(e){
    if (e.key === "Enter"){ e.preventDefault(); applyMediaUrl(); }
    else if (e.key === "Escape"){ e.preventDefault(); closeMediaUrlBar(); }
  });
  mediaUrlInputEl.addEventListener("input", function(){ mediaUrlBarEl.classList.remove("invalid"); });

  function stepMedia(delta){
    var profile = profileByLayerId[profileUI.layerId];
    if (!profile) return;
    var n = profile.media.length;
    profileUI.mediaIndex = (profileUI.mediaIndex + delta + n) % n;
    renderMedia(profile);
  }

  document.getElementById("profileTabHeader").addEventListener("click", function(e){
    if (e.target.closest(".profile-tab-btn")) return; // let the buttons handle their own clicks
    toggleCollapseProfile();
  });
  document.getElementById("profileCollapseBtn").addEventListener("click", function(e){
    e.stopPropagation(); toggleCollapseProfile();
  });
  document.getElementById("profileCloseBtn").addEventListener("click", function(e){
    e.stopPropagation(); closeProfile();
  });
var mediaPrevBtnEl = document.getElementById("mediaPrevBtn"), mediaNextBtnEl = document.getElementById("mediaNextBtn");
  mediaPrevBtnEl.addEventListener("click", function(){ stepMedia(-1); });
  mediaNextBtnEl.addEventListener("click", function(){ stepMedia(1); });
  // ---- Long-press detection, layered on top of the existing
  // pointer handlers below without changing their tap/drag logic ----
  var LONG_PRESS_MS = 600;
  var LONG_PRESS_MOVE_TOLERANCE = 10;
  var PRESS_GLOW_MAX = 0.22;
  var longPress = { active:false, fired:false, organismId:null, layerId:null, mesh:null, startX:0, startY:0, startTime:0 };

  function pickLayerMeshAt(clientX, clientY){
    var rect = renderer.domElement.getBoundingClientRect();
    var n = new THREE.Vector2(
      ((clientX-rect.left)/rect.width)*2-1,
      -(((clientY-rect.top)/rect.height)*2-1)
    );
    raycaster.setFromCamera(n, camera);
    var hits = raycaster.intersectObjects(layerMeshes, false);
    return hits.length ? hits[0].object : null;
  }
  function beginLongPressTracking(clientX, clientY){
    var organismId = pickOrganismAt(clientX, clientY);
    var mesh = organismId ? null : pickLayerMeshAt(clientX, clientY);   // holding a picture edits it; holding bare layer opens its profile
    if (!mesh && !organismId){ longPress.active = false; return; }
    longPress.active = true;
    longPress.fired = false;
    longPress.organismId = organismId;
    longPress.mesh = mesh;
    longPress.layerId = mesh ? mesh.userData.layerId : null;
    longPress.startX = clientX;
    longPress.startY = clientY;
    longPress.startTime = performance.now();
  }
  function updateLongPressTracking(clientX, clientY){
    if (!longPress.active) return;
    if (Math.hypot(clientX-longPress.startX, clientY-longPress.startY) > LONG_PRESS_MOVE_TOLERANCE){
      cancelLongPressTracking();
    }
  }
  function cancelLongPressTracking(){
    if (longPress.mesh && !longPress.fired) longPress.mesh.userData.pressGlowAmount = 0;
    longPress.active = false;
    longPress.mesh = null;
  }
  function checkLongPressFire(){
    if (!longPress.active || longPress.fired) return;
    var heldMs = performance.now() - longPress.startTime;
    if (longPress.mesh) longPress.mesh.userData.pressGlowAmount = PRESS_GLOW_MAX * Math.min(1, heldMs/LONG_PRESS_MS);
    if (heldMs >= LONG_PRESS_MS){
      longPress.fired = true;
      if (longPress.mesh) longPress.mesh.userData.pressGlowAmount = 0;
      if (longPress.organismId) openOrganismUrlBox(longPress.organismId);
      else openTrophicProfile(longPress.layerId);
      longPress.active = false;
    }
  }

  var dom = renderer.domElement;
  var isDragging = false;
  var lastX=0, lastY=0, downX=0, downY=0, downTime=0;

  dom.addEventListener("mousedown", function(e){
    isDragging = true;
    lastX = downX = e.clientX;
    lastY = downY = e.clientY;
    downTime = performance.now();
    beginLongPressTracking(e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", function(e){
    if (!isDragging) return;
    updateLongPressTracking(e.clientX, e.clientY);
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    controls.targetTheta -= dx*0.0055;
    controls.targetPhi   -= dy*0.0055;
    controls.clampPhi();
    lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener("mouseup", function(e){
    if (!isDragging) return;
    isDragging = false;
    var wasLongPress = longPress.fired;
    cancelLongPressTracking();
    var dist = Math.hypot(e.clientX-downX, e.clientY-downY);
    var dt = performance.now() - downTime;
    if (!wasLongPress && dist < 6 && dt < 350) handlePick(e.clientX, e.clientY);
  });
  dom.addEventListener("wheel", function(e){
    e.preventDefault();   // wheel and trackpad pinch (ctrl+wheel) zoom the scene, not the page; Ctrl +/- still zooms the page
    var dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);       // normalise line/page wheel units
    controls.targetRadius *= Math.exp(dy * (e.ctrlKey ? 0.006 : 0.00045));            // proportional: same feel at any distance; pinch events are tiny so they get a larger gain
    controls.clampRadius();
  }, { passive:false });

  function touchDist(touches){
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  var touchMode = null, pinchStartDist=0, pinchStartRadius=0;

  dom.addEventListener("touchstart", function(e){
    if (e.touches.length === 1){
      touchMode = "rotate";
      lastX = downX = e.touches[0].clientX;
      lastY = downY = e.touches[0].clientY;
      downTime = performance.now();
      beginLongPressTracking(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2){
      touchMode = "pinch";
      pinchStartDist = touchDist(e.touches);
      pinchStartRadius = controls.targetRadius;
      cancelLongPressTracking(); // a second finger means this is a pinch, not a hold
    }
  }, { passive:true });

  dom.addEventListener("touchmove", function(e){
    e.preventDefault();
    if (touchMode === "rotate" && e.touches.length === 1){
      var t = e.touches[0];
      updateLongPressTracking(t.clientX, t.clientY);
      var dx = t.clientX - lastX, dy = t.clientY - lastY;
      controls.targetTheta -= dx*0.0055;
      controls.targetPhi   -= dy*0.0055;
      controls.clampPhi();
      lastX = t.clientX; lastY = t.clientY;
    } else if (touchMode === "pinch" && e.touches.length === 2){
      var d = touchDist(e.touches);
      var scale = pinchStartDist / Math.max(d, 1);
      controls.targetRadius = pinchStartRadius * scale;
      controls.clampRadius();
    }
  }, { passive:false });

  dom.addEventListener("touchend", function(e){
    var wasLongPress = longPress.fired;
    cancelLongPressTracking();
    if (touchMode === "rotate" && e.changedTouches.length){
      var ct = e.changedTouches[0];
      var dist = Math.hypot(ct.clientX-downX, ct.clientY-downY);
      var dt = performance.now() - downTime;
      if (!wasLongPress && dist < 8 && dt < 350) handlePick(ct.clientX, ct.clientY);
    }
    if (e.touches.length === 0){
      touchMode = null;
    } else if (e.touches.length === 1){
      touchMode = "rotate";
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    }
  });

  function downloadTextFile(filename,text,mimeType){var blob=new Blob([text],{type:mimeType}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
  function exportTimestamp(){return new Date().toISOString().replace(/[:.]/g,"-");}
  // Repo-relative paths (Solus-Assets/...) only work next to this page on the website. A downloaded
  // snapshot lives somewhere else, so bake them as full web addresses (only when the page itself was
  // served from the web; data:, blob: and full links are left as they are).
  function snapshotUrl(u){
    if (!u || /^(data:|blob:|https?:|builtin:)/i.test(u) || !/^https?:$/i.test(location.protocol)) return u;
    try { return new URL(u, document.baseURI).href; } catch (e) { return u; }
  }
  // Builds a one-file snapshot. Edits are written into a small data block (window.TETHYS_BAKED). When the
  // page is served from a website, style.css and script.js are fetched and inlined so the snapshot works
  // on its own. Opened straight from disk (file://) browsers block that fetch: the snapshot then still
  // saves, but links style.css / script.js and must be kept in the same folder as them.
  function buildSnapshotHtml(done){
    var html = SNAPSHOT_SOURCE;
    html = html.replace(/<div id="ecoFade"[^>]*>\s*<div class="eco-fade-msg" id="ecoFadeMsg">[^<]*<\/div>/,   // never save the switch cover in its "on" state
      '<div id="ecoFade" aria-hidden="true"><div class="eco-fade-msg" id="ecoFadeMsg"></div>');
    var organismUrls = {};
    if (BAKED.organismUrls) Object.keys(BAKED.organismUrls).forEach(function(k){ organismUrls[k] = BAKED.organismUrls[k]; });   // keep the other habitat's baked links
    ORGANISM_ASSETS.forEach(function(asset){ organismUrls[asset.id] = snapshotUrl(asset.imageUrl || ""); });
    var profileImages = {};
    Object.keys(profileImageUrls).forEach(function(k){ profileImages[k] = snapshotUrl(profileImageUrls[k]); });
    // tag strings are split ('<scr' + 'ipt', 'style' + '.css') so that, once this script is inlined into a
    // snapshot, its own source never contains the exact tags these replacements look for
    var block = '<scr' + 'ipt id="tethys' + 'Baked">window.TETHYS_BAKED = ' +
      JSON.stringify({ mode: ECO_MODE, organismUrls: organismUrls, profileImages: profileImages }).replace(/<\//g, "<\\/") + ';<\/script>\n';
    html = html.replace(new RegExp('<scr' + 'ipt id="tethys' + 'Baked">[\\s\\S]*?<\\/script>\\s*'), "");
    var cdn = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script>';
    html = html.indexOf(cdn) !== -1 ? html.replace(cdn, cdn + "\n" + block) : html.replace("</body>", block + "</body>");
    var cssTag = '<link rel="stylesheet" href="' + 'style.css">', jsTag = '<scr' + 'ipt src="' + 'script.js"><\/script>';
    if (html.indexOf(cssTag) === -1 && html.indexOf(jsTag) === -1){ done(html, true); return; }   // already a one-file snapshot
    function getText(u){ return fetch(u, { cache: "no-store" }).then(function(r){ if (!r.ok) throw new Error(u); return r.text(); }); }
    Promise.all([getText("style.css"), getText("script.js")]).then(function(t){
      html = html.replace(cssTag, function(){ return "<style>\n" + t[0] + "\n</style>"; });
      html = html.replace(jsTag, function(){ return "<script>\n" + t[1].replace(/<\/script/gi, "<\\/script") + "\n<\/script>"; });
      done(html, true);
    }).catch(function(){ done(html, false); });
  }
  (function(){
    var btn = document.getElementById("saveHtmlSnapshotBtn");
    if (!btn) return;
    btn.addEventListener("click", function(){
      buildSnapshotHtml(function(html, selfContained){
        downloadTextFile("tethys-trophicus-snapshot-" + exportTimestamp() + ".html", html, "text/html;charset=utf-8");
        btn.classList.remove("flash-ok", "flash-err"); void btn.offsetWidth; btn.classList.add(selfContained ? "flash-ok" : "flash-err");
        btn.title = selfContained ? "Save HTML snapshot" : "Saved — keep this snapshot in the same folder as style.css and script.js";
        if (DEV_MODE && !selfContained) console.warn("Snapshot saved without inlined style.css/script.js (page opened from disk).");
      });
    });
  })();
  var STATE_SCHEMA_VERSION = 1;
  document.getElementById("exportJsonBtn").addEventListener("click",function(){var state={schemaVersion:STATE_SCHEMA_VERSION,project:"Tethys Trophicus",habitat:ECO_MODE,exportedAt:new Date().toISOString(),selectedTrophicLevel:selectedId,solarState:{state:simState,energyDelivered:solarState.energyDelivered},trophicLevels:TROPHIC_DATA,organisms:ORGANISM_ASSETS,profileImages:profileImageUrls};downloadTextFile("tethys-trophicus-" + ECO_MODE + "-state-"+exportTimestamp()+".json",JSON.stringify(state,null,2),"application/json;charset=utf-8");});

  // ---- Import state JSON: restores what can be restored safely and instantly —
  // organism image URLs, profile image URLs, which organisms have already died
  // (fast-forwarded straight to their end state, no animation replay), and the
  // selected trophic level. The Sun/PAR run and the 7-step ecosystem-flow sequence
  // are NOT replayed from an import; the scene is left at rest, which is simpler
  // and always correct rather than guessing where a partial animation left off.
  function importStateJson(raw){
    var data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error("not valid JSON"); }
    if (!data || typeof data !== "object" || !Array.isArray(data.organisms)) throw new Error("not a Tethys Trophicus state file");
    if (data.schemaVersion !== undefined && data.schemaVersion > STATE_SCHEMA_VERSION) throw new Error("file is from a newer version of this app");
    var fileHabitat = data.habitat === "pond" ? "pond" : "sea";   // exports without a habitat field are open-sea
    if (fileHabitat !== ECO_MODE){
      if (ecoSwitchTo(fileHabitat, { importJson: raw })) return "switching";   // re-applied after the switch
      throw new Error("this state file is for the " + (fileHabitat === "pond" ? "Pond" : "Open sea") + " view");
    }

    cancelCurrentSimulation(); // start from a clean, idle scene before applying imported state

    var byId = {};
    ORGANISM_ASSETS.forEach(function(a){ byId[a.id] = a; });
    var touchedLevels = {};
    data.organisms.forEach(function(imp){
      var asset = imp && byId[imp.id];
      if (!asset) return; // unknown id (older/newer asset list) — skip rather than fail the whole import
      if (typeof imp.imageUrl === "string" && imp.imageUrl && imp.imageUrl !== asset.imageUrl && imp.imageUrl.indexOf("supabase.co") === -1){   // older exports may carry dead Supabase links
        asset.imageUrl = imp.imageUrl;
        var slot = organismSlots[asset.id];
        if (slot) loadOrganismImage(asset, slot);
      }
      if ((imp.status === "deadMatter" || imp.status === "dying") && asset.status === "living"){
        var s = organismSlots[asset.id];
        if (s){ finishMortality(asset, s); touchedLevels[asset.trophicLevel] = true; }
      }
    });
    saveOrganismUrls();

    if (data.profileImages && typeof data.profileImages === "object"){
      Object.keys(data.profileImages).forEach(function(k){
        if (typeof data.profileImages[k] === "string" && data.profileImages[k].indexOf("supabase.co") === -1) profileImageUrls[k] = data.profileImages[k];
      });
      saveProfileImageUrls();
    }

    Object.keys(touchedLevels).forEach(function(id){ updateBiomassUI(Number(id)); });
    if (profileUI.state !== PROFILE_STATE.CLOSED) renderProfile(profileUI.layerId);   // also picks up imported card pictures

    var lvl = data.selectedTrophicLevel;
    if (lvl === 1 || lvl === 2 || lvl === 3 || lvl === 4) selectLayer(lvl);
  }
  (function initImportJson(){
    var btn = document.getElementById("importJsonBtn"), input = document.getElementById("importJsonInput");
    if (!btn || !input) return;
    function flash(ok){
      var cls = ok ? "flash-ok" : "flash-err";
      btn.classList.remove("flash-ok", "flash-err"); void btn.offsetWidth; btn.classList.add(cls);
    }
    btn.addEventListener("click", function(){ input.value = ""; input.click(); });
    input.addEventListener("change", function(){
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(){
        try { importStateJson(String(reader.result)); flash(true); if (DEV_MODE) console.log("State JSON imported:", file.name); }
        catch (e) { flash(false); if (DEV_MODE) console.warn("State JSON import failed:", e.message); }
      };
      reader.onerror = function(){ flash(false); };
      reader.readAsText(file);
    });
  })();
  document.getElementById("resetBtn").addEventListener("click", function(){
    controls.reset();
    cancelCurrentSimulation();
  });

  // =========================================================
  // Animation loop
  // =========================================================
  var elapsed = 0;
  var lastTime = performance.now();

  function animate(now){
    requestAnimationFrame(animate);
    var delta = Math.min((now - lastTime)/1000, 0.05);
    lastTime = now;
    elapsed += delta;

    controls.update();
    updateMortalityAnimations(elapsed, delta);
    updateRemains(elapsed, delta);

    layerMeshes.forEach(function(mesh){
      var ud = mesh.userData;
      ud.currentScale += (ud.targetScale - ud.currentScale) * 0.12;
      mesh.scale.setScalar(ud.currentScale);
      var targetEmissive = (ud.layerId === selectedId) ? ud.selectedEmissive : ud.baseEmissive;
      ud.currentEmissive += (targetEmissive - ud.currentEmissive) * 0.12;
      mesh.material.emissiveIntensity = ud.currentEmissive + (ud.producerGlowAmount || 0) + (ud.pressGlowAmount || 0);
      ud.edgeMat.opacity = 0.35 + ((ud.layerId === selectedId) ? 0.55 : 0);
    });

    waveTubes.forEach(function(t){ t.userData.update(elapsed); });
    updateAquaticWaves(elapsed, delta);
    particleSystems.forEach(function(p){ p.userData.update(delta); });

    var pulse = 0.45 + 0.25*Math.sin(elapsed*1.4);
    apexMat.opacity = pulse;

    // Solar / PAR system — Phase 2B run/state machine:
    //   IDLE -> SUN_ACTIVATING (0-200ms) -> PAR_EMITTING ->
    //   WAITING_FOR_PAR_CONTACT (distance-derived) ->
    //   PRODUCER_ACTIVATING (500ms) -> PRODUCER_ENERGISED.
    // Every branch below is gated on `run`/`simState`, both of
    // which cancelCurrentSimulation() clears atomically — so a
    // cancelled run can never reach any of these branches again.
    updateSun(elapsed);

    if (run && simState === SIM_STATE.SUN_ACTIVATING && (elapsed - run.startElapsed) >= SUN_ACTIVATION_DURATION){
      simState = SIM_STATE.PAR_EMITTING;
      run.parStartedAtElapsed = elapsed;
      run.producerContactAtElapsed = elapsed + minRayTravelDuration;
      parGroup.visible = true;
      resetRayParticles();
      if (DEV_MODE){
        console.log("PAR emission:        " + (elapsed - run.startElapsed).toFixed(2) + " s");
      }
      logDebugSnapshot();
      simState = SIM_STATE.WAITING_FOR_PAR_CONTACT; // PAR_EMITTING is a one-tick transition state
      logDebugSnapshot();
    }

    if (run && (simState === SIM_STATE.WAITING_FOR_PAR_CONTACT ||
                simState === SIM_STATE.PRODUCER_ACTIVATING ||
                simState === SIM_STATE.PRODUCER_ENERGISED)){
      var tSincePAR = elapsed - run.parStartedAtElapsed;
      rayTubes.forEach(function(t){ t.userData.update(tSincePAR); });
      updateRayParticles(delta);
      if (simState === SIM_STATE.WAITING_FOR_PAR_CONTACT && elapsed >= run.producerContactAtElapsed){
        beginProducerActivation(run, elapsed); // fires exactly once per run — see Run-ID guard inside
      }
    }
    updateProducerActivationTransition(elapsed);
    updateProducerFlash(elapsed);
    updateEcosystemFlow(elapsed, delta); // after the layer loop: it adds a small emissive lift on top
    checkLongPressFire();

    renderer.render(scene, camera);
  }

  selectLayer(1);
  updateSun(0);
  updateSolarStatusUI();

  // =========================================================
  // Stage fit (phones) — presentation only. Frames the resting camera so the whole
  // pyramid sits between the header tools and the bottom card instead of behind it.
  // Simulation, geometry and picking are untouched; Reset view returns to this framing.
  // =========================================================
  (function stageFit(){
    var tmpCam = new THREE.PerspectiveCamera(50, 1, 0.1, 150), v = new THREE.Vector3();
    var DEF_R = START_RADIUS, DEF_Y = controls.target.y, first = true;
    function corners(){                                      // apex + base ring (+ soil depth) + Sun: the silhouette that must stay in view
      var b = new THREE.Box3();
      layerMeshes.forEach(function(m){ b.expandByObject(m); });
      var cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      var R = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2, yLow = b.min.y - 0.8;
      var pts = [ new THREE.Vector3(sunGroup.position.x, sunGroup.position.y - 1.6, sunGroup.position.z),
                  new THREE.Vector3(sunGroup.position.x - 1.2, sunGroup.position.y, sunGroup.position.z),
                  new THREE.Vector3(sunGroup.position.x, sunGroup.position.y + 1.3, sunGroup.position.z) ];   // top of the Sun (high in the pond view)
      for (var k = 0; k < 16; k++){ var q = k / 16 * Math.PI * 2;                     // broad rim on top, sea floor below
        var Rt = IS_POND ? 0.2 : Math.max(R, halfW(TOTAL_HEIGHT) * 0.95);               // sea: frame rim at y = 12 is the widest part; pond: apex
        pts.push(new THREE.Vector3(cx + Rt*Math.cos(q), TOTAL_HEIGHT, cz + Rt*Math.sin(q)));
        pts.push(new THREE.Vector3(cx + R*Math.cos(q), yLow, cz + R*Math.sin(q))); }
      return pts;
    }
    function extent(r, ty, w, h, pts){
      var t = controls.target, sp = Math.sin(START_PHI), lo = 1e9, hi = -1e9, xlo = 1e9, xhi = -1e9;
      tmpCam.aspect = w / h; tmpCam.updateProjectionMatrix();
      tmpCam.position.set(t.x + r*sp*Math.sin(START_THETA), ty + r*Math.cos(START_PHI), t.z + r*sp*Math.cos(START_THETA));
      tmpCam.lookAt(t.x, ty, t.z); tmpCam.updateMatrixWorld();
      pts.forEach(function(p){ v.copy(p).project(tmpCam); var y = (1 - v.y) / 2 * h, x = (v.x + 1) / 2 * w; lo = Math.min(lo, y); hi = Math.max(hi, y); xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); });
      return [lo, hi, xlo, xhi];
    }
    function set(r, ty){
      var old = START_RADIUS;
      START_RADIUS = r; controls.target.y = ty;
      if (first){ controls.radius = controls.targetRadius = r; first = false; }
      else if (Math.abs(controls.targetRadius - old) < 0.01) controls.targetRadius = r;   // don't undo a manual zoom
    }
    function apply(){
      var w = window.innerWidth, h = window.innerHeight;
      var panel = document.getElementById("infoPanel"), tools = document.querySelector(".header-tools");
      if (!panel || !tools || w > 520) return set(DEF_R, DEF_Y);
      var top = tools.getBoundingClientRect().bottom + 10, bot = panel.getBoundingClientRect().top - 10;
      if (bot - top < 120) return set(DEF_R, DEF_Y);
      var pts = corners(), mid = (top + bot) / 2, r = DEF_R, ty = DEF_Y;
      for (; r <= controls.maxRadius; r += 0.5){
        var e;
        for (var i = 0; i < 4; i++){                         // re-centre the pyramid in the free band
          e = extent(r, ty, w, h, pts);
          ty -= ((e[0] + e[1]) / 2 - mid) / (h / (0.9326 * r));
        }
        e = extent(r, ty, w, h, pts);
        if (e[1] - e[0] <= bot - top && e[2] >= 14 && e[3] <= w - 14) break;   // aquatic fork: the broad top rim must fit the width too
      }
      set(Math.min(r, controls.maxRadius), ty);
    }
    window.addEventListener("resize", apply);
    window.addEventListener("load", apply);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply);
    if (window.ResizeObserver){
      var ro = new ResizeObserver(apply), a = document.getElementById("infoPanel"), b = document.querySelector(".header-tools");
      if (a) ro.observe(a); if (b) ro.observe(b);
    }
    apply();
  })();

  // ---- Show / hide the Energy · Heat · Biomass graph (folds away to the left) ----
  (function(){
    var btn = document.getElementById("ecoCollapseBtn"), panel = document.getElementById("infoPanel");
    if (!btn || !panel) return;
    btn.addEventListener("click", function(){
      var collapsed = panel.classList.toggle("graph-collapsed");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute("aria-label", collapsed ? "Show graph" : "Hide graph");
      btn.title = collapsed ? "Show graph" : "Hide graph";
    });
  })();

  // ---- Pond | Open sea switch -------------------------------------------------------------
  // Each habitat is built once, so switching reloads the page — but smoothly: the screen fades to
  // the water colour, the camera angle / zoom, selected level, graph variable and graph fold are
  // carried across, and the new scene fades in after its first frame. The Sun run, the 7-step flow
  // and simulated mortality start fresh (they belong to one habitat).
  (function(){
    var fade = document.getElementById("ecoFade"), msg = document.getElementById("ecoFadeMsg");
    var LABEL = { pond: "Pond \u00b7 upright biomass pyramid", sea: "Open sea \u00b7 inverted biomass pyramid" };
    var reduced = false;
    try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    var sub = document.getElementById("ecoSubtitle");
    if (sub) sub.textContent = IS_POND ? "Aquatic \u00b7 Pond \u00b7 Upright biomass pyramid"
                                       : "Aquatic \u00b7 Open sea \u00b7 Inverted biomass pyramid";
    var switching = false;
    function goTo(eco, extra){
      if (switching || eco === ECO_MODE || !LABEL[eco]) return false;
      var panel = document.getElementById("infoPanel");
      var carry = {
        to: eco, t: Date.now(),
        theta: controls.targetTheta, phi: controls.targetPhi, radius: controls.targetRadius,
        zoomed: Math.abs(controls.targetRadius - START_RADIUS) > 0.01,    // only a manual zoom is carried over
        level: selectedId, graphVar: ecoActiveVar,
        graphCollapsed: !!(panel && panel.classList.contains("graph-collapsed")),
        cardCollapsed: !!(prodReadoutEl && prodReadoutEl.classList.contains("collapsed"))
      };
      if (extra) Object.keys(extra).forEach(function(k){ carry[k] = extra[k]; });
      var stored = false;
      try { window.sessionStorage.setItem(ECO_SWITCH_KEY, JSON.stringify(carry)); stored = true; } catch (e) {}
      if (!stored && extra && extra.importJson) return false;           // can't carry the import: caller reports it
      switching = true;
      if (msg) msg.textContent = LABEL[eco];
      if (fade){ fade.classList.remove("instant"); void fade.offsetWidth; fade.classList.add("on"); }
      window.setTimeout(function(){
        try {
          window.location.replace(window.location.href.split("#")[0] + "#" + eco);
          window.location.reload();
        } catch (e) {
          switching = false;
          if (fade) fade.classList.remove("on");
        }
      }, reduced ? 0 : 340);
      return true;
    }
    ecoSwitchTo = goTo;
    var btns = document.querySelectorAll("#habitatSwitch .habitat-btn");
    Array.prototype.forEach.call(btns, function(btn){
      var eco = btn.getAttribute("data-eco");
      btn.setAttribute("aria-pressed", eco === ECO_MODE ? "true" : "false");
      btn.addEventListener("click", function(){ goTo(eco); });
    });

    // Arriving from a switch: restore the carried view, then fade the new scene in.
    if (ECO_PENDING){
      try { window.sessionStorage.removeItem(ECO_SWITCH_KEY); } catch (e) {}
      var c = ECO_PENDING;
      if (isFinite(c.theta)){ controls.theta = controls.targetTheta = c.theta; }
      if (isFinite(c.phi)){ controls.targetPhi = c.phi; controls.clampPhi(); controls.phi = controls.targetPhi; }
      if (c.zoomed && isFinite(c.radius)){ controls.targetRadius = c.radius; controls.clampRadius(); controls.radius = controls.targetRadius; }
      if (c.level === 1 || c.level === 2 || c.level === 3 || c.level === 4) selectLayer(c.level);
      if (c.graphVar) setEcoActiveVar(c.graphVar);
      if (c.cardCollapsed) setProdCollapsed(true);
      if (c.graphCollapsed){
        var cb = document.getElementById("ecoCollapseBtn"), pn = document.getElementById("infoPanel");
        if (cb && pn && !pn.classList.contains("graph-collapsed")) cb.click();
      }
      if (typeof c.importJson === "string"){
        try { importStateJson(c.importJson); if (DEV_MODE) console.log("State JSON imported after habitat switch"); }
        catch (e) { if (DEV_MODE) console.warn("State JSON import failed:", e.message); }
      }
    }
    if (fade){
      if (ECO_PENDING){
        requestAnimationFrame(function(){ requestAnimationFrame(function(){     // after the first rendered frame
          fade.classList.remove("instant"); void fade.offsetWidth; fade.classList.remove("on");
        }); });
      } else {
        fade.classList.remove("on", "instant");                              // e.g. a snapshot saved mid-switch
      }
    }
  })();

  requestAnimationFrame(animate);

})();
