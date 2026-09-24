# Explorer core (`src/worlds/explorer`)

Scale-free navigation for the seamless universe (Voyage phase 2). Pure logic except the two layers.

| File | What |
| --- | --- |
| `frames.ts` | The frame stack: `Frame` (origin in parent units, rotation child→parent, unit length, entry/exit radii), `convertPoint / convertDirection / rootQuatToFrame / distanceMetres`, `NavState` (position float64 in the deepest frame; attitude and velocity in ROOT axes), `settleFrame()` (hysteresis), `translateMetres()`. |
| `navigation.ts` | `autoSpeed(d, throttle)` (v = k·t²·d_nearest), the log-distance autopilot `Trip` (departure r_s = L₀(e^λ−1), arrival r_t = L₁(e^μ−1), blended across frames), `tripDistances / tripLogLength / tripDuration`, `lookQuat`, `niceScaleBar`. |
| `universe.ts` | Local Group geometry: M31 position/orientation (`M31`, `diskOrientation`), Virgo alignment (`VIRGO`, `boxToGalactic`), home halo choice (`chooseHome`), periodic wrap, halo → morphology (`morphologyForHalo`), `randomOrientation`. |
| `UniverseLayer.ts` | The z = 0 cosmic web (cosmicweb module's cached simulation + `WebRenderer`) in the root frame: wrapped around home, rotated to galactic axes, dark matter and galaxies faded independently, near fade radius. |
| `LayerFader.ts` | Cross-fades a layer without its own opacity through an off-screen HDR target (`'add'` for emissive layers, `'mix'` for layers that redraw the whole view). |

Units: root = Mpc (Local-Group-centred, Milky Way galactic axes: +x → Galactic centre, +y → NGP,
+z = −(l = 90°)); galaxies pc (y-up disk); the solar neighbourhood pc (heliocentric, galactic
axes = Starflight's frame); systems AU; planets km; Sgr A* r_g.

```ts
const root = new Frame({ id: 'u', kind: 'universe', label: 'Cosmic web', metres: UNIT.MPC });
const mw = new Frame({ id: 'mw', kind: 'galaxy', label: 'Milky Way', parent: root, unit: 1e-6, entry: 250e3, exit: 320e3 });
const nav = makeNav(mw);
settleFrame(nav, (f) => children.get(f) ?? []);           // after every move
const trip = new Trip({ frame: nav.frame, position: nav.position, scale: 6.4e6 },
                      { frame: m31, position: view, scale: 3e20 }, { lookAt: centre });
trip.step(dt, nav); settleFrame(nav, kids);
```

The experience that composes it all is `src/experiences/voyage` (regimes: `localSky.ts` Starflight's
real sky, `cosmos.ts` galaxies + web, `sol.ts` the Solar System, `systems.ts` procedural planets of
other stars, `sgra.ts` the central black hole, `nebula.ts` the Orion Nebula).
