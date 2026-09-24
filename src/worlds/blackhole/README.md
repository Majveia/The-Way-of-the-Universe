# Black hole renderer (`src/worlds/blackhole`)

Real-time general-relativistic rendering of a Kerr black hole with a thin accretion disk.
Units: G = c = M = 1 (lengths in r_g = GM/c², times in t_g = GM/c³). Spin along +Y in three.js.

| File | What |
| --- | --- |
| `kerr.ts` | Pure float64 physics: horizons, ISCO/photon orbits (BPT 1972), circular orbits, redshift, Page–Thorne flux, Kerr–Schild metric + Hamiltonian geodesics (RK4), observers & tetrads, CPU ray tracer, Bardeen shadow curve, shadow angular size, physical units. |
| `plunge.ts` | Free-fall ("rain") observer trajectory through the horizon. |
| `spectrum.ts` | CIE-integrated Planck tables (colour + absolute luminance) and colour→temperature inverse. |
| `shaders.ts` | GLSL: disk state texture, per-pixel geodesic trace (MRT), temporal accumulation, metering, composite (lensed cube-map sky + analytic lensed point stars). |
| `BlackHoleRenderer.ts` | The pass orchestration and public API. |

## API

```ts
const bh = new BlackHoleRenderer(renderer, { quality: 'high' });  // 'low' | 'medium' | 'high' | 'ultra'
bh.setEnvironment(cubeRenderTarget.texture);                        // sky seen through the lens
bh.setParams({ spin: 0.9, peakTemperature: 8000, doppler: true, time });   // Partial<BlackHoleParams>
bh.setObserverVelocity(u | null);                                   // Kerr–Schild 4-velocity (e.g. a plunge)
bh.render(hdrTarget, camera, camPosInRg);                           // full-screen linear HDR
bh.meter(); bh.highlightLuminance;                                  // async auto-exposure metering
bh.pick(ndcX, ndcY);                                                // CPU float64 trace of one pixel
bh.camera;                                                          // last frame's KS position, r, u, tetrad
bh.dispose();
```

`camPosInRg` is the camera position in the black hole's frame (r_g, spin +Y); `camera.quaternion`
is interpreted in the same frame after `params.orientation` (rotate the hole inside a larger scene).
